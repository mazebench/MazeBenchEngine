import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {sliceReplayChunk,appendReplayChunk,replayBufferTime} from '../benchmarking/replay-chunks.mjs';
import {PlaybackReplay} from '../benchmarking/playback-replay.mjs';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';
import {createRunIntegrity} from '../benchmarking/v1/integrity.mjs';
import {verifyJournal} from '../benchmarking/storage/journal.mjs';
import {readAsciiReplayHistory} from '../benchmarking/ascii-replay-source.mjs';
import {createPlaybackServer} from '../benchmarking/playback-server.mjs';

test('buffer chunks assemble without duplicate clips, preserve geometry IDs, and reset on a new history',()=>{
  const movie={startRoom:'a',duration:650,clips:[{move:0,start:0,duration:100},{move:1,start:100,duration:250},{move:2,start:350,duration:300}],
    templates:[{id:0},{id:1}],layouts:[[0],[1]],visits:[{at:0},{at:350}],gems:[{at:600}]};
  const value={epoch:'first',action_count:2,total_action_count:2,world:{},movie};
  const first=sliceReplayChunk(value,{limit:2});assert.equal(first.complete,false);assert.equal(first.action_count,1);assert.equal(first.movie.duration,350);
  assert.deepEqual(first.movie.gems,[]);
  const next=sliceReplayChunk(value,{epoch:'first',after:1,templates:2,layouts:2,limit:2});
  assert.equal(next.world,undefined);assert.equal(next.complete,true);assert.deepEqual(next.movie.templates,[]);assert.deepEqual(next.movie.layouts,[]);
  const assembled=appendReplayChunk(first.movie,'first',next);assert.deepEqual(assembled,movie);
  assert.equal(replayBufferTime(assembled,1.5),225);assert.equal(replayBufferTime(assembled,3),650);
  assert.throws(()=>appendReplayChunk(first.movie,'wrong',next),/buffer changed/);
  assert.equal(sliceReplayChunk({...value,epoch:'replacement'},{epoch:'first',after:1,limit:2}).from,0);
});

test('signed incremental replay handles undo and new moves without writing run files',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mazebench-buffer-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.resolve(import.meta.dirname,'..'),runtime=await BenchmarkGameRuntime.create(root,directory,{startRoom:'HxI',actionLimit:20});
  const metadata={start_room:'HxI',observation_mode:'ascii',integrity:await createRunIntegrity(root,directory,{})};
  await writeFile(path.join(directory,'run.json'),JSON.stringify(metadata));await runtime.persist();await runtime.enableIncremental();
  for(const action of ['right','camera right','left','undo','reset','camera up','right'])await runtime.apply(action);
  const previous = await readAsciiReplayHistory(directory);
  await runtime.apply('left');
  const current = await readAsciiReplayHistory(directory);
  assert.equal(previous.actions.length,7);
  assert.deepEqual(current.actions,runtime.internal.actions);
  const journal = verifyJournal(directory);
  const files=['game-state.json','summary.json','checkpoint.json',`journal/${journal.generation}/entries.jsonl`];
  const before=await Promise.all(files.map(file=>readFile(path.join(directory,file),'utf8')));
  const replays=new PlaybackReplay(root);t.after(()=>replays.close());
  let assembled=null,epoch,after=-1,rounds=0;
  do{
    const part=await replays.chunk(directory,{epoch,after,templates:assembled?.templates.length||0,layouts:assembled?.layouts.length||0,limit:2});
    assert(part.action_count-after<=2);assert.equal(part.total_action_count,8);
    if(!assembled){assert.equal(part.complete,false);assert(part.movie.clips.length>0);assert(part.movie.duration>0);}
    assembled=appendReplayChunk(assembled,epoch,part);epoch=part.epoch;after=part.action_count;rounds++;
    if(part.complete)break;
    assert(rounds<6);
  }while(true);
  assert.equal(rounds,5);assert.equal(assembled.clips.length,9);
  assert.deepEqual(assembled,(await replays.movie(directory)).movie);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(path.join(directory,file),'utf8'))),before);
});

test('buffer route is read-only and passes cursor data without weakening the local request guard',async t=>{
  let cursor;
  const {server}=createPlaybackServer(process.cwd(),{port:0,replays:{chunk:async(_directory,value)=>{cursor=value;return {complete:false,action_count:31,total_action_count:100};}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.close();server.closeAllConnections();});
  const url=`http://127.0.0.1:${server.address().port}/api/benchmark/playback/runs/run-2026-10-26T04-07-47-809Z-f728b0/chunk?after=15&epoch=abc&templates=2&layouts=3&limit=16`;
  const response=await fetch(url);assert.equal(response.status,200);assert.equal((await response.json()).complete,false);assert.equal(cursor.after,'15');assert.equal(cursor.epoch,'abc');
  assert.equal((await fetch(url,{method:'POST'})).status,405);assert.equal((await fetch(url,{headers:{Origin:'https://example.com'}})).status,403);
});
