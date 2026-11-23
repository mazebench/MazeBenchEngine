import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {settings,environment,argumentsFor,boundaryValidator,defaultBinary,inspectInstallation,toolNames,EFFORTS,immutable,verifyIntegrity} from '../benchmarking/kimi-v2/policy.mjs';
import {runKimiTurn} from '../benchmarking/kimi-v2/runner.mjs';
import {BenchmarkSupervisor} from '../benchmarking/kimi-v2/supervisor.mjs';

import {providerName,runCompany} from '../benchmarking/ui/run-library.mjs';
import {previewBenchmarkPrompt} from '../benchmarking/prompt-preview.mjs';

const model={id:'k3',name:'Kimi K3.1 Pro',provider:'kimi-code',default_effort:'max',efforts:EFFORTS,context_limit:1048576};
const ready={available:true,tested:true,authenticated:true,launch_ready:true,models:[model]};
for(const [modelId,effort,toolsEnabled] of [["k3","max",false],["kimi-for-coding-highspeed","default",true]])test(`Kimi actual CLI tools, model, thinking and resume: Python ${modelId}`,{skip:!existsSync(defaultBinary()),timeout:45000},async t=>{
  assert(inspectInstallation().tested);
  const home=await mkdtemp(path.join(os.tmpdir(),'kimi-test-'));t.after(async()=>{for(const name of ['config.toml','mcp.json'])if(existsSync(path.join(home,name)))immutable(path.join(home,name),false);await rm(home,{recursive:true,force:true});});
  const directory=path.join(home,'run');await mkdir(path.join(directory,'agent-cwd'),{recursive:true});await mkdir(path.join(home,'skills'));await mkdir(path.join(home,'auth'));
  await writeFile(path.join(home,'auth/credential.json'),JSON.stringify({base_url:'https://api.kimi.com/coding/v1',api_key:'fixture-only'}));
  const canary='UNRELATED_PRIVATE_FILE_MUST_NOT_REACH_MODEL';await writeFile(path.join(home,'secret'),canary);
  const requests=[];let turns=0,forbidden=false;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);requests.push(request);
    const hasToolResult=request.messages.some(m=>m.role==='tool');
    const tool=toolsEnabled?'mcp__mazebench__python_exec':'mcp__mazebench__maze_observe';
    const delta=forbidden?{role:'assistant',tool_calls:[{index:0,id:'forbidden-call',type:'function',function:{name:'Bash',arguments:JSON.stringify({command:'touch '+path.join(home,'escaped')})}}]}:hasToolResult?{role:'assistant',content:'Fixture complete.'}:{role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name:tool,arguments:'{}'}}]};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [d,finish] of [[delta,null],[{},hasToolResult?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:modelId,choices:[{index:0,delta:d,finish_reason:finish}],usage:finish?{prompt_tokens:12,completion_tokens:5,total_tokens:17}:undefined})+'\n\n');
    if(hasToolResult)turns++;res.end('data: [DONE]\n\n');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  await writeFile(path.join(home,'config.toml'),settings({model:modelId,effort:effort,contextLimit:1048576,efforts:[effort],toolsEnabled,baseUrl:`http://127.0.0.1:${server.address().port}/v1`}));
  const calls=path.join(home,'calls.jsonl');const mcp=path.join(home,'fixture.mjs');
  await writeFile(mcp,`import readline from 'node:readline';import {appendFileSync} from 'node:fs';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mazebench',version:'1'}}:q.method==='tools/list'?{tools:${JSON.stringify([...toolNames(toolsEnabled),'forbidden_extra'].map(name=>({name,description:'Fixture tool',inputSchema:{type:'object',properties:{}}})))}}:q.method==='tools/call'?(appendFileSync(${JSON.stringify(calls)},JSON.stringify(q.params)+'\\n'),{content:[{type:'text',text:'Fixture game result'}]}):{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}`);
  await writeFile(path.join(home,'mcp.json'),JSON.stringify({mcpServers:{mazebench:{command:process.execPath,args:[mcp]}}}));
  for(const name of ['config.toml','mcp.json'])immutable(path.join(home,name));
  const metadata={model:modelId,tools_enabled:toolsEnabled,kimi_session_id:null};const control={};t.after(()=>control.child?.kill('SIGKILL'));
  const options={directory,metadata,frozen:{kimi_executable:defaultBinary(),kimi_home:home,model:modelId,effort:effort},prompt:'Call the available game tool.',control,credentialHome:path.join(home,'auth'),onSession:async id=>{metadata.kimi_session_id=id;}};
  const first=await runKimiTurn(options);assert.equal(first.code,0);assert.equal(first.boundaryError,null);assert.equal(first.result.status,'SUCCESS');assert.equal(first.usage.total_tokens,34);assert.match(metadata.kimi_session_id,/^session_/);
  const id=metadata.kimi_session_id;
  const second=await runKimiTurn({...options,prompt:'Continue the same conversation.'});assert.equal(second.code,0);assert.equal(second.sessionId,id);assert.equal(second.boundaryError,null);assert.equal(turns,2);assert.equal(second.usage.total_tokens,51);
  assert(requests.length>=3);
  for(const request of requests){assert.equal(request.model,modelId);assert.deepEqual(request.tools.map(x=>x.function.name).sort(),toolNames(toolsEnabled).map(n=>'mcp__mazebench__'+n).sort());assert.equal(request.thinking.type,'enabled');if(effort!=="default")assert.equal(request.thinking.effort,effort);else assert.equal(request.thinking.effort,undefined);assert(!JSON.stringify(request).includes(canary));}
  assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse).map(c=>c.name),[toolsEnabled?'python_exec':'maze_observe']);
  assert.match(await readFile(path.join(directory,'agent-events.jsonl'),'utf8'),/Fixture complete/);
  assert.equal(await readFile(path.join(home,'secret'),'utf8'),canary);
  forbidden=true;
  const rejected=await runKimiTurn({...options,prompt:'Attempt a forbidden tool.'});
  assert.match(rejected.boundaryError,/forbidden tool/);
  assert(!existsSync(path.join(home,'escaped')),'Forbidden host command must never execute');
});

