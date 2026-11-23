import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {settings,environment,authenticatedEnvironment,tokenPath,argumentsFor,boundaryValidator,defaultBinary,inspectInstallation,toolNames,EFFORTS} from '../benchmarking/muse-code/policy.mjs';
import {BenchmarkSupervisor} from '../benchmarking/muse-code/supervisor.mjs';
import {catalogModels} from '../benchmarking/muse-code/status.mjs';
import {providerName,runCompany} from '../benchmarking/ui/run-library.mjs';

for(const toolsEnabled of [true])test(`Muse binary capability boundary, Python ${toolsEnabled?'on':'off'}`,{skip:!existsSync(defaultBinary()),timeout:45000},async t=>{
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
