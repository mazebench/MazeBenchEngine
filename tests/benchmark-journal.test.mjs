import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,copyFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRunIntegrity,verifyCheckpoint} from '../benchmarking/v1/integrity.mjs';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';
import {IceBenchmarkRuntime} from '../ice-maze/v1/benchmark-runtime.mjs';
import {SlotskiBenchmarkRuntime} from '../slotski/v1/benchmark-runtime.mjs';
import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {createJournal,verifyJournal,readJournal,readJournalSummary,journalHead,resetJournalCaches} from '../benchmarking/storage/journal.mjs';
import {readJsonLinesTail} from '../benchmarking/storage/tail-jsonl.mjs';
import {historyResponse,mergeRunUpdate} from '../benchmarking/storage/history-delta.mjs';
const root=path.resolve(import.meta.dirname,'..');
async function fixture(Runtime=BenchmarkGameRuntime){const directory=await mkdtemp(path.join(os.tmpdir(),'maze-journal-test-'));await createRunIntegrity(root,directory,{model:'fixture',tools_enabled:false});const runtime=await Runtime.create(root,directory,{incremental:true,actionLimit:null});return{directory,runtime};}
const stable=value=>JSON.parse(JSON.stringify(value,(key,v)=>['createdAt','updatedAt','updated_at','at'].includes(key)?undefined:v));

test('journal reloads every move and preserves gameplay, undo, resets and summaries in every text world',async()=>{
  for(const[Runtime,sequence]of [[BenchmarkGameRuntime,['up','up','up','up','left','undo','reset','camera left','down']], [IceBenchmarkRuntime,['up','right','down','undo','reset','left']], [SlotskiBenchmarkRuntime,['CU','DL','undo','reset','HR']]]){
    const {directory,runtime}=await fixture(Runtime),legacy=await mkdtemp(path.join(os.tmpdir(),'maze-journal-parity-'));
    try{const comparison=await Runtime.create(root,legacy,{actionLimit:null});
      for(const action of sequence){await comparison.apply(action);await runtime.apply(action);verifyCheckpoint(directory);
        assert.deepEqual(stable(runtime.internal),stable(comparison.internal));
        assert.deepEqual(await readCheckpointJson(directory),runtime.internal);
        assert.deepEqual(await readCheckpointJson(directory,'summary.json'),runtime.summary());
        const reopened=await Runtime.open(root,directory);assert.deepEqual(reopened.internal,runtime.internal);
      }
      assert.match((await runtime.readRecord('moves.txt')).content,/undo/);assert((await runtime.readRecord('move_history/index.json')).content.includes('page_size'));
    }finally{await rm(directory,{recursive:true,force:true});await rm(legacy,{recursive:true,force:true});}
  }
});

