import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {settings,environment,authenticatedEnvironment,tokenPath,argumentsFor,boundaryValidator,defaultBinary,inspectInstallation,toolNames,EFFORTS} from '../benchmarking/muse/policy.mjs';
import {BenchmarkSupervisor} from '../benchmarking/muse/supervisor.mjs';
import {catalogModels} from '../benchmarking/muse/status.mjs';
import {providerName,runCompany} from '../benchmarking/ui/run-library.mjs';

test('Muse uses each model’s catalog efforts and default without guessing',async()=>{
  const models=catalogModels({providerId:'meta',source:'providerCatalog',models:[
    {modelId:'muse-wonder-1.0',variants:EFFORTS,defaultReasoningEffort:'high'},
    {modelId:'muse-spark-1.2',variants:EFFORTS.filter(e=>e!=='max'),defaultReasoningEffort:'high',reasoningEffortVariants:[{tier:'xhigh',description:'Deepest analysis'}]},
    {modelId:'muse-spark-1.3-contributor',variants:EFFORTS,defaultReasoningEffort:'max'},
    {modelId:'muse-missing',defaultReasoningEffort:'high'},
    {modelId:'muse-invalid',variants:['low'],defaultReasoningEffort:'max'}
  ]});
  assert.equal(models.length,3);
  assert.deepEqual(models[0].efforts,EFFORTS);
  assert.deepEqual(models[1].efforts,['minimal','low','medium','high','xhigh']);
  assert.equal(models[2].default_effort,'max');
  assert.deepEqual(catalogModels({providerId:'meta',source:'fallback',models}),[]);
  const supervisor=new BenchmarkSupervisor(process.cwd(),{museStatus:async()=>({models})});
  await assert.rejects(supervisor.validateSpec({provider:'muse-code',model:'muse-spark-1.2',effort:'max'}),/Unsupported Muse reasoning effort/);
  assert.equal((await supervisor.validateSpec({provider:'muse-code',model:'muse-spark-1.3-contributor'})).effort,'max');
});

test('Muse uses only the chosen game tools and a private environment',()=>{
  for(const enabled of [false,true]) {
    const config=settings({command:'/node',args:['/mcp'],toolsEnabled:enabled});
    assert.deepEqual(config.run.toolset,toolNames(enabled).map(n=>'mcp__mazebench__'+n));
    assert.deepEqual(Object.keys(config.mcp_servers),['mazebench']);
    assert.equal(config.local_session_messaging.enabled,false);
    assert.equal(config.context.foreign_personal_rules,false);
    const env=environment('/private/profile');
    for(const name of ['META_API_KEY','MUSE_BASE_URL','CODEX_HOME','MAZEBENCH_PROJECT_ROOT'])assert.equal(env[name],undefined);
    const args=argumentsFor({model:'muse-wonder-1.0',effort:'high',prompt:'play',cwd:'/private/empty'});
    for(const flag of ['--disable-web-tools','--disable-write','--disable-shell','--no-foreign-personal-context','--no-parallel-tool-calls'])assert(args.includes(flag));
    for(const flag of ['--yolo','--disable-sandbox','--trust-workspace','--base-url'])assert(!args.includes(flag));
  }
});
test('Muse Full preserves its exact catalog model and advertised reasoning presets',async()=>{
  const models=catalogModels({providerId:'meta',source:'providerCatalog',models:[
    {modelId:'muse-wonder-1.0',variants:EFFORTS,defaultReasoningEffort:'high'},
    {modelId:'muse-wonder-full-1.0',variants:EFFORTS,defaultReasoningEffort:'high'}
  ]});
  const full=models.find(model=>model.id==='muse-wonder-full-1.0');
  assert.deepEqual(full.efforts,EFFORTS);
  const supervisor=new BenchmarkSupervisor(process.cwd(),{museStatus:async()=>({models})});
  const spec=await supervisor.validateSpec({provider:'muse-code',model:full.id,effort:'max'});
  assert.equal(spec.model,full.id);
  assert.equal(spec.effort,'max');
  await assert.rejects(supervisor.validateSpec({provider:'muse-code',model:full.id,effort:'ultra'}));
  const unavailable=new BenchmarkSupervisor(process.cwd(),{museStatus:async()=>({models:models.filter(model=>model.id!==full.id)})});
  await assert.rejects(unavailable.validateSpec({provider:'muse-code',model:full.id}));
});
test('private Muse credentials use environment auth without legacy Keychain migration',async t=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'muse-auth-test-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  await writeFile(tokenPath(home),JSON.stringify({providers:{meta:{api_key:'fixture-subscription-key'}}}),{mode:0o600});
  const env=authenticatedEnvironment(home);
  assert.equal(env.META_API_KEY,'fixture-subscription-key');
  assert.equal(env.HOME,home);
  assert(!existsSync(path.join(home,'.config/muse/auth.json')));
});
test('Muse guards exact model, session and Python condition',()=>{
  const options={model:'muse-wonder-1.0',sessionId:'expected',toolsEnabled:false};
  const event=detail=>({payload:detail});
  const init=event({kind:'run_model_configured',model_id:options.model,provider_id:'meta'});
  const v=boundaryValidator(options);assert.equal(v(init),null);
  for(const name of ['read_file','bash','workflow','session_message','mcp__other__maze_action','mcp__mazebench__python_exec'])assert(v(event({kind:'assistant_tool_calls_committed',tool_calls:[{name}]})));
  assert.equal(v(event({kind:'assistant_tool_calls_committed',tool_calls:[{name:'mcp__mazebench__maze_action'}]})),null);
  assert.equal(v({payload:{kind:'task_lifecycle',event:{kind:'side_effect_intent',operation:'tool:mcp__mazebench__maze_action'}}}),null);
  assert(v({payload:{kind:'task_lifecycle',event:{kind:'side_effect_intent',operation:'tool:read_file'}}}));
  assert(v({stream:{kind:'session',id:'other'},payload:{}}));
  assert(boundaryValidator(options)(event({kind:'run_model_configured',model_id:'substituted',provider_id:'meta'})));
});
test('Muse launcher accepts live model IDs, keeps unlimited actions and rejects unsupported worlds',async()=>{
  const supervisor=new BenchmarkSupervisor(process.cwd(),{museStatus:async()=>({models:[{id:'muse-wonder-1.0',default_effort:'high',efforts:EFFORTS}]})});
  const spec=await supervisor.validateSpec({provider:'muse-code',model:'muse-wonder-1.0',effort:'max',action_limit:null});
  assert.equal(spec.actionLimit,null);assert.equal(spec.effort,'max');
  for(const value of [{world:'slotski'},{observation_mode:'vision'},{model:'muse-imaginary'},{effort:'invalid'},{service_tier:'fast'}])await assert.rejects(supervisor.validateSpec({provider:'muse-code',...value}));
  assert.equal(providerName('muse-code'),'Meta Muse Code');assert.equal(runCompany({provider:'muse-code',model:'muse-wonder-1.0'}),'Meta');
});

