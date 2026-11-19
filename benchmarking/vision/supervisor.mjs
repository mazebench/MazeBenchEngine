import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor as ProviderSupervisor } from '../providers/supervisor.mjs';
import { BenchmarkSupervisor as CodexSupervisor, writeDirectToolModelCatalog } from '../v1/supervisor.mjs';
import { safeReadFile } from '../v1/safe-files.mjs';
import { createRunIntegrity } from '../v1/integrity.mjs';
import { claudeInstallationStatus, CLAUDE_POLICY, digest, providerRuntimeHashes } from '../providers/claude-policy.mjs';
import { atomicJson, readJson } from '../providers/claude-runner.mjs';
import { VisionRuntime } from './runtime.mjs';
import { VisionRenderer } from './renderer.mjs';
import { visionRuntimeHashes, verifyVisionIntegrity } from './policy.mjs';
import { runVisionCodexTurn } from './codex-runner.mjs';
import { runClaudeTurn } from './claude-runner.mjs';
import { latestCodexForLaunch, admitCodexInstallation } from '../codex-latest.mjs';
const now=()=>new Date().toISOString();
const terminal=s=>['won','action-limit'].includes(s);
const continuation=count=>`Continue the same MazeBench vision run at action ${count}. Call maze_observe to see the current room, then keep playing until won or action-limit. Images and animation frame records are available through maze_observe. Do not stop because you believe the puzzle is impossible.`;
export class VisionSupervisor extends ProviderSupervisor {
  constructor(root,options={}){super(root,{...options,recordsRoot:options.recordsRoot||process.env.MAZEBENCH_VISION_RECORDS_ROOT||path.join(os.homedir(),'records','mazebench-vision')});this.launchOptions=options;}
  async validateSpec(spec={}){
    if((spec.world&&spec.world!=='main-world')||(spec.observation_mode&&spec.observation_mode!=='vision'))throw new Error('Vision mode currently supports the MazeBench main world.');
    const options=await super.validateSpec(spec);
    if(options.provider==='claude-code'&&options.serviceTier==='fast')throw new Error('Fast mode is available for Codex runs only.');
    return options;
  }
  async launch(spec={}){
    if((spec.provider||'codex')==='codex'&&this.launchOptions.catalog&&!this.launchOptions.codexSelected){
      const installed=await latestCodexForLaunch(this.projectRoot);
      const owner=new VisionSupervisor(this.projectRoot,{...this.launchOptions,codexBin:installed.executable,codexSelected:true});
      owner.active=this.active;owner.runDirectory=id=>this.runDirectory(id);owner.models=()=>this.models();
      return owner.launch(spec);
    }
    const options=await this.validateSpec(spec);await this.initialize();
    let capability,installation;
    if(options.provider==='codex')capability=this.codexCapabilityPolicy();
    else{installation=claudeInstallationStatus(this.claudeBin);if(!installation.available||!installation.tested||!installation.authenticated)throw new Error(installation.error||'Claude Code is unavailable.');}
    const at=now(),id=`run-${at.replace(/[:.]/g,'-')}-${randomBytes(3).toString('hex')}`,directory=this.runDirectory(id);
    for(const name of ['agent-cwd','sandbox-state'])await mkdir(path.join(directory,name),{recursive:true,mode:0o700});
    if(capability)capability.model_catalog=await writeDirectToolModelCatalog(directory,options.model);
    const base=await readFile(path.join(this.projectRoot,'benchmarking/vision/EVAL-PROMPT.md'),'utf8');
    const prompt=base+`\nAction budget: ${options.actionLimit??'unlimited'} accepted actions.\n`+(options.toolsEnabled
      ?'Python is enabled through python_exec only. Save relative .py files in isolated /workspace. No network, subprocesses, host files, repository, records, private state or prior runs are accessible. Transfer observations into code yourself.\n'
      :'Python is disabled. There are no code executors or writable files.\n')+'Call maze_observe now.';
    const meta={storage_format:'incremental-v1',world_updates:LIVE_WORLD_POLICY,schema_version:1,id,world:'main-world',observation_mode:'vision',provider:options.provider,pair_id:options.pairId,created_at:at,updated_at:at,status:'preparing',model:options.model,effort:options.effort,
      tools_enabled:options.toolsEnabled,action_limit:options.actionLimit,start_room:options.startRoom,service_tier:options.serviceTier,service_tier_history:[{at,service_tier:options.serviceTier||'standard',source:'Initial run configuration'}],
      prompt_sha256:digest(base),effective_prompt_sha256:digest(prompt),codex_thread_id:null,claude_session_id:null,continuation_count:0,error:null,completed_at:null,stopped_at:null,
      capability_policy:capability||{version:4,name:CLAUDE_POLICY,claude_version:installation.version},isolation:{mode:'no-python'}};
    const configuration={storage_format:'incremental-v1',world_updates:LIVE_WORLD_POLICY,world:meta.world,observation_mode:'vision',provider:meta.provider,model:meta.model,effort:meta.effort,tools_enabled:meta.tools_enabled,service_tier:meta.service_tier,
      action_limit:meta.action_limit,start_room:meta.start_room,effective_prompt_sha256:meta.effective_prompt_sha256,vision_runtime:await visionRuntimeHashes(this.projectRoot),
      ...(capability?{codex_policy:capability}:{claude_policy:CLAUDE_POLICY,claude_executable:installation.executable,claude_version:installation.version,claude_sha256:digest(await readFile(installation.executable)),provider_runtime:await providerRuntimeHashes(this.projectRoot)})};
    meta.integrity=await createRunIntegrity(this.projectRoot,directory,configuration);
    await writeFile(path.join(directory,'prompt.md'),prompt,{mode:0o600});await atomicJson(path.join(directory,'run.json'),meta);
    try{
      const runtime=await VisionRuntime.create(this.projectRoot,directory,{startRoom:options.startRoom,incremental:true,actionLimit:options.actionLimit});
      const renderer=new VisionRenderer(this.projectRoot);
      try{const {frame}=await runtime.readRecord('current_board.png');const png=await renderer.render(frame);meta.vision_preflight={verified:true,width:1024,height:1024,png_sha256:digest(png)};}
      finally{await renderer.close();}
      if(options.toolsEnabled){meta.isolation=this.pythonPreflight(directory);await atomicJson(path.join(directory,'sandbox-preflight.json'),meta.isolation);}
      await this.verifyRunCapabilityBoundary(meta,directory);
      meta.status='queued';await atomicJson(path.join(directory,'run.json'),meta);this.startVision(id,directory,prompt);
    }catch(error){meta.status='failed';meta.error=error.message;meta.completed_at=now();await atomicJson(path.join(directory,'run.json'),meta);throw error;}
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(meta,directory){
    const manifest=await verifyVisionIntegrity(this.projectRoot,directory,meta);
    if(meta.provider==='codex'){
      const owner=Object.create(this);owner.codexBin=meta.capability_policy.codex_executable;
      admitCodexInstallation(owner.codexBin);
      return CodexSupervisor.prototype.verifyRunCapabilityBoundary.call(owner,meta,directory);
    }
    if(meta.tools_enabled)this.pythonPreflight(directory);return manifest.configuration;
  }
  startVision(id,directory,prompt){
    const control={child:null,stopRequested:false,pauseRequested:false,threadId:null};this.active.set(id,control);
    this.visionLoop(directory,prompt,control).catch(async error=>{const m=await readJson(path.join(directory,'run.json'));m.status='failed';m.error=error.message;m.completed_at=now();await atomicJson(path.join(directory,'run.json'),m);}).finally(()=>this.active.delete(id));
  }
  async visionLoop(directory,prompt,control){
    const file=path.join(directory,'run.json');
    while(!control.stopRequested&&!control.pauseRequested){
      let m=await readJson(file);const boundary=await this.verifyRunCapabilityBoundary(m,directory);
      m.status=m.codex_thread_id||m.claude_session_id?'continuing':'running';m.updated_at=now();await atomicJson(file,m);
      const before=(await readJson(path.join(directory,'summary.json'))).action_count;
      const claude=m.provider==='claude-code';
      const turn=claude?await runClaudeTurn({projectRoot:this.projectRoot,directory,metadata:m,frozen:boundary,prompt,control,onSession:async id=>{const current=await readJson(file);current.claude_session_id=id;await atomicJson(file,current);}})
        :await runVisionCodexTurn.call(this,{metadata:m,directory,agentDirectory:path.join(directory,'agent-cwd'),prompt,resumeThreadId:m.codex_thread_id,control});
      m=await readJson(file);if(turn.boundaryError)throw new Error(turn.boundaryError);await verifyVisionIntegrity(this.projectRoot,directory,m);
      if(control.stopRequested||control.pauseRequested)break;
      if(turn.code!==0||(claude&&(!turn.result||turn.result.is_error))||turn.reportedError)throw new Error(turn.error||turn.reportedError||turn.stderrTail||'Agent turn failed.');
      const summary=await readJson(path.join(directory,'summary.json'));if(turn.usage)m.usage=turn.usage;
      if(terminal(summary.game_status)){m.status='completed';m.completed_at=now();await atomicJson(file,m);return;}
      if(!(claude?m.claude_session_id:m.codex_thread_id))throw new Error('No resumable agent session was recorded.');
      m.continuation_count++;m.last_turn_actions=summary.action_count-before;await atomicJson(file,m);prompt=continuation(summary.action_count);
    }
    const m=await readJson(file);m.status=control.pauseRequested?'paused':'stopped';m.updated_at=now();m[control.pauseRequested?'paused_at':'stopped_at']=now();await atomicJson(file,m);
  }
  async resume(id){
    const directory=this.runDirectory(id),file=path.join(directory,'run.json'),m=await readJson(file);
    if(this.active.has(id)||!['paused','stopped','failed'].includes(m.status))throw new Error('This vision run cannot be resumed.');
    await this.verifyRunCapabilityBoundary(m,directory);const s=await readJson(path.join(directory,'summary.json'));if(terminal(s.game_status))throw new Error('Run has reached its terminal state.');
    if(!(m.codex_thread_id||m.claude_session_id))throw new Error('No resumable session.');
    Object.assign(m,{status:'queued',error:null,completed_at:null,stopped_at:null,paused_at:null,resumed_at:now()});await atomicJson(file,m);this.startVision(id,directory,continuation(s.action_count));return this.get(id);
  }
  async listInterviews(id){return{run_id:id,available:false,chats:[],reason:'Vision runs use image records for review.'};}
  async createInterview(){throw new Error('Interviews are unavailable for vision runs.');}
  async displayFrame(id,index){const directory=this.runDirectory(id),runtime=await VisionRuntime.open(this.projectRoot,directory);await runtime.readRecord(`move_history/move_${index}/index.json`);return JSON.parse(safeReadDisplay(directory,index));}
}
function safeReadDisplay(directory,index){return safeReadFile(directory,`display-history/move_${index}.json`);}