test('save failures poison memory while reopening returns only the committed move',async()=>{
  const{directory,runtime}=await fixture();try{
    await runtime.apply('up');const before=await readFile(path.join(directory,'checkpoint.json'));const original=runtime.summary.bind(runtime);
    runtime.summary=options=>({...original(options),failure:{toJSON(){throw Error('disk/serialization fixture');}}});
    await assert.rejects(()=>runtime.apply('up'),/save failed/);assert.deepEqual(await readFile(path.join(directory,'checkpoint.json')),before);
    await assert.rejects(()=>runtime.apply('up'),/save failed/);const reopened=await BenchmarkGameRuntime.open(root,directory);assert.equal(reopened.internal.actionCount,1);await reopened.apply('down');verifyCheckpoint(directory);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('process death before or after the atomic commit cannot expose a half move',async()=>{
  for(const phase of ['artifacts','append','commit']){
    const{directory}=await fixture();try{
      const code=`import {BenchmarkGameRuntime} from ${JSON.stringify(pathToFileURL(path.join(root,'benchmarking/v1/runtime.mjs')).href)};
      const r=await BenchmarkGameRuntime.open(${JSON.stringify(root)},${JSON.stringify(directory)}),commit=r.journal.commit.bind(r.journal);
      r.journal.commit=(a,b,c,o)=>commit(a,b,c,{...o,onPhase:p=>{if(p===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});await r.apply('up');`;
      const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
      const result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});assert.equal(result.signal,'SIGKILL',stderr);
      resetJournalCaches();verifyCheckpoint(directory);const reopened=await BenchmarkGameRuntime.open(root,directory);
      assert.equal(reopened.internal.actionCount,phase==='commit'?1:0);assert.deepEqual(await readJournalSummary(directory),reopened.summary());
      await reopened.apply('left');verifyCheckpoint(directory);assert.deepEqual(await readJournal(directory),reopened.internal);
      assert.equal((await stat(path.join(directory,'journal',journalHead(directory).generation,'entries.jsonl'))).size,journalHead(directory).bytes);
    }finally{await rm(directory,{recursive:true,force:true});}
  }
});

test('tampering with head, markers, base, old entries, truncated journal or symlink is rejected',async()=>{
  const{directory,runtime}=await fixture();try{
    await runtime.apply('up');await runtime.apply('left');const head=journalHead(directory),prefix='journal/'+head.generation;
    for(const file of ['game-state.json','summary.json','display.json','checkpoint.json',prefix+'/base-state.json',prefix+'/base-summary.json',prefix+'/entries.jsonl']){
      const full=path.join(directory,file),original=await readFile(full);let changed=Buffer.from(original);
      if(file.endsWith('entries.jsonl'))changed[15]=changed[15]===97?98:97;else changed=Buffer.from('{}');
      await writeFile(full,changed);assert.throws(()=>verifyJournal(directory,{full:true}),undefined,file);await writeFile(full,original);resetJournalCaches();verifyJournal(directory,{full:true});
    }
    const log=path.join(directory,prefix,'entries.jsonl'),bytes=await readFile(log);await writeFile(log,bytes.subarray(0,bytes.length-2));assert.throws(()=>verifyCheckpoint(directory));await writeFile(log,bytes);
    const base=path.join(directory,prefix,'base-state.json'),original=await readFile(base),target=path.join(directory,'external.json');await writeFile(target,original);await rm(base);await symlink(target,base);assert.throws(()=>verifyCheckpoint(directory));await rm(base);await writeFile(base,original);resetJournalCaches();verifyCheckpoint(directory);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a stale second writer cannot overwrite an acknowledged move',async()=>{
  const{directory,runtime}=await fixture();try{const stale=await BenchmarkGameRuntime.open(root,directory);await runtime.apply('up');await assert.rejects(()=>stale.apply('left'),/Another writer/);assert.equal((await readCheckpointJson(directory)).actionCount,1);}finally{await rm(directory,{recursive:true,force:true});}
});

test('a dashboard summary remains on its captured checkpoint while another reader advances',async()=>{
  const{directory,runtime}=await fixture();try{
    await runtime.apply('up');const firstHead=journalHead(directory);
    const first=await readJournalSummary(directory,firstHead),original=structuredClone(first);
    await runtime.apply('left');const second=await readJournalSummary(directory);
    assert.equal(second.action_count,2);assert.equal(second.actions.length,2);
    assert.deepEqual(first,original);assert.equal(first.actions.length,1);
    const older=await readJournalSummary(directory,firstHead);assert.deepEqual(older,original);
    assert.equal(second.actions.length,2);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('per-move journal bytes do not grow with a 20000-entry undo/action history',async()=>{
  const lengths=[];
  for(const n of [10,20000]){
    const directory=await mkdtemp(path.join(os.tmpdir(),'maze-journal-size-'));
    try{await createRunIntegrity(root,directory,{});const state={actionCount:n,state:{x:1},history:Array.from({length:n},()=>({board:'x'.repeat(300)})),actions:Array.from({length:n},(_,index)=>({index,action:'up'})),positions:Array.from({length:n},()=>({x:1}))};
      const summary={action_count:n,actions:state.actions,positions:state.positions};const writer=await createJournal(directory,state,summary,{}),base=path.join(directory,'journal',writer.head.generation,'base-state.json'),before=await stat(base);
      state.actionCount++;state.state={x:2};state.history.push({board:'new'});state.actions.push({index:n,action:'right'});state.positions.push({x:2});summary.action_count++;
      await writer.commit(state,summary,{});lengths.push(writer.head.bytes);assert.equal((await stat(base)).mtimeMs,before.mtimeMs);assert.deepEqual(await readJournal(directory),state);
      state.history.pop();state.actionCount++;state.actions.push({index:n+1,action:'undo'});state.positions.push({x:1});summary.action_count++;
      await writer.commit(state,summary,{});assert.deepEqual(await readJournal(directory),state);
    }finally{await rm(directory,{recursive:true,force:true});}
  }
  assert(lengths.every(n=>n<2500),JSON.stringify(lengths));assert(Math.abs(lengths[0]-lengths[1])<100,JSON.stringify(lengths));
});

test('bounded event tails and history deltas preserve ordering and reset after rollback',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'maze-tail-'));try{const file=path.join(directory,'events.jsonl');await writeFile(file,Array.from({length:20000},(_,n)=>JSON.stringify({n,text:'🧊'.repeat(100)})+'\n').join('')+'{"partial":');const rows=await readJsonLinesTail(file,10,{maximumBytes:65536});assert.deepEqual(rows.map(r=>r.n),Array.from({length:10},(_,n)=>19990+n));}finally{await rm(directory,{recursive:true,force:true});}
  const base={id:'run',history_epoch:'a',actions:[1],positions:[2],novelty:[true]};const first=historyResponse(base);const next=historyResponse({...base,actions:[1,3],positions:[2,4],novelty:[true,false]},JSON.stringify(first.history_cursor));assert.deepEqual(next.actions,[3]);assert.deepEqual(mergeRunUpdate(first,next).actions,[1,3]);
  assert.equal(historyResponse({...base,history_epoch:'b'},next.history_cursor).history_delta,null);assert.equal(historyResponse(base,'bad json').history_delta,null);
});


test('overlapping save and resume requests cannot start two writers',async()=>{
  const{directory,runtime}=await fixture();try{
    const second=await BenchmarkGameRuntime.open(root,directory);
    const results=await Promise.allSettled([runtime.apply('up'),second.apply('left')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await readCheckpointJson(directory)).actionCount,1);verifyCheckpoint(directory);
    const r=await BenchmarkGameRuntime.open(root,directory);const a=r.internal.actions[0];
    await r.readRecord(a.animation.index_record);
  }finally{await rm(directory,{recursive:true,force:true});}
  const{resumeExclusively}=await import('../benchmarking/storage/resume-lock.mjs');
  let release,calls=0;const wait=new Promise(r=>release=r),owner={async resume(){calls++;await wait;return 'running';}};
  const first=resumeExclusively(owner,'run');await assert.rejects(()=>resumeExclusively(owner,'run'),/already resuming/);release();assert.equal(await first,'running');assert.equal(calls,1);
});
