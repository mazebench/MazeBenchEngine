import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LegacyArchive, videoRange } from '../benchmarking/legacy-archive.mjs';
import { createPlaybackServer } from '../benchmarking/playback-server.mjs';

const id = '2026-07-12T01-02-03-456-aabbcc', other = '2026-07-13T01-02-03-456-aabbcc';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mazebench-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordsRoot = path.join(root, 'records'), importsRoot = path.join(root, 'imports'), evidenceFile = path.join(root,'evidence.json');
  const directory = path.join(recordsRoot,id); await mkdir(directory,{recursive:true});await mkdir(importsRoot);
  const imported = { id:'import-abc-'+id,source:{run_id:id},model:'gpt-test',observation_mode:'ascii',action_count:2 };
  await writeFile(path.join(importsRoot,'index.json'),JSON.stringify({runs:[imported]}));
  await writeFile(path.join(importsRoot,imported.id+'.json'),JSON.stringify({heatmap:{points:[{worldX:1,worldY:2,count:3}]},action_count:2}));
  await writeFile(path.join(directory,'run.json'),JSON.stringify({status:'paused',secret:'must not be returned'}));
  await writeFile(path.join(directory,'initial-status.json'),JSON.stringify({level:'@初',current_room:'level_HxI',action_count:0}));
  const actions = [{turn:1,command_text:'up',status:{level:'A\nB'}},{turn:2,status:{json_observation:{objects:['gem']}}}].map(JSON.stringify).join('\n');
  await writeFile(path.join(directory,'actions.jsonl'),actions);
  await writeFile(path.join(directory,'maze_replay.mp4'),'0123456789');
  await writeFile(evidenceFile,JSON.stringify({runs:[{id,initial_state_candidates:['v1.0.2','v1.0.3'],exact_version:null,recorded_video:true}]}));
  return {root,recordsRoot,directory,archive:new LegacyArchive(root,{recordsRoot,importsRoot,evidenceFile}),actions};
}

test('archive preserves original observations, pages UTF-8 frames, and never guesses an exact version',async t=>{
  const f=await fixture(t),{runs}=await f.archive.list();
  assert.equal(runs[0].version,'v1.0.?');
  const detail=await f.archive.detail(id);assert.equal(detail.frame_count,3);assert.equal(detail.recorded_video,true);assert.equal(detail.secret,undefined);
  const frames=await f.archive.frames(id,0,2);assert.equal(frames.frames[0].ascii,'@初');assert.equal(frames.frames[1].ascii,'A\nB');
  assert.deepEqual((await f.archive.frames(id,2,1)).frames[0].observation,{objects:['gem']});
  assert.deepEqual((await f.archive.frames(id,3,1)).frames,[]);
  assert.equal((await f.archive.heatmap(id)).heatmap.points[0].count,3);
  assert.equal(await readFile(path.join(f.directory,'actions.jsonl'),'utf8'),f.actions);
  await assert.rejects(()=>f.archive.frames(id,-1,20),/Invalid frame range/);
  await assert.rejects(()=>f.archive.frames(id,0,10000),/Invalid frame range/);
  await assert.rejects(()=>f.archive.file('../'+id,'run.json'),/Unknown archive/);
  await assert.rejects(()=>f.archive.file(id,'auth.json'),/Unknown archive/);
  await symlink(f.directory,path.join(f.recordsRoot,other));
  await assert.rejects(()=>f.archive.file(other,'run.json'),/symlinks/);
});

test('archive HTTP is read-only, origin restricted, and supports video seeking with ranges',async t=>{
  const f=await fixture(t);
  const {server}=createPlaybackServer(f.root,{port:0,archive:f.archive,replays:{},refreshPricing:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.close();server.closeAllConnections();});
  const base=`http://127.0.0.1:${server.address().port}/api/benchmark/archive/runs`;
  assert.equal((await fetch(base)).status,200);
  assert.equal((await fetch(base,{method:'POST'})).status,405);
  assert.equal((await fetch(base,{headers:{Origin:'https://evil.example'}})).status,403);
  const response=await fetch(`${base}/${id}/video`,{headers:{Range:'bytes=3-6',Origin:'http://localhost:8080'}});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 3-6/10');assert.equal(await response.text(),'3456');
  assert.equal(response.headers.get('access-control-allow-origin'),'http://localhost:8080');
  const bad=await fetch(`${base}/${id}/video`,{headers:{Range:'bytes=999-'}});assert.equal(bad.status,416);
  assert.equal((await fetch(`${base}/${id}/delete`)).status,404);
  assert.equal((await fetch(`${base}/${id}/frames?from=1&limit=1`).then(r=>r.json())).frames[0].action,1);
});

test('video ranges accept suffix/open-ended requests and reject malformed or unsatisfiable ranges',()=>{
  assert.deepEqual(videoRange('bytes=-4',10),{start:6,end:9,partial:true});
  assert.deepEqual(videoRange('bytes=4-',10),{start:4,end:9,partial:true});
  assert.deepEqual(videoRange('bytes=0-99',10),{start:0,end:9,partial:true});
  for(const range of ['bytes=10-','bytes=5-3','bytes=0-1,5-6','bytes=-0','bad'])assert.throws(()=>videoRange(range,10));
});
