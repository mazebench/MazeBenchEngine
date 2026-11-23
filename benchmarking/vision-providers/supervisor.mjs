import {randomBytes} from 'node:crypto';
import {existsSync, realpathSync} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile,chmod,readdir} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {BenchmarkSupervisor as BaseSupervisor} from '../kimi/supervisor.mjs';
import {BenchmarkSupervisor as CoreSupervisor} from '../v1/supervisor.mjs';
import {createRunIntegrity} from '../v1/integrity.mjs';
import {atomicJson,readJson} from '../providers/claude-runner.mjs';
import {LIVE_WORLD_POLICY} from '../storage/live-world.mjs';
import {VisionRuntime} from '../vision/runtime.mjs';
import {VisionRenderer} from './renderer.mjs';
import {agentDefinition,settings,tokenPath,digest,immutable,inspectInstallation} from '../antigravity/policy.mjs';
import {grokConfig} from '../grok/supervisor.mjs';
import {grokInstallationStatus,grokModelsPolicyDigest,grokSettingsPolicyDigest} from '../grok/policy.mjs';
import {runGrokTurn} from '../grok/runner.mjs';
import {runAntigravityTurn} from './gemini-runner.mjs';
import {POLICY,PROVIDERS,providerVisionHashes,verifyProviderVisionIntegrity} from './policy.mjs';
import {safeReadFile} from '../v1/safe-files.mjs';
import * as kimi from '../kimi/policy.mjs';
import * as muse from '../muse/policy.mjs';
import {runKimiTurn} from '../kimi/runner.mjs';
import {runMuseTurn} from '../muse/runner.mjs';
const now=()=>new Date().toISOString();
const providerPrefix=provider=>({'antigravity':'antigravity','grok-build':'grok','kimi-code':'kimi','muse-code':'muse'})[provider];
const sessionKey=provider=>providerPrefix(provider)+'_session_id';
const terminal=summary=>['won','action-limit'].includes(summary.game_status);
const continuation=count=>`Continue the same vision run at action ${count}. Call maze_observe and inspect its image, then keep playing until won or action-limit. Coding tools remain off. Do not stop merely because a turn ended.`;
export class ProviderVisionSupervisor extends BaseSupervisor {
  constructor(root,options={}) {super(root,{...options,recordsRoot:options.recordsRoot||path.join(os.homedir(),'records/mazebench-vision')});}
  owns(id) {
    try{return JSON.parse(safeReadFile(this.runDirectory(id),'run.json')).capability_policy?.name===POLICY;}catch{return false;}
  }
  async validateSpec(spec={}) {
    if(!PROVIDERS.includes(spec.provider))throw new Error('Unsupported vision provider.');
    if(spec.observation_mode!=='vision'||(spec.world&&spec.world!=='main-world'))throw new Error('This harness requires Main World vision observations.');
    if(spec.tools_enabled||(spec.coding_mode&&spec.coding_mode!=='off'))throw new Error('This vision harness requires coding off.');
    // Reuse exact model and effort validation; the new harness owns image delivery.
    return {...await super.validateSpec({...spec,observation_mode:'ascii',tools_enabled:false}),observationMode:'vision'};
  }
  async createProfile(id,directory,options) {
    const provider=options.provider;
    const mcp=path.join(this.projectRoot,'benchmarking/vision-providers/mcp-server.mjs');
    const env={MAZEBENCH_PROJECT_ROOT:this.projectRoot,MAZEBENCH_RUN_DIRECTORY:directory,MAZEBENCH_CAPABILITY_POLICY:'os-isolated-v4',MAZEBENCH_PYTHON_ENABLED:'0'};
    if(provider==='kimi-code'){
      const home=path.join(this.kimiStateRoot,id);await mkdir(path.join(home,'skills'),{recursive:true,mode:0o700});
      const config=kimi.settings({...options,toolsEnabled:false,baseUrl:kimi.credential(this.kimiAuthHome).base_url}).replace('"tool_use"]','"tool_use", "image_in"]');
      const files={'config.toml':config,'mcp.json':JSON.stringify({mcpServers:{mazebench:{command:process.execPath,args:[mcp],env,enabledTools:kimi.toolNames(false),deferred:false,toolTimeoutMs:120000}}})};
      for(const [name,bytes]of Object.entries(files)){const file=path.join(home,name);await writeFile(file,bytes,{flag:'wx',mode:0o400});immutable(file);}
      return {kimi_home:home,immutable_config:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[path.join(home,name),digest(bytes)]))};
    }
    if(provider==='muse-code'){
      const home=path.join(this.museStateRoot,id),file=path.join(home,'.config/muse/settings.json');await mkdir(path.dirname(file),{recursive:true,mode:0o700});await mkdir(path.join(home,'.local/share'),{recursive:true,mode:0o700});
      await copyFile(muse.tokenPath(this.museAuthHome),muse.tokenPath(home));await chmod(muse.tokenPath(home),0o600);
      const bytes=JSON.stringify(muse.settings({command:process.execPath,args:[mcp],env,toolsEnabled:false}));await writeFile(file,bytes,{flag:'wx',mode:0o400});immutable(file);
      return {muse_home:home,immutable_config:{[file]:digest(bytes)}};
    }
    if(provider==='grok-build') {
      const home=path.join(this.grokStateRoot,id);await mkdir(home,{recursive:true,mode:0o700});
      const config=grokConfig({projectRoot:this.projectRoot,runDirectory:directory,grokHome:home}).replace(path.join(this.projectRoot,'benchmarking/grok/mcp.mjs'),mcp)
        .replace('MAZEBENCH_RUN_DIRECTORY = '+JSON.stringify(directory),'MAZEBENCH_RUN_DIRECTORY = '+JSON.stringify(directory)+', MAZEBENCH_CAPABILITY_POLICY = "os-isolated-v4", MAZEBENCH_PYTHON_ENABLED = "0"');
      const file=path.join(home,'config.toml');await writeFile(file,config,{flag:'wx',mode:0o400});immutable(file);
      for(const name of ['auth.json','models_cache.json','settings_cache.json']){await copyFile(path.join(this.grokAuthHome,name),path.join(home,name));await chmod(path.join(home,name),0o600);}
      return {grok_home:home,immutable_config:{[file]:digest(config)},grok_models_policy_sha256:grokModelsPolicyDigest(await readFile(path.join(home,'models_cache.json'))),grok_settings_policy_sha256:grokSettingsPolicyDigest(await readFile(path.join(home,'settings_cache.json')))};
    }
    const home=path.join(this.antigravityStateRoot,id),images=path.join(directory,'vision-images');
    await mkdir(path.join(home,'.gemini/antigravity-cli'),{recursive:true,mode:0o700});await mkdir(images,{mode:0o700});
    await copyFile(tokenPath(this.antigravityAuthHome),tokenPath(home));await chmod(tokenPath(home),0o600);
    const cwd=path.join(directory,'agent-cwd'),agent=path.join(cwd,'.agents/agents/mazebench/agent.md');await mkdir(path.dirname(agent),{recursive:true,mode:0o700});
    const definition=agentDefinition({command:process.execPath,args:[mcp],toolsEnabled:false,env:{MAZEBENCH_PROJECT_ROOT:this.projectRoot,MAZEBENCH_RUN_DIRECTORY:directory,MAZEBENCH_CAPABILITY_POLICY:'os-isolated-v4',MAZEBENCH_PYTHON_ENABLED:'0'}})
      .replace('tools: []','tools: [view_file]')
      .replace('Native shell, JavaScript, file tools, web, skills, plugins, personal instructions and delegation are unavailable.', 'The only native tool is view_file, restricted to authenticated observation PNGs. All other native tools, code execution, arbitrary file reads, web, skills, plugins and delegation are unavailable.')
      +'\nThis is a VISION benchmark. Every observation returns image_file. Call view_file with AbsolutePath=image_file to see the PNG before choosing actions. Only PNG files in the observation image directory are readable; no source files, private state, or other files are accessible.\n';
    const config=settings(false);config.permissions.allow.push('read_file('+realpathSync(images)+')');
    config.permissions.deny=config.permissions.deny.filter(rule=>rule!=='read_file(*)');
    config.permissions.deny.push('read_file('+realpathSync(cwd)+')','read_file('+realpathSync(home)+')');
    const files={[agent]:definition,[path.join(home,'.gemini/antigravity-cli/settings.json')]:JSON.stringify(config)};
    for(const [file,bytes] of Object.entries(files)){await writeFile(file,bytes,{flag:'wx',mode:0o400});immutable(file);}
    return {antigravity_home:home,image_directory:realpathSync(images),immutable_config:Object.fromEntries(Object.entries(files).map(([f,b])=>[f,digest(b)]))};
  }
  async launch(spec={}) {
    const options=await this.validateSpec(spec);await this.initialize();
    const agy=options.provider==='antigravity',prefix=providerPrefix(options.provider);
    const installation=prefix==='kimi'?kimi.inspectInstallation(this.kimiBin):prefix==='muse'?muse.inspectInstallation(this.museBin):agy?inspectInstallation(this.antigravityBin):grokInstallationStatus(this.grokBin);
    const readiness=prefix==='kimi'?await this.inspectKimi({force:true}):prefix==='muse'?await this.inspectMuse({force:true}):agy?await this.inspectAntigravity({force:true}):installation;
    if(!installation.tested||!readiness.authenticated||(prefix==='grok'?!readiness.model_available:!readiness.launch_ready))throw new Error(readiness.error||'Provider is not ready.');
    if(prefix==='kimi')options.contextLimit=readiness.models.find(model=>model.id===options.model)?.context_limit;
    const at=now(),id='run-'+at.replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'),directory=this.runDirectory(id);
    for(const folder of ['agent-cwd','sandbox-state'])await mkdir(path.join(directory,folder),{recursive:true,mode:0o700});
    const profile=await this.createProfile(id,directory,options);
    const base=await readFile(path.join(this.projectRoot,'benchmarking/vision/EVAL-PROMPT.md'),'utf8');
    const prompt=base+`\nAction budget: ${options.actionLimit??'unlimited'} accepted actions.\nCoding tools are disabled. No Python, shell, or writable workspace is available.\n`+(agy?'Observations provide image_file; call view_file on that exact PNG to see the room before choosing moves. This viewer can only read the observation PNGs.\n':'Images are delivered directly in MazeBench MCP results.\n')+'Call maze_observe now.';
    const metadata={storage_format:'incremental-v1',world_updates:LIVE_WORLD_POLICY,schema_version:1,id,world:'main-world',observation_mode:'vision',provider:options.provider,created_at:at,updated_at:at,status:'preparing',model:options.model,effort:options.effort,tools_enabled:false,coding_mode:'off',action_limit:options.actionLimit,start_room:options.startRoom,service_tier:null,service_tier_history:[{at,service_tier:'standard',source:'Initial run configuration'}],prompt_sha256:digest(base),effective_prompt_sha256:digest(prompt),[sessionKey(options.provider)]:null,continuation_count:0,error:null,completed_at:null,stopped_at:null,isolation:{mode:'no-python'},capability_policy:{version:4,name:POLICY,tools:'maze-only',image_delivery:agy?'restricted-image-viewer':'mcp-image'}};
    const configuration={...Object.fromEntries(['storage_format','world_updates','world','observation_mode','provider','model','effort','tools_enabled','coding_mode','action_limit','start_room','service_tier','effective_prompt_sha256','capability_policy'].map(k=>[k,metadata[k]])),vision_provider_policy:POLICY,vision_provider_runtime:await providerVisionHashes(this.projectRoot),...profile,[prefix+'_executable']:installation.executable,[prefix+'_version']:installation.version,[prefix+'_sha256']:digest(await readFile(installation.executable))};
    metadata.integrity=await createRunIntegrity(this.projectRoot,directory,configuration);
    await writeFile(path.join(directory,'prompt.md'),prompt,{mode:0o600});await atomicJson(path.join(directory,'run.json'),metadata);
    try {
      const runtime=await VisionRuntime.create(this.projectRoot,directory,{startRoom:options.startRoom,incremental:true,actionLimit:options.actionLimit}),renderer=new VisionRenderer(this.projectRoot);
      try {const {frame}=await runtime.readRecord('current_board.png'),png=await renderer.render(frame);metadata.vision_preflight={verified:true,width:1024,height:1024,png_sha256:digest(png)};}finally{await renderer.close();}
      await this.verifyRunCapabilityBoundary(metadata,directory);metadata.status='queued';await atomicJson(path.join(directory,'run.json'),metadata);this.start(id,directory,prompt);
    }catch(error){metadata.status='failed';metadata.error=error.message;metadata.completed_at=now();await atomicJson(path.join(directory,'run.json'),metadata);throw error;}
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata,directory){return (await verifyProviderVisionIntegrity(this.projectRoot,directory,metadata)).configuration;}
  start(id,directory,prompt){const control={child:null,stopRequested:false,pauseRequested:false,threadId:null};this.active.set(id,control);this.loop(directory,prompt,control).catch(async error=>{const m=await readJson(path.join(directory,'run.json'));Object.assign(m,{status:'failed',error:error.message,completed_at:now()});await atomicJson(path.join(directory,'run.json'),m);}).finally(()=>this.active.delete(id));}
  async loop(directory,prompt,control){
    const file=path.join(directory,'run.json');
    while(!control.stopRequested&&!control.pauseRequested){
      let m=await readJson(file),frozen=await this.verifyRunCapabilityBoundary(m,directory);const key=sessionKey(m.provider);
      m.status=m[key]?'continuing':'running';m.updated_at=now();await atomicJson(file,m);
      const before=(await readJson(path.join(directory,'summary.json'))).action_count;
      const runner={'antigravity':runAntigravityTurn,'grok-build':runGrokTurn,'kimi-code':runKimiTurn,'muse-code':runMuseTurn}[m.provider];
      const turn=await runner({directory,metadata:m,frozen,prompt,control,onSession:async id=>{const latest=await readJson(file);latest[key]=id;await atomicJson(file,latest);}});
      m=await readJson(file);if(turn.boundaryError)throw new Error(turn.boundaryError);
      await this.verifyRunCapabilityBoundary(m,directory);
      if(control.stopRequested||control.pauseRequested)break;
      if(turn.code!==0||(m.provider==='grok-build'?!turn.result||turn.result.is_error:turn.result?.status!=='SUCCESS'))throw new Error(turn.error||'Vision agent turn failed.');
      const summary=await readJson(path.join(directory,'summary.json'));if(turn.usage)m.usage=turn.usage;
      if(terminal(summary)){m.status='completed';m.completed_at=now();await atomicJson(file,m);return;}
      if(!m[key])throw new Error('No resumable vision session was recorded.');
      m.continuation_count++;m.last_turn_actions=summary.action_count-before;await atomicJson(file,m);prompt=continuation(summary.action_count);
    }
    const m=await readJson(file);Object.assign(m,{status:control.pauseRequested?'paused':'stopped',updated_at:now(),[control.pauseRequested?'paused_at':'stopped_at']:now()});await atomicJson(file,m);
  }
  async resume(id){const directory=this.runDirectory(id),file=path.join(directory,'run.json'),m=await readJson(file);if(this.active.has(id)||!['paused','stopped','failed'].includes(m.status))throw new Error('This run cannot be resumed.');await this.verifyRunCapabilityBoundary(m,directory);const summary=await readJson(path.join(directory,'summary.json'));if(terminal(summary))throw new Error('Run is complete.');Object.assign(m,{status:'queued',error:null,completed_at:null,stopped_at:null,paused_at:null,resumed_at:now()});await atomicJson(file,m);this.start(id,directory,m[sessionKey(m.provider)]?continuation(summary.action_count):await readFile(path.join(directory,'prompt.md'),'utf8'));return this.get(id);}
  async get(id,options){const run=await CoreSupervisor.prototype.get.call(this,id,options);run.capability_boundary_verified=run.capability_policy?.name===POLICY&&!existsSync(path.join(this.runDirectory(id),'integrity-violation.json'));run.compaction_recoverable=run.capability_boundary_verified&&run.status==='failed';return run;}
  async list(){await this.initialize();const entries=await readdir(this.recordsRoot,{withFileTypes:true});return Promise.all(entries.filter(e=>e.isDirectory()&&/^run-/.test(e.name)&&this.owns(e.name)).map(e=>this.get(e.name,{details:false})));}
  async listInterviews(id){return {run_id:id,available:false,chats:[],reason:'Review the recorded vision observations.'};}
}