test('Kimi catalog signed launch creates a protected profile and rejects config tampering',{skip:!existsSync(defaultBinary()),timeout:60000},async t=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'kimi-launch-'));
  const supervisor=new BenchmarkSupervisor(process.cwd(),{recordsRoot:path.join(temporary,'records'),kimiStateRoot:path.join(temporary,'profiles'),kimiAuthHome:path.join(temporary,'auth'),kimiStatus:async()=>ready});
  await mkdir(path.join(temporary,'auth'));await writeFile(path.join(temporary,'auth/credential.json'),JSON.stringify({base_url:'https://api.kimi.com/coding/v1',api_key:'fixture-only'}));
  let launch;
  supervisor.startKimi=(...args)=>{launch=args;};
  t.after(async()=>{if(launch){const home=path.join(temporary,'profiles',launch[0]);for(const name of ['config.toml','mcp.json'])immutable(path.join(home,name),false);}await rm(temporary,{recursive:true,force:true});});
  const run=await supervisor.launch({provider:'kimi-code',model:'k3',action_limit:1});
  assert(launch);assert.equal(run.model,'k3');assert.equal(run.capability_boundary_verified,true);
  const metadata=JSON.parse(await readFile(path.join(launch[1],'run.json'),'utf8'));
  const frozen=await verifyIntegrity(process.cwd(),launch[1],metadata);assert.equal(frozen.kimi_context_limit,1048576);
  // Exercise the actual integrity-checking gateway and signed game runtime.
  const child=spawn(process.execPath,['benchmarking/kimi-v2/mcp.mjs'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',MAZEBENCH_PROJECT_ROOT:process.cwd(),MAZEBENCH_RUN_DIRECTORY:launch[1]},stdio:['pipe','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
  let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'maze_observe',arguments:{}}})+'\n');
  const code=await new Promise(r=>child.on('close',r));assert.equal(code,0,errors);
  const responses=output.trim().split('\n').map(JSON.parse);assert.deepEqual(responses[0].result.tools.map(t=>t.name),toolNames(false));assert(responses[1].result.content.length);
  const config=path.join(frozen.kimi_home,'config.toml');immutable(config,false);await chmod(config,0o600);await writeFile(config,'[tools]\nenabled=["Bash"]\n');immutable(config);
  await assert.rejects(verifyIntegrity(process.cwd(),launch[1],metadata),/configuration changed/);
});
