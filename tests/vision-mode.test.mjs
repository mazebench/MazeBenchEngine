import '../benchmarking/codex-releases.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { VisionRuntime } from '../benchmarking/vision/runtime.mjs';
import { VisionSupervisor } from '../benchmarking/vision/supervisor.mjs';
import { verifyVisionIntegrity, buildVisionCodexArguments, buildVisionClaudeArguments } from '../benchmarking/vision/policy.mjs';
import { verifyCheckpoint } from '../benchmarking/v1/integrity.mjs';
import { trustedVisionRequest } from '../benchmarking/vision/server.mjs';
const root=path.resolve(import.meta.dirname,'..');
const data=result=>result.structuredContent??JSON.parse(result.content.find(c=>c.type==='text').text);
const noBoardData=value=>assert.doesNotMatch(JSON.stringify(value),/"(?:level|colored_level|ascii_legend|objects|player|localX|worldX|state_hash|stateHash|visionFrames|source_sha256)"/);
function client(directory,toolsEnabled){
  const child=spawn(process.execPath,[path.join(root,'benchmarking/vision/mcp-server.mjs')],{cwd:path.join(directory,'agent-cwd'),env:{PATH:process.env.PATH,MAZEBENCH_PROJECT_ROOT:root,MAZEBENCH_RUN_DIRECTORY:directory,MAZEBENCH_PYTHON_ENABLED:toolsEnabled?'1':'0',MAZEBENCH_CAPABILITY_POLICY:'os-isolated-v4'},stdio:['pipe','pipe','pipe']});
  let id=0,stderr='';const pending=new Map();child.stderr.on('data',b=>stderr+=b.toString());
  readline.createInterface({input:child.stdout}).on('line',l=>{const value=JSON.parse(l);const p=pending.get(value.id);if(p){clearTimeout(p.timer);pending.delete(value.id);p.resolve(value);}});
  child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(stderr||'MCP exited.'));}pending.clear();});
  const request=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timed out: '+stderr));},30000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  return{request,tool:async(name,args={})=>(await request('tools/call',{name,arguments:args})).result,async close(){child.stdin.end();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},5000).unref();});}};
}
test('vision serves native image content and image history, with no ASCII or private board data in either Python condition',async()=>{
  const recordsRoot=await mkdtemp(path.join(os.tmpdir(),'mazebench-vision-test-'));
  const supervisor=new VisionSupervisor(root,{recordsRoot});supervisor.startVision=()=>{};
  try{
    for(const toolsEnabled of [false,true]){
      const run=await supervisor.launch({world:'main-world',observation_mode:'vision',provider:'codex',model:'gpt-6-astra',effort:'max',service_tier:'fast',tools_enabled:toolsEnabled,action_limit:20});
      const directory=supervisor.runDirectory(run.id),metadata=JSON.parse(await readFile(path.join(directory,'run.json')));
      assert.equal(metadata.vision_preflight.verified,true);assert.equal(metadata.observation_mode,'vision');assert.equal(metadata.tools_enabled,toolsEnabled);assert.equal(metadata.service_tier,'fast');
      await assert.rejects(()=>verifyVisionIntegrity(root,directory,{...metadata,observation_mode:'ascii'}),/mode/);
      const options={projectRoot:root,runDirectory:directory,agentDirectory:path.join(directory,'agent-cwd'),model:metadata.model,effort:metadata.effort,toolsEnabled,serviceTier:'fast',disabledFeatures:metadata.capability_policy.disabled_features,modelCatalogPath:path.join(directory,metadata.capability_policy.model_catalog.file),prompt:'fixture'};
      assert(buildVisionCodexArguments(options).some(arg=>arg.includes('benchmarking/vision/mcp-server.mjs')));
      assert(buildVisionClaudeArguments({...options,model:'claude-fable-5-1'}).some(arg=>arg.includes('benchmarking/vision/mcp-server.mjs')));
      const mcp=client(directory,toolsEnabled);
      try{
        await mcp.request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});
        const tools=(await mcp.request('tools/list')).result.tools;
        assert.deepEqual(tools.map(t=>t.name),['maze_observe','maze_action','maze_sequence',...(toolsEnabled?['python_exec']:[])]);
        assert.deepEqual((await mcp.request('resources/list')).result,{resources:[]});
        const initial=await mcp.tool('maze_observe');assert.equal(initial.isError,false);noBoardData(data(initial));
        const img=initial.content.find(c=>c.type==='image');assert.equal(img.mimeType,'image/png');assert(Buffer.from(img.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
        const sequence=await mcp.tool('maze_sequence',{sequence:'UU'});assert.equal(data(sequence).completed_count,2);assert.equal(sequence.content.filter(c=>c.type==='image').length,1);noBoardData(data(sequence));
        const index=await mcp.tool('maze_observe',{record:'move_history/move_1/index.json'});const frames=JSON.parse(data(index).content).frames;assert(frames.length>=2);assert(frames.every(f=>f.record.endsWith('.png')));
        const old=await mcp.tool('maze_observe',{record:'move_history/move_0/frame_0000.png'});assert.equal(old.content.find(c=>c.type==='image').data,img.data);noBoardData(data(old));
        const camera=await mcp.tool('maze_action',{action:'camera right'});assert.equal(data(camera).observation.camera.yaw,1);assert.notEqual(camera.content.find(c=>c.type==='image').data,sequence.content.find(c=>c.type==='image').data);
        for(const record of ['current_board.txt','move_history/move_1.txt','../game-state.json','vision-source/move_1/frame_0000.json','move_history/move_999/index.json','file:///etc/passwd'])assert.equal((await mcp.tool('maze_observe',{record})).isError,true,record);
        for(const record of ['current_state.json','history.jsonl']){const value=await mcp.tool('maze_observe',{record});noBoardData(JSON.parse(data(value).content.split('\n')[0]));}
        const py=await mcp.tool('python_exec',{script_path:'check.py',code:'print(21 * 2)'});
        if(toolsEnabled){assert.equal(py.isError,false);assert.equal(data(py).stdout.trim(),'42');}else assert.equal(py.isError,true);
      }finally{await mcp.close();}
      verifyCheckpoint(directory);
      const runtime=await VisionRuntime.open(root,directory);const source=path.join(directory,'vision-source/move_1/frame_0000.json');const original=await readFile(source);await writeFile(source,'{}');await assert.rejects(()=>runtime.readRecord('move_history/move_1/frame_0000.png'),/integrity/);await writeFile(source,original);
      const indexFile=path.join(directory,'records/move_history/move_1/index.json'),originalIndex=await readFile(indexFile);await rm(indexFile);await symlink(path.join(directory,'game-state.json'),indexFile);await assert.rejects(()=>runtime.readRecord('move_history/move_1/index.json'));await rm(indexFile);await writeFile(indexFile,originalIndex);
      await verifyVisionIntegrity(root,directory,metadata);
    }
  }finally{await rm(recordsRoot,{recursive:true,force:true});}
});
test('vision companion accepts only its localhost host and the existing dashboard origin',()=>{
  const request=(host,origin,site)=>({headers:{host,origin,'sec-fetch-site':site}});
  assert(trustedVisionRequest(request('localhost:8082','http://localhost:8080','same-site'),8082,8080));
  assert(trustedVisionRequest(request('127.0.0.1:8082',undefined),8082,8080));
  for(const r of [request('evil.test:8082'),request('localhost:8082','https://evil.test'),request('localhost:8082','null'),request('localhost:8082','http://localhost:8080','cross-site')])assert.equal(trustedVisionRequest(r,8082,8080),false);
});
