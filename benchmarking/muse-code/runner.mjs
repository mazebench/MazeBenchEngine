import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createWriteStream,existsSync,writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {argumentsFor,boundaryValidator,authenticatedEnvironment} from './policy.mjs';

export function runMuseTurn({directory,metadata,frozen,prompt,control,onSession}) {
  return new Promise((resolve,reject)=>{
    const turnId=randomUUID(),cwd=path.join(directory,'agent-cwd');
    const child=spawn(frozen.muse_executable,argumentsFor({model:metadata.model,effort:metadata.effort,prompt,cwd,sessionId:metadata.muse_session_id}),{
      cwd,env:authenticatedEnvironment(frozen.muse_home),stdio:['ignore','pipe','pipe']});
    control.child=child;
    const raw=createWriteStream(path.join(directory,'muse-events.jsonl'),{flags:'a',mode:0o600});
    const feed=createWriteStream(path.join(directory,'agent-events.jsonl'),{flags:'a',mode:0o600});
    // Auth diagnostics stay outside publicly readable benchmark records.
    const errors=createWriteStream(path.join(frozen.muse_home,'stderr.log'),{flags:'a',mode:0o600});
    const validate=boundaryValidator({model:metadata.model,sessionId:metadata.muse_session_id,toolsEnabled:metadata.tools_enabled});
    let buffer='',sessionId=metadata.muse_session_id,boundaryError=null,result=null,persistence=Promise.resolve(),lastActivity=Date.now(),killTimer;
    const invalidate=message=>{boundaryError||=message;writeFileSync(path.join(directory,'integrity-violation.json'),JSON.stringify({error:boundaryError,at:new Date().toISOString()}),{mode:0o600});child.kill('SIGKILL');};
    const monitor=setInterval(()=>{
      if(existsSync(path.join(directory,'integrity-violation.json')))invalidate('Run invalidated by an integrity violation.');
      if((control.pauseRequested||control.stopRequested)&&!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);
      if(Date.now()-lastActivity>15*60*1000&&!killTimer){child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);}
    },500);
    const item=value=>feed.write(JSON.stringify({type:'item.completed',item:value,_received_at:new Date().toISOString(),_turn_id:turnId})+'\n');
    const seen=new Set(),calls=new Map();
    function receive(line) {
      if(!line.trim())return;
      let event;try{event=JSON.parse(line);}catch{invalidate('Muse emitted invalid JSON.');return;}
      lastActivity=Date.now();event._received_at=new Date().toISOString();event._turn_id=turnId;raw.write(JSON.stringify(event)+'\n');
      const violation=validate(event);if(violation){invalidate(violation);return;}
      if(event.stream?.kind==='session'&&!sessionId){sessionId=event.stream.id;control.threadId=sessionId;persistence=persistence.then(()=>onSession(sessionId));}
      const d=event.payload?.event||event.payload||{},kind=d.kind;
      if(kind==='run_output_delta'&&d.text)item({type:'agent_message',text:d.text});
      if(kind==='assistant_tool_calls_committed')for(const call of d.tool_calls||[]) {
        if(seen.has(call.id))continue;seen.add(call.id);
        let args=call.arguments||{};if(typeof args==='string'){try{args=JSON.parse(args);}catch{invalidate('Muse sent invalid tool arguments.');return;}}
        item({type:'mcp_tool_call',server:'mazebench',tool:call.name.replace(/^mcp__mazebench__/,''),arguments:args,status:'requested'});
      }
      if(kind==='side_effect_intent'&&d.operation?.startsWith('tool:')) {
        const id=d.idempotency_key?.replace(/^tool:/,'')||d.task_id;
        const call={id,type:'mcp_tool_call',server:'mazebench',tool:d.operation.slice('tool:mcp__mazebench__'.length),arguments:{}};
        calls.set(id,call);item({...call,status:'requested'});
      }
      if(kind==='tool_result'&&calls.has(d.call_id))item({...calls.get(d.call_id),status:'completed',result:{content:[{type:'text',text:d.text||''}]}});
      if(kind==='run_terminal') {
        result={status:d.terminal==='completed'?'SUCCESS':'FAILED',response:d.text||'',error:d.reason?{message:d.reason}:null};
        if(d.text)persistence=persistence.then(()=>writeFile(path.join(directory,'last-message.txt'),d.text,{mode:0o600}));
      }
    }
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop();lines.forEach(receive);if(buffer.length>8*1024*1024)invalidate('Muse event exceeds the stream limit.');});
    child.stderr.on('data',chunk=>errors.write(chunk));
    child.once('error',error=>{clearInterval(monitor);clearTimeout(killTimer);raw.end();feed.end();errors.end();control.child=null;reject(error);});
    child.once('close',async(code,signal)=>{
      clearInterval(monitor);clearTimeout(killTimer);if(buffer.trim())receive(buffer);
      await Promise.all([raw,feed,errors].map(stream=>new Promise(done=>stream.end(done))));control.child=null;
      try{await persistence;}catch(error){reject(error);return;}
      resolve({code:code??1,signal,sessionId,boundaryError,result,error:result?.error?.message||(!result?'Muse exited without a completion event.':null)});
    });
  });
}
