import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelCatalog } from '../benchmarking/model-catalog/service.mjs';
import { CatalogSupervisor } from '../benchmarking/model-catalog/supervisor.mjs';
import { immutable } from '../benchmarking/kimi-v2/policy.mjs';
import { inspectCodeSandbox } from '../benchmarking/code/sandbox.mjs';
const root = process.cwd();
const examples = [
  { id: 'k3', provider: 'kimi-code', efforts: ['low','high','max'], default_effort: 'high', context_limit: 1048576 },
  { id: 'claude-opus-5-5-high', provider: 'antigravity', efforts: ['high'], default_effort: 'high' },
  { id: 'claude-opus-4-8', provider: 'claude-code', efforts: ['high','max'], default_effort: 'high', speed_options: ['standard','fast'] }
];
const catalog = new ModelCatalog({ cacheFile: null, sources: Object.fromEntries(examples.map(m => [m.provider, async () => [m]])) });
async function mcp(file, directory) {
  const child = spawn(process.execPath, [file], { cwd: root, env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory, MAZEBENCH_PYTHON_ENABLED:'0', MAZEBENCH_CAPABILITY_POLICY:'os-isolated-v4' }, stdio:['pipe','pipe','pipe'] });
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n');
  const code=await new Promise((r,j)=>{child.on('close',r);child.on('error',j)});clearTimeout(timer);
  assert.equal(code,0,errors);return JSON.parse(output.trim().split('\n')[0]).result.tools.map(t=>t.name);
}
test('new catalog runtimes sign the chosen model/speed and expose only their intended MCP tools', {skip:process.platform!=='darwin',timeout:120000}, async t => {
  const temporary=await mkdtemp(path.join(os.tmpdir(),'catalog-launch-'));const frozen=[];
  t.after(async()=>{for(const f of frozen)for(const name of Object.keys(f.kimi_config||{})){const file=path.join(f.kimi_home,name);if(existsSync(file))immutable(file,false);}for(const f of frozen)for(const file of Object.keys(f.antigravity_config||{}))if(existsSync(file))immutable(file,false);await rm(temporary,{recursive:true,force:true});});
  const auth=path.join(temporary,'auth');await mkdir(path.join(auth,'.gemini/antigravity-cli'),{recursive:true});
  await writeFile(path.join(auth,'credential.json'),JSON.stringify({base_url:'https://api.kimi.com/coding/v1',api_key:'offline-fixture'}));
  const {tokenPath}=await import('../benchmarking/antigravity-v2/policy.mjs');await mkdir(path.dirname(tokenPath(auth)),{recursive:true});await writeFile(tokenPath(auth),'{}');
  const status=p=>async()=>({available:true,tested:true,authenticated:true,launch_ready:true,models:examples.filter(m=>m.provider===p)});
  const s=new CatalogSupervisor(root,{catalog,recordsRoot:path.join(temporary,'records'),ownerRoot:path.join(temporary,'owners'),kimiStateRoot:path.join(temporary,'kimi'),kimiAuthHome:auth,antigravityStateRoot:path.join(temporary,'agy'),antigravityAuthHome:auth,kimiStatus:status('kimi-code'),antigravityStatus:status('antigravity')});
  for(const runtime of Object.values(s.runtimes))for(const method of ['startKimi','startAntigravity','startClaude','startCode','startIce','startSlotski'])runtime[method]=()=>{};
  const modes=(await inspectCodeSandbox()).available?['off','any']:['off'];
  for(const model of examples)for(const mode of modes)for(const world of model.provider==='claude-code'?['main-world','ice-maze','slotski']:['main-world']) {
    const spec={provider:model.provider,model:model.id,effort:model.default_effort,coding_mode:mode,world,service_tier:model.provider==='claude-code'?'fast':'standard',action_limit:2};
    const run=await s.launch(spec),directory=s.runDirectory(run.id);assert(s.owns(directory));
    const manifest=JSON.parse(await readFile(path.join(directory,'integrity.json'))).configuration;frozen.push(manifest);
    const runtime=await s.forRun(run.id);await runtime.verifyRunCapabilityBoundary(JSON.parse(await readFile(path.join(directory,'run.json'))),directory);
    assert.equal(manifest.model,model.id);assert.equal(manifest.service_tier,model.provider==='claude-code'?'fast':null);
    const folder=model.provider==='kimi-code'?(mode==='any'?'kimi-code-v3':'kimi-v2'):model.provider==='antigravity'?(mode==='any'?'antigravity-code-v3':'antigravity-v2'):mode==='any'?'code-v2':world==='ice-maze'?'worlds-v2':world==='slotski'?'slotski-v2':'providers-v2';
    const file=`benchmarking/${folder}/${['kimi-code','antigravity'].includes(model.provider)?'mcp.mjs':folder==='providers-v2'?'claude-mcp.mjs':'mcp-server.mjs'}`;
    const names=await mcp(file,directory);assert(names.includes('maze_observe'));assert.equal(names.includes('code_exec'),mode==='any');assert(!names.includes('python_exec'));
  }
});
