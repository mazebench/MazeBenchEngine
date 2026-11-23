// Authenticated incremental checkpoints. Immutable base + chained append log;
// checkpoint.json is the sole atomic commit point. No SQLite/native dependency.
import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,ftruncateSync,openSync,readSync,renameSync,writeSync,writeFileSync,unlinkSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {safeDirectory,safeOpenFile,safeReadFile} from '../v1/safe-files.mjs';
import {readCheckpointJson,writeCheckpointJson} from '../v1/checkpoint-json.mjs';
export const JOURNAL_FORMAT='incremental-v1';
const ARRAY_VIEW=Symbol('array view');
const caches=new Map();
const writers=new Set();
const sha=value=>createHash('sha256').update(value).digest('hex');
const error=()=>new Error('Benchmark state or score was modified outside the engine; incremental checkpoint verification failed.');
const keyFor=root=>safeReadFile(root,'sandbox-state/integrity-key',null);
const mac=(key,value)=>createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
const stamp=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const sign=(key,value)=>({...value,hmac:mac(key,value)});
function authenticated(key,value){const{hmac,...body}=value;const a=Buffer.from(String(hmac||''),'hex'),b=Buffer.from(mac(key,body),'hex');if(a.length!==b.length||!timingSafeEqual(a,b))throw error();return body;}
function hashFile(root,file){const fd=safeOpenFile(root,file),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}}
function info(root,file){const fd=safeOpenFile(root,file);try{return fstatSync(fd);}finally{closeSync(fd);}}
const marker=(generation,kind)=>JSON.stringify({storage:JOURNAL_FORMAT,generation,kind})+'\n';
const folder=head=>`journal/${head.generation}`;
export function isJournalHead(value){return value?.storage===JOURNAL_FORMAT;}
export function journalHead(root){return JSON.parse(safeReadFile(root,'checkpoint.json'));}
export function isIncremental(root){try{return isJournalHead(journalHead(root));}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function validHead(head){if(!/^[a-f0-9-]{36}$/.test(head.generation||'')||!Number.isSafeInteger(head.revision)||head.revision<0||!Number.isSafeInteger(head.bytes)||head.bytes<0||!head.base)throw error();}
function entryAt(root,head,start,end){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start>32*1024*1024)throw error();
  const fd=safeOpenFile(root,folder(head)+'/entries.jsonl'),bytes=Buffer.alloc(end-start);try{let n=0;while(n<bytes.length){const read=readSync(fd,bytes,n,bytes.length-n,start+n);if(!read)throw error();n+=read;}}finally{closeSync(fd);}
  if(bytes.at(-1)!==10)throw error();return JSON.parse(bytes.toString('utf8'));
}
function verifyBase(root,head,cache){
  for(const name of ['state','summary']){const file=folder(head)+`/base-${name}.json`,s=stamp(info(root,file));
    if(cache.base?.[name]!==s){if(hashFile(root,file)!==head.base[name])throw error();(cache.base??={})[name]=s;}}
}
export function verifyJournal(root,{full=false}={}){
  const head=journalHead(root);if(!isJournalHead(head))throw error();validHead(head);const key=keyFor(root);authenticated(key,head);
  for(const[kind,file]of [['state','game-state.json'],['summary','summary.json'],['display','display.json']])if(safeReadFile(root,file)!==marker(head.generation,kind))throw error();
  let cache=caches.get(root);if(!cache||cache.generation!==head.generation){cache={generation:head.generation};caches.set(root,cache);if(caches.size>24)caches.delete(caches.keys().next().value);}
  verifyBase(root,head,cache);
  const stat=info(root,folder(head)+'/entries.jsonl');if(stat.size<head.bytes)throw error();
  if(head.revision){const entry=entryAt(root,head,head.lastStart,head.bytes);authenticated(key,entry);if(entry.hmac!==head.tip||entry.revision!==head.revision||entry.generation!==head.generation)throw error();}
  // If a committed log changed without a new authenticated commit, recheck it.
  // A crash may leave an uncommitted suffix; only the signed prefix is visible.
  if(full||(cache.hmac===head.hmac&&cache.stamp!==stamp(stat)))scanEntries(root,head,key,()=>{});
  cache.hmac=head.hmac;cache.stamp=stamp(stat);return head;
}
function scanEntries(root,head,key,consume,{offset=0,revision=0,tip=null}={}){
  const fd=safeOpenFile(root,folder(head)+'/entries.jsonl'),buffer=Buffer.allocUnsafe(256*1024);let pending=Buffer.alloc(0),cursor=offset;
  try{while(cursor<head.bytes){const n=readSync(fd,buffer,0,Math.min(buffer.length,head.bytes-cursor),cursor);if(!n)throw error();cursor+=n;pending=Buffer.concat([pending,buffer.subarray(0,n)]);let split;
    while((split=pending.indexOf(10))>=0){const line=pending.subarray(0,split);pending=pending.subarray(split+1);const entry=JSON.parse(line.toString('utf8'));authenticated(key,entry);if(entry.generation!==head.generation||entry.revision!==++revision||entry.previous!==tip)throw error();tip=entry.hmac;consume(entry);}
    if(pending.length>32*1024*1024)throw error();}
    if(pending.length||revision!==head.revision||tip!==head.tip)throw error();
  }finally{closeSync(fd);}
}
function applyDelta(value,delta){
  for(const name of delta.remove||[])delete value[name];
  for(const[name,item]of Object.entries(delta.set||{}))Object.defineProperty(value,name,{value:item,writable:true,enumerable:true,configurable:true});
  for(const[name,change]of Object.entries(delta.arrays||{})){if(!Array.isArray(value[name])||change.keep<0||change.keep>value[name].length)throw error();value[name].length=change.keep;for(const item of change.append)value[name].push(item);}
  for(const[name,change]of Object.entries(delta.maps||{})){const map=value[name];if(!map||typeof map!=='object'||Array.isArray(map))throw error();for(const k of change.remove)delete map[k];for(const[k,v]of Object.entries(change.set))Object.defineProperty(map,k,{value:v,writable:true,enumerable:true,configurable:true});}
}
export async function readJournal(root,kind='state'){
  const head=verifyJournal(root);if(kind==='display')return structuredClone(head.display);
  if(!['state','summary'].includes(kind))throw error();
  const value=await readCheckpointJson(root,folder(head)+`/base-${kind}.json`);
  scanEntries(root,head,keyFor(root),entry=>applyDelta(value,entry[kind]));return value;
}
const summaryCache=new Map(),pendingSummary=new Map();
export async function readJournalSummary(root,snapshot=null){
  const prior=pendingSummary.get(root)||Promise.resolve();const task=prior.catch(()=>{}).then(async()=>{
    const current=verifyJournal(root),head=snapshot||current;if(head.generation!==current.generation)throw error();authenticated(keyFor(root),head);let cache=summaryCache.get(root);
    if(!cache||cache.generation!==head.generation||cache.revision>head.revision||cache.bytes>head.bytes){cache={generation:head.generation,revision:0,bytes:0,tip:null,value:await readCheckpointJson(root,folder(head)+'/base-summary.json')};summaryCache.set(root,cache);if(summaryCache.size>16)summaryCache.delete(summaryCache.keys().next().value);}
    if(cache.revision!==head.revision)scanEntries(root,head,keyFor(root),entry=>applyDelta(cache.value,entry.summary),{offset:cache.bytes,revision:cache.revision,tip:cache.tip});
    Object.assign(cache,{revision:head.revision,bytes:head.bytes,tip:head.tip});
    // Hand each reader its own array containers before yielding. A later read
    // may advance the cache while this request still awaits its metadata/logs.
    return Object.fromEntries(Object.entries(cache.value).map(([k,v])=>[k,Array.isArray(v)?v.slice():v]));
  });pendingSummary.set(root,task);try{return await task;}finally{if(pendingSummary.get(root)===task)pendingSummary.delete(root);}
}
export const arrayView=(items,map=x=>x)=>({[ARRAY_VIEW]:true,items,map});
function arrayOf(value){return value?.[ARRAY_VIEW]?value:Array.isArray(value)?{items:value,map:x=>x}:null;}
function tracker(value){const out={};for(const[k,v]of Object.entries(value)){const a=arrayOf(v);out[k]=a?{length:a.items.length,ref:a.items,tail:a.items.slice(-2)}:k==='roomEntryStates'?{map:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,JSON.stringify(v)]))}:{text:JSON.stringify(v)};}return out;}
function deltaFor(value,previous,incremental){
  const delta={set:{},remove:[],arrays:{},maps:{}},next={};
  for(const k of Object.keys(previous))if(!Object.hasOwn(value,k)||value[k]===undefined)delta.remove.push(k);
  for(const[k,v]of Object.entries(value)){if(v===undefined)continue;const old=previous[k],a=arrayOf(v);
    if(a){let keep=0;if(incremental&&old?.length!==undefined){const n=a.items.length;
      if(n>=old.length&&n<=old.length+1000&&(old.length===0||a.items[old.length-1]===old.tail.at(-1)))keep=old.length;
      else if(n===old.length-1&&(n===0||a.items[n-1]===old.tail.at(-2)))keep=n;}
      const append=a.items.slice(keep).map(a.map);if(!old||old.length===undefined)delta.set[k]=append;else if(keep!==old.length||append.length)delta.arrays[k]={keep,append};
      next[k]={length:a.items.length,ref:a.items,tail:a.items.slice(-2)};
    }else if(k==='roomEntryStates'&&old?.map){const map={},set={},remove=[];for(const[name,item]of Object.entries(v)){map[name]=JSON.stringify(item);if(map[name]!==old.map[name])set[name]=item;}for(const name of Object.keys(old.map))if(!Object.hasOwn(v,name))remove.push(name);if(remove.length||Object.keys(set).length)delta.maps[k]={set,remove};next[k]={map};
    }else{const text=JSON.stringify(v);if(text!==old?.text)delta.set[k]=v;next[k]=k==='roomEntryStates'?{map:Object.fromEntries(Object.entries(v).map(([name,item])=>[name,JSON.stringify(item)]))}:{text};}}
  return{delta,next};
}
function compact(value){return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined&&!arrayOf(v)));}
function atomicHead(root,head){
  const temporary=path.join(root,`.checkpoint-head-${randomUUID()}.tmp`),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
  try{writeFileSync(fd,JSON.stringify(head)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  try{renameSync(temporary,path.join(root,'checkpoint.json'));const dir=openSync(root,constants.O_RDONLY);try{fsyncSync(dir);}finally{closeSync(dir);}}
  finally{try{unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export class JournalWriter{
  setSummary(summary){this.summary=tracker(summary);}
  constructor(root,state,summary,head=verifyJournal(root,{full:true})){this.root=root;this.head=head;this.key=keyFor(root);this.state=tracker(state);this.summary=tracker(summary);this.actionCount=state.actionCount;}
  async commit(state,summary,display,{staging,artifacts=[],observation=null,onPhase=()=>{}}={}){
    if(this.poisoned)throw this.poisoned;
    if(writers.has(this.root))throw new Error("Another writer is committing this checkpoint.");
    writers.add(this.root);
    try{
      const current=verifyJournal(this.root);if(current.hmac!==this.head.hmac)throw new Error('Another writer advanced the checkpoint. Reopen before saving.');
      const incremental=state.actionCount===this.actionCount+1;
      const s=deltaFor(state,this.state,incremental),t=deltaFor(summary,this.summary,incremental);
      const entry=sign(this.key,{generation:current.generation,revision:current.revision+1,previous:current.tip,state:s.delta,summary:t.delta});
      const bytes=Buffer.from(JSON.stringify(entry)+'\n');if(bytes.length>32*1024*1024)throw new Error('Incremental move exceeds the journal entry limit.');
      const head=sign(this.key,{...Object.fromEntries(Object.entries(current).filter(([k])=>k!=='hmac')),historyEpoch:incremental?(current.historyEpoch||current.generation):randomUUID(),revision:entry.revision,tip:entry.hmac,lastStart:current.bytes,bytes:current.bytes+bytes.length,summary:compact(summary),display,observation});
      // Only immutable per-move artifacts are published before the commit.
      for(const relative of artifacts){if(!/^(records\/move_history\/|display-history\/|vision-source\/)/.test(relative))throw new Error('Unexpected mutable journal artifact.');safeDirectory(this.root,path.dirname(relative),{create:true});const file=path.join(staging,relative);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}await rename(file,path.join(this.root,relative));}
      await onPhase('artifacts');
      const log=path.join(this.root,folder(current),'entries.jsonl'),fd=openSync(log,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size<current.bytes)throw error();ftruncateSync(fd,current.bytes);let at=0;while(at<bytes.length)at+=writeSync(fd,bytes,at,bytes.length-at,current.bytes+at);fsyncSync(fd);}finally{closeSync(fd);}
      const hook=onPhase('append');if(hook?.then)throw new Error('Append failure hooks must be synchronous.');atomicHead(this.root,head);
      this.head=head;this.state=s.next;this.summary=t.next;this.actionCount=state.actionCount;const previousCache=caches.get(this.root);
      // Seed verification without rescanning the growing immutable prefix.
      const cache={generation:head.generation,hmac:head.hmac,base:previousCache?.base,stamp:stamp(info(this.root,folder(head)+'/entries.jsonl'))};verifyBase(this.root,head,cache);caches.set(this.root,cache);
      await onPhase('commit');
    }catch(e){this.poisoned=e;throw e;}finally{writers.delete(this.root);}
  }
}
export async function createJournal(root,state,summary,display,observation=null){
  if(isIncremental(root))throw new Error('Checkpoint already uses incremental storage.');
  const generation=randomUUID(),relative=`journal/${generation}`;safeDirectory(root,relative,{create:true});
  await writeCheckpointJson(path.join(root,relative,'base-state.json'),state);await writeCheckpointJson(path.join(root,relative,'base-summary.json'),summary);
  await writeFile(path.join(root,relative,'entries.jsonl'),'',{flag:'wx',mode:0o600});
  const key=keyFor(root),head=sign(key,{version:4,storage:JOURNAL_FORMAT,generation,revision:0,bytes:0,lastStart:0,tip:null,base:{state:hashFile(root,relative+'/base-state.json'),summary:hashFile(root,relative+'/base-summary.json')},summary:compact(summary),display,observation});
  for(const[kind,file]of [['state','game-state.json'],['summary','summary.json'],['display','display.json']])await writeFile(path.join(root,file),marker(generation,kind),{mode:0o600});
  atomicHead(root,head);return new JournalWriter(root,state,summary,head);
}
export async function attachJournal(root,state,summary){
  if(!isIncremental(root))return null;
  const head=verifyJournal(root,{full:true});
  // Scalar projections may gain fields during an audited runtime migration.
  // Compare against what is actually committed so their first update is saved.
  const persisted={...head.summary,...Object.fromEntries(Object.entries(summary).filter(([,v])=>arrayOf(v)))};
  return new JournalWriter(root,state,persisted,head);
}
export function resetJournalCaches(){caches.clear();summaryCache.clear();pendingSummary.clear();}

// Build growing summary arrays lazily; persist maps only their new suffix.
export function summaryHistory(runtime,{compact:small=false,mapAction=x=>x}={}){
  const s=runtime.internal;let c=runtime._summaryHistory;
  if(!small||!c||c.actions!==s.actions||c.positions!==s.positions||c.n>s.actions.length||c.p>s.positions.length){c={actions:s.actions,positions:s.positions,n:0,p:0,visits:new Set(),novel:0,flags:[true]};runtime._summaryHistory=c;}
  while(c.n<s.actions.length){const a=s.actions[c.n++];c.novel+=Number(Boolean(a.novel));c.flags.push(Boolean(a.novel));for(const p of a.traversedPositions||[])if(p)c.visits.add(`${p.worldX},${p.worldY}`);}
  while(c.p<s.positions.length){const p=s.positions[c.p++];if(p)c.visits.add(`${p.worldX},${p.worldY}`);}
  const withTraversal = a => ({...mapAction(a), ...(Array.isArray(a.traversedPositions) ? {traversedPositions:a.traversedPositions} : {})});
  return{unique_cells:c.visits.size,novelty_rate:s.actionCount?c.novel/s.actionCount:1,
    positions:small?arrayView(s.positions):s.positions,novelty:small?arrayView(c.flags):c.flags,
    actions:small?arrayView(s.actions,withTraversal):s.actions.map(withTraversal)};
}
