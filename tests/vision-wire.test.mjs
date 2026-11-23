// Real Codex -> real vision MCP -> local Responses fixture. No paid requests
// or credentials: the test proves the PNG actually reaches model input.
import "../benchmarking/codex-releases.mjs";
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VisionSupervisor } from '../benchmarking/vision/supervisor.mjs';
import { buildVisionCodexArguments } from '../benchmarking/vision/policy.mjs';
import { claudeEnvironment, claudeTools } from '../benchmarking/providers/claude-policy.mjs';
import { runClaudeTurn } from '../benchmarking/vision/claude-runner.mjs';
import { eventBoundaryViolation } from '../benchmarking/v1/supervisor.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('real Codex forwards vision MCP images to the model with the restricted tool catalog',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'vision-wire-')),home=path.join(temporary,'codex-home');await mkdir(home);
  const supervisor=new VisionSupervisor(root,{recordsRoot:path.join(temporary,'runs')});supervisor.startVision=()=>{};
  let requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);
    const body=JSON.parse(Buffer.concat(chunks));requests.push({body,authorization:req.headers.authorization});
    const groups=[...(body.tools||[]),...(body.input||[]).filter(i=>i.type==='additional_tools').flatMap(i=>i.tools||[])];
    const ns=groups.find(g=>g.type==='namespace'&&g.tools.some(t=>t.name==='maze_observe'));
    const plain=groups.find(g=>g.name?.includes('maze_observe'));
    const item=requests.length===1?{id:'fc_vision',type:'function_call',call_id:'call_vision',name:ns?'maze_observe':plain?.name,arguments:'{}',...(ns?{namespace:ns.name}:{})}
      :{id:'msg_vision',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Image received.'}]};
    const response={id:'resp_vision_'+requests.length,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
    const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    for(const toolsEnabled of [false,true]){
      requests=[];
      const run=await supervisor.launch({model:'gpt-6-astra',provider:'codex',observation_mode:'vision',effort:'max',tools_enabled:toolsEnabled,service_tier:'fast',action_limit:1});
      const directory=supervisor.runDirectory(run.id),meta=JSON.parse(await readFile(path.join(directory,'run.json')));
      let args=buildVisionCodexArguments({projectRoot:root,runDirectory:directory,agentDirectory:path.join(directory,'agent-cwd'),model:meta.model,effort:'max',toolsEnabled,serviceTier:'fast',disabledFeatures:meta.capability_policy.disabled_features,modelCatalogPath:path.join(directory,meta.capability_policy.model_catalog.file),prompt:'Call maze_observe once.'});
      args=args.map(a=>a==='model_provider="openai"'?'model_provider="vision_fixture"':a);
      args.splice(args.length-1,0,'-c',`model_providers.vision_fixture={name="OpenAI",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false}`);
      const child=spawn(meta.capability_policy.codex_executable,args,{cwd:path.join(directory,'agent-cwd'),env:{HOME:os.homedir(),CODEX_HOME:home,PATH:process.env.PATH,CODEX_CODE_MODE_HOST_PATH:path.join(temporary,'disabled-host')},stdio:['ignore','pipe','pipe']});
      let errors='',output='';child.stderr.on('data',b=>errors+=b);child.stdout.on('data',b=>output+=b);
      const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
      const code=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject);});clearTimeout(timer);
      assert.equal(code,0,errors);assert.equal(requests.length,2,output+'\n'+errors);assert(requests.every(r=>!r.authorization));
      for(const line of output.trim().split('\n'))assert.equal(eventBoundaryViolation(JSON.parse(line),{toolsEnabled}),null);
      const images=[];function walk(v){if(!v||typeof v!=='object')return;if(v.type==='input_image')images.push(v);for(const x of Object.values(v))if(typeof x==='object')walk(x);}walk(requests[1].body.input);
      assert.equal(images.length,1,'Vision PNG must reach the actual model input');assert.match(images[0].image_url,/^data:image\/png;base64,iVBOR/);
      const first=requests[0].body,groups=[...(first.tools||[]),...(first.input||[]).filter(i=>i.type==='additional_tools').flatMap(i=>i.tools||[])],group=groups.find(g=>g.type==='namespace'&&g.name==='mcp__mazebench');assert(group);
      assert.deepEqual(group.tools.map(t=>t.name).sort(),['maze_action','maze_observe','maze_sequence',...(toolsEnabled?['python_exec']:[])].sort());
      assert.equal(requests[0].body.model,'gpt-6-astra');
    }
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}
});

test('real Claude Code receives the vision PNG and validates the restricted tool catalog',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'vision-claude-wire-')),home=path.join(temporary,'home');await mkdir(home);
  const supervisor=new VisionSupervisor(root,{recordsRoot:path.join(temporary,'runs')});supervisor.startVision=()=>{};
  let requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const b of req)chunks.push(b);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
    if(req.url.includes('count_tokens')){res.end('{"input_tokens":20}');return;}
    if(!req.url.startsWith('/v1/messages')){res.writeHead(404);res.end('{}');return;}
    requests.push(body);
    const block=requests.length===1?{type:'tool_use',id:'observe_vision',name:'mcp__mazebench__maze_observe',input:{}}:{type:'text',text:'Image received.'};
    const message={id:'msg_vision_'+requests.length,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}};
    const events=[{type:'message_start',message},{type:'content_block_start',index:0,content_block:block.type==='tool_use'?block:{type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:block.text}},
      {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:block.type==='tool_use'?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:10}},{type:'message_stop'}];
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    for(const toolsEnabled of [false,true]){
      requests=[];
      const run=await supervisor.launch({provider:'claude-code',model:'claude-fable-5-1',effort:'max',observation_mode:'vision',tools_enabled:toolsEnabled,action_limit:1});
      const directory=supervisor.runDirectory(run.id),metadata=JSON.parse(await readFile(path.join(directory,'run.json'))),frozen=await supervisor.verifyRunCapabilityBoundary(metadata,directory),control={};
      const timer=setTimeout(()=>control.child?.kill('SIGKILL'),30000);
      let turn;
      try{turn=await runClaudeTurn({projectRoot:root,directory,metadata,frozen,prompt:'Call maze_observe once.',control,onSession:async()=>{},
        environment:{...claudeEnvironment(),MAZEBENCH_PLAYWRIGHT_MODULE:path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'),HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ANTHROPIC_API_KEY:'offline-fixture-not-a-credential',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`}});}
      finally{clearTimeout(timer);}
      assert.equal(turn.code,0,turn.error);assert.equal(turn.boundaryError,null);assert.equal(turn.result?.is_error,false);assert.equal(requests.length,2);
      for(const request of requests)assert.deepEqual(request.tools.map(t=>t.name).sort(),claudeTools(toolsEnabled).sort());
      const images=[];function walk(v){if(!v||typeof v!=='object')return;if(v.type==='image')images.push(v);for(const x of Object.values(v))if(typeof x==='object')walk(x);}walk(requests[1].messages);
      assert.equal(images.length,1,'Vision PNG must reach the actual Claude model input');assert.equal(images[0].source.media_type,'image/png');assert.match(images[0].source.data,/^iVBOR/);
    }
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temporary,{recursive:true,force:true});}
});
