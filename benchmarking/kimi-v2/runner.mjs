import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createWriteStream,existsSync,writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {argumentsFor,boundaryValidator,authenticatedEnvironment} from './policy.mjs';
import {sessionLocation,auditSession} from './session.mjs';

export function runKimiTurn({directory,metadata,frozen,prompt,control,onSession,credentialHome}) {
  return new Promise((resolve,reject)=>{
    const turnId=randomUUID(),cwd=path.join(directory,'agent-cwd');
    const child=spawn(frozen.kimi_executable,argumentsFor({prompt,home:frozen.kimi_home,sessionId:metadata.kimi_session_id}),{
      cwd,env:authenticatedEnvironment(frozen.kimi_home,credentialHome),stdio:['ignore','pipe','pipe']});
    control.child=child;
    const raw=createWriteStream(path.join(directory,'kimi-events.jsonl'),{flags:'a',mode:0o600});
    const feed=createWriteStream(path.join(directory,'agent-events.jsonl'),{flags:'a',mode:0o600});
    const errors=createWriteStream(path.join(frozen.kimi_home,'stderr.log'),{flags:'a',mode:0o600});
    const validate=boundaryValidator({sessionId:metadata.kimi_session_id,toolsEnabled:metadata.tools_enabled});
    let buffer='',sessionId=metadata.kimi_session_id,boundaryError=null,completed=false,persistence=Promise.resolve(),lastActivity=Date.now(),killTimer;
    const invalidate=message=>{boundaryError||=message;writeFileSync(path.join(directory,'integrity-violation.json'),JSON.stringify({error:boundaryError,at:new Date().toISOString()}),{mode:0o600});child.kill('SIGKILL');};
    const captureSession=id=>{
      if(!/^session_[a-f0-9-]{36}$/.test(id)||sessionId&&sessionId!==id){invalidate('Kimi changed its conversation.');return;}
      if(!sessionId){sessionId=id;control.threadId=id;persistence=persistence.then(()=>onSession(id));}
    };
    // Persist the identity during the turn, so an operator pause can resume even
    // before the CLI prints its successful-turn resume hint.
    const discoverSession=()=>{
      if(sessionId)return;
      try {
        const location=sessionLocation(frozen.kimi_home,directory);
        if(location)captureSession(location.id);
      }catch(error){if(error.code!=='ENOENT')invalidate('Cannot read the Kimi conversation index.');}
    };
    const monitor=setInterval(()=>{
      discoverSession();
      if(existsSync(path.join(directory,'integrity-violation.json')))invalidate('Run invalidated by an integrity violation.');
      if((control.pauseRequested||control.stopRequested)&&!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);
      if(Date.now()-lastActivity>15*60*1000&&!killTimer){child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),10000);}
    },500);
    const item=value=>feed.write(JSON.stringify({type:'item.completed',item:value,_received_at:new Date().toISOString(),_turn_id:turnId})+'\n');
    const calls=new Map();
    function receive(line) {
      if(!line.trim())return;
      let event;try{event=JSON.parse(line);}catch{invalidate('Kimi emitted invalid JSON.');return;}
      lastActivity=Date.now();event._received_at=new Date().toISOString();event._turn_id=turnId;raw.write(JSON.stringify(event)+'\n');
      const violation=validate(event);if(violation){invalidate(violation);return;}
      if(event.role==='meta'&&event.type==='session.resume_hint')captureSession(event.session_id);
      if(event.role==='assistant') {
        for(const call of event.tool_calls||[]) {
          let args;try{args=JSON.parse(call.function.arguments);}catch{invalidate('Kimi sent invalid tool arguments.');return;}
          const entry={id:call.id,type:'mcp_tool_call',server:'mazebench',tool:call.function.name.replace(/^mcp__mazebench__/,''),arguments:args};
          calls.set(call.id,entry);item({...entry,status:'requested'});
        }
        if(typeof event.content==='string'&&event.content) {
          item({type:'agent_message',text:event.content});
          persistence=persistence.then(()=>writeFile(path.join(directory,'last-message.txt'),event.content,{mode:0o600}));
        }
        completed=!event.tool_calls?.length;
      }
      if(event.role==='tool') {
        const call=calls.get(event.tool_call_id);
        // A resumed CLI may first finish an interrupted, previously recorded call.
        if(call)item({...call,status:'completed',result:{content:[{type:'text',text:event.content||''}]}});
      }
    }
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop();lines.forEach(receive);if(buffer.length>8*1024*1024)invalidate('Kimi event exceeds the stream limit.');});
    child.stderr.on('data',chunk=>{lastActivity=Date.now();errors.write(chunk);});
    child.once('error',error=>{clearInterval(monitor);clearTimeout(killTimer);raw.end();feed.end();errors.end();control.child=null;reject(error);});
    child.once('close',async(code,signal)=>{
      clearInterval(monitor);clearTimeout(killTimer);
      if(buffer.trim()&&!control.pauseRequested&&!control.stopRequested)receive(buffer);
      discoverSession();
      let audit;
      try {audit=auditSession(frozen,directory,sessionId);}
      catch(error){invalidate(error.message);}
      await Promise.all([raw,feed,errors].map(stream=>new Promise(done=>stream.end(done))));control.child=null;
      try{await persistence;}catch(error){reject(error);return;}
      resolve({code:code??1,signal,sessionId,boundaryError,usage:audit?.usage,result:{status:code===0&&completed&&sessionId&&audit?.requests?'SUCCESS':'FAILED'},
        error:code===0?null:'Kimi Code could not complete the turn. Check subscription/quota and the private stderr.log in the run profile.'});
    });
  });
}