// The real, pinned CLI calls a local fake provider. Inspect the effective HTTP
// tool schema to ensure no built-in or unrelated tools are offered. No
// subscription credential or real model is used by this test.
for(const toolsEnabled of [false,true])test(`Muse binary capability boundary, Python ${toolsEnabled?'on':'off'}`,{skip:!existsSync(defaultBinary()),timeout:45000},async t=>{
  assert(inspectInstallation().tested);
  const dir=await mkdtemp(path.join(os.tmpdir(),'muse-boundary-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(path.join(dir,'.config/muse'),{recursive:true});await mkdir(path.join(dir,'empty'));
  const canary='host-content-must-not-reach-model';await writeFile(path.join(dir,'secret'),canary);
  const calls=path.join(dir,'calls.jsonl');
  const mcp=path.join(dir,'fixture.mjs');
  await writeFile(mcp,`import readline from 'node:readline';import {appendFileSync} from 'node:fs';
    for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;
    const result=q.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'mazebench',version:'1'}}:q.method==='tools/list'?{tools:${JSON.stringify(toolNames(toolsEnabled).map(name=>({name,description:'Fixture game tool',inputSchema:{type:'object',properties:{}}})))}}:q.method==='tools/call'?(appendFileSync(${JSON.stringify(calls)},JSON.stringify(q.params)+'\\n'),{content:[{type:'text',text:'Fixture game result'}]}):{};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');}`);
  await writeFile(path.join(dir,'.config/muse/settings.json'),JSON.stringify({...settings({command:process.execPath,args:[mcp],toolsEnabled}),provider_retry:{max_retries:0}}));
  const requests=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'muse-spark-1.3'}]}));return;}
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);requests.push(request);
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({error:{message:'Capability fixture complete',type:'invalid_request_error'}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const args=argumentsFor({model:'muse-spark-1.3',effort:'minimal',prompt:'Use the game tools.',cwd:path.join(dir,'empty')});
  args.splice(-1,0,'--base-url',`http://127.0.0.1:${server.address().port}/v1`,'--max-model-steps','4');
  const child=spawn(defaultBinary(),args,{cwd:path.join(dir,'empty'),env:{...environment(dir),META_API_KEY:'fixture-only'}});
  t.after(()=>child.kill('SIGKILL'));let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timer);
  assert(requests.length>=1,stderr+'\n'+stdout.slice(-1500));
  for(const request of requests) {
    const names=request.tools.flatMap(ns=>ns.tools.map(tool=>ns.name+'__'+tool.name));
    assert.deepEqual(names.toSorted(),toolNames(toolsEnabled).map(n=>'mcp__mazebench__'+n).toSorted());
    assert(!JSON.stringify(request).includes(canary),'Host file was disclosed');
  }
  assert(!existsSync(calls),'No tools should run after the fixture rejects the request');
  assert.equal(await readFile(path.join(dir,'secret'),'utf8'),canary);
  assert([0,1].includes(code),stderr);
});
