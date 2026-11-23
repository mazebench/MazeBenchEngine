import {readFileSync,realpathSync,statSync,openSync,readSync,closeSync} from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';

export function sessionLocation(home,directory) {
  let source;
  try { source=readFileSync(path.join(home,'session_index.jsonl'),'utf8'); }
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
  // The CLI appends this index while a turn is running; ignore an unfinished line.
  const entries=source.slice(0,source.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
  const cwd=realpathSync(path.join(directory,'agent-cwd'));
  const matches=entries.filter(e=>e.workDir===cwd);
  const ids=[...new Set(matches.map(e=>e.sessionId))];
  if(ids.length>1)throw new Error('Unexpected extra Kimi conversation.');
  if(!ids.length)return null;
  if(!/^session_[a-f0-9-]{36}$/.test(ids[0]))throw new Error('Invalid Kimi session index.');
  const entry=matches.at(-1),root=realpathSync(path.join(home,'sessions'));
  const session=realpathSync(entry.sessionDir);
  if(!session.startsWith(root+path.sep)||path.basename(session)!==entry.sessionId)throw new Error('Kimi session escaped its private profile.');
  return {id:entry.sessionId,wire:path.join(session,'agents/main/wire.jsonl')};
}

const traces=new Map();
export function auditSession(frozen,directory,expectedSession=null) {
  const location=sessionLocation(frozen.kimi_home,directory);
  if(!location)return null;
  if(expectedSession&&location.id!==expectedSession)throw new Error('Kimi resumed a different conversation.');
  let stat;try{stat=statSync(location.wire);}catch(error){if(error.code==='ENOENT')return {id:location.id,requests:0};throw error;}
  let state=traces.get(location.wire);
  if(!state||state.ino!==stat.ino||stat.size<state.offset) {
    state={ino:stat.ino,offset:0,pending:'',decoder:new StringDecoder('utf8'),requests:0,usage:{input_tokens:0,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,total_tokens:0},error:null};
    if(traces.size>=32)traces.delete(traces.keys().next().value);
    traces.set(location.wire,state);
  }
  const fd=openSync(location.wire,'r'),buffer=Buffer.alloc(128*1024);
  try {
    while(state.offset<stat.size) {
      const count=readSync(fd,buffer,0,Math.min(buffer.length,stat.size-state.offset),state.offset);if(!count)break;
      state.offset+=count;state.pending+=state.decoder.write(buffer.subarray(0,count));
      const lines=state.pending.split('\n');state.pending=lines.pop();
      for(const line of lines) {
        if(!line.trim())continue;
        const event=JSON.parse(line);
        if(event.type==='llm.request') {
          if(event.model!==frozen.model||event.modelAlias!=='benchmark'||event.kind==='loop'&&event.thinkingEffort!==frozen.effort)state.error='Kimi changed its exact model or thinking effort.';
          state.requests++;
        }
        if(event.type==='usage.record'&&event.agentId==='main') {
          const u=event.usage||{};
          const counts=[u.inputOther,u.inputCacheRead,u.inputCacheCreation,u.output];
          if(counts.every(n=>Number.isFinite(n)&&n>=0)) {
            state.usage.input_tokens+=counts[0]+counts[1]+counts[2];state.usage.cached_input_tokens+=counts[1];
            state.usage.cache_write_input_tokens+=counts[2];state.usage.output_tokens+=counts[3];
            state.usage.total_tokens+=counts.reduce((a,b)=>a+b,0);
          }
        }
      }
      if(state.pending.length>16*1024*1024)throw new Error('Kimi trace record exceeds its limit.');
    }
  }finally{closeSync(fd);}
  if(state.error)throw new Error(state.error);
  return {id:location.id,requests:state.requests,usage:{...state.usage}};
}
