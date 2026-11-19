import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedTimeline, compileRecordedReplay } from '../benchmarking/recorded-replay.mjs';
import { sampleTrack } from '../animations/v1/timeline.mjs';
import { unpackTimeline } from '../replays/v1/movie.mjs';
import { V2_BLOCK_CATALOG } from '../render/v1/voxel-world-v2.mjs';
import { createPlaybackServer } from '../benchmarking/playback-server.mjs';
const cell = (blockId, x, y = 1, z = 0) => ({ blockId, x, y, z });
const room = (objects, columnIndex = 0) => ({ fileName: `${columnIndex}.json`, position: [columnIndex ? 'I' : 'H', 'I'], columnIndex, rowIndex: 0, width: 8, height: 4, objects });
const makeWorld = rooms => ({ rooms, columns: rooms.map(r => r.position[0]), rows: ['I'], roomWidth: 8, roomHeight: 4,
  blocks: V2_BLOCK_CATALOG, blockDefinitions: new Map(V2_BLOCK_CATALOG.map(b => [b.id, b])) });
const frame = (objects, room = 'HxI') => ({ room, objects });
const player = timeline => timeline.tracks.find(t => t.block.roleId === 'player');

test('recorded poses use Replays easing, not stepped screenshots or simulated commands', () => {
  const world = makeWorld([room([cell('player', 2), cell('floor', 2)])]);
  const { timeline } = recordedTimeline(world, 'right', [frame(world.rooms[0].objects), frame([cell('player', 3), cell('floor', 2)])]);
  assert.equal(timeline.duration, 100);
  assert.equal(sampleTrack(player(timeline), 25).x, 2.125);
  assert.equal(sampleTrack(player(timeline), 50).x, 2.5);
  assert.equal(sampleTrack(player(timeline), 100).x, 3);
  assert.equal(sampleTrack(player(timeline), 25).x, 2.125, 'reverse seeks sample the same curve');
});

test('slides keep intermediate turns and disappearing fixtures keep independent identities', () => {
  const start = [cell('player', 1), cell('gem', 2), cell('gem', 5)];
  const world = makeWorld([room(start)]);
  const { timeline } = recordedTimeline(world, 'right', [frame(start), frame([cell('player', 2), cell('gem', 5)]), frame([cell('player', 3), cell('gem', 5)]), frame([cell('player', 3, 2), cell('gem', 5)])]);
  assert.equal(sampleTrack(player(timeline), 40).x, 2);
  assert.equal(sampleTrack(player(timeline), 80).x, 3);
  assert.equal(sampleTrack(player(timeline), timeline.duration).y, 2);
  const gems = timeline.tracks.filter(t => t.block.roleId === 'goal');
  assert.equal(sampleTrack(gems.find(t => t.object.x === 2), timeline.duration).opacity, 0);
  assert.equal(sampleTrack(gems.find(t => t.object.x === 5), timeline.duration).opacity, 1);
});

test('room crossings tween the player across the seam and restore departed boxes', () => {
  const a = room([cell('player', 6), cell('crate', 2)]), b = room([cell('player', 4)], 1);
  const world = makeWorld([a, b]);
  const { timeline } = recordedTimeline(world, 'right', [frame([cell('player', 7), cell('crate', 3)]), frame([cell('player', 0)], 'IxI')]);
  assert.equal(sampleTrack(player(timeline), 50).x, 7.5);
  assert.equal(sampleTrack(player(timeline), timeline.duration).x, 8);
  assert.deepEqual(timeline.camera[0].to, [8, 0]);
  const box = timeline.tracks.find(t => t.block.roleId === 'pushable');
  assert.equal(sampleTrack(box, 225).x, 2.5);
  assert.equal(sampleTrack(box, timeline.duration).x, 2);
});

test('undo/reset use recorded restoration states and fade an absent player back in', () => {
  const world = makeWorld([room([cell('player', 2), cell('crate', 3)])]);
  const { timeline } = recordedTimeline(world, 'undo', [frame([cell('crate', 5)]), frame([cell('player', 2), cell('crate', 3)])]);
  assert.equal(timeline.duration, 250);
  assert.equal(sampleTrack(player(timeline), 0).opacity, 0);
  assert.equal(sampleTrack(player(timeline), 250).opacity, 1);
  assert.equal(sampleTrack(timeline.tracks.find(t => t.block.roleId === 'pushable'), 125).x, 4);
});

test('compiled replay shares scenery and retains actual action indices for scrubbing', async () => {
  const world = makeWorld([room([cell('floor', 1), cell('player', 1)])]);
  const movie = await compileRecordedReplay(world, 3, async move => ({ action: { action: move ? 'right' : 'initial' }, frames: move
    ? [frame([cell('floor', 1), cell('player', move)]), frame([cell('floor', 1), cell('player', move + 1)])]
    : [frame(world.rooms[0].objects)] }));
  assert.equal(movie.clips.length, 4);
  assert.equal(movie.clips[2].move, 2);
  assert.equal(movie.layouts.length, 1);
  const timeline = unpackTimeline(movie, movie.clips[2], world);
  assert.equal(sampleTrack(player(timeline), 50).x, 2.5);
});

test('replay service only serves authenticated local read requests and propagates failures', async t => {
  let reads = 0;
  const {server} = createPlaybackServer(process.cwd(), {port: 0, replays: {movie: async () => {reads++; if(reads > 1)throw new Error('Frame failed integrity verification');return {movie:{clips:[]}};}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.close();server.closeAllConnections();});
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api/benchmark/playback/runs/run-2026-10-26T04-07-47-809Z-f728b0/movie`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, {method:'POST'})).status, 405);
  assert.equal((await fetch(url, {headers:{Origin:'https://example.com'}})).status, 403);
  assert.equal((await fetch(url.replace('/movie','/other'))).status, 404);
  const failure = await fetch(url);assert.equal(failure.status,400);assert.match((await failure.json()).error,/integrity/);
});

test('recorded camera turns retain their angles and sample the shortest arc when seeking', async () => {
  const {sampleAgentCamera, VISION_PITCHES} = await import('../benchmarking/ui/replay-camera.mjs');
  const objects = [cell('player', 1)], world = makeWorld([room(objects)]);
  const movie = await compileRecordedReplay(world, 2, async move => ({ action: {action: move ? 'camera right' : 'initial'}, frames: move
    ? [{...frame(objects),camera:{yaw:move === 1 ? 3 : 0,pitch:2}}, {...frame(objects),camera:{yaw:move === 1 ? 0 : 1,pitch:move === 1 ? 2 : 0}}]
    : [{...frame(objects),camera:{yaw:3,pitch:2}}] }));
  const clip = movie.clips[1];
  assert.equal(clip.duration,250,'a camera-only action has time to turn');
  assert.equal(sampleAgentCamera(clip,0).yaw,3*Math.PI/2);
  assert.equal(sampleAgentCamera(clip,125).yaw,7*Math.PI/4);
  assert.equal(sampleAgentCamera(clip,250).yaw,0);
  assert.equal(sampleAgentCamera(clip,125).yaw,7*Math.PI/4,'backward seeks have no camera history');
  assert.equal(sampleAgentCamera(movie.clips[2],250).pitch,VISION_PITCHES[0]);
  assert.equal(sampleAgentCamera(movie.clips[0],0).pitch,Math.PI/4);
});

test('room visibility hides context and clips crossing scenes without changing their animation', async () => {
  const { ReplayRoomVisibility } = await import('../benchmarking/ui/replay-room-visibility.mjs');
  const { Vector3 } = await import('../render/vendor/three.module.min.js');
  const world = makeWorld([room([cell('player',7)]),room([cell('player',0)],1)]);
  const {timeline} = recordedTimeline(world,'right',[frame([cell('player',7)]),frame([cell('player',0)],'IxI')]);
  const before = JSON.stringify(timeline);
  const renderer = {world,renderer:{clippingPlanes:[]},backgroundRoot:{visible:true},canvas:{dataset:{}}};
  const mask = new ReplayRoomVisibility(renderer),scene={timeline},clip={room:'0.json',to:'1.json',settledAt:100};
  mask.update(false,scene,{clip,local:0});
  assert.equal(renderer.backgroundRoot.visible,false);
  assert.equal(renderer.renderer.clippingPlanes.length,4);
  const inside=point=>renderer.renderer.clippingPlanes.every(plane=>plane.distanceToPoint(point)>=0);
  assert(inside(new Vector3(-4,1,0)));
  assert(!inside(new Vector3(4,1,0)),'destination scenery is hidden before crossing');
  mask.update(false,scene,{clip,local:100});
  assert(inside(new Vector3(4,1,0)));
  assert(!inside(new Vector3(-4,1,0)),'departed scenery is hidden after crossing');
  mask.update(false,scene,{clip,local:0});assert(inside(new Vector3(-4,1,0)),'backward scrub restores the visible room');
  mask.update(true,scene,{clip,local:100});assert.equal(renderer.backgroundRoot.visible,true);assert.equal(renderer.renderer.clippingPlanes.length,0);
  assert.equal(JSON.stringify(timeline),before,'visibility never rewrites curves or poses');
});

test('ASCII view uses recorded tick poses and camera while incremental movies preserve earlier clips', async () => {
  const {RecordedReplayBuilder}=await import('../benchmarking/recorded-replay.mjs');
  const {replayAscii}=await import('../benchmarking/ui/replay-ascii.mjs');
  const {renderAsciiFrameV1}=await import('../render-ascii/v1/ascii-scene.mjs');
  const objects=[cell('floor',1),cell('floor',2),cell('player',1)],world=makeWorld([room(objects)]),builder=new RecordedReplayBuilder(world);
  const first={...frame(objects),camera:{yaw:1,pitch:2}},last={...frame([cell('floor',1),cell('floor',2),cell('player',2)]),camera:{yaw:1,pitch:2}};
  builder.append(0,{action:{action:'initial'},frames:[first]});const snapshot=builder.movie();
  builder.append(1,{action:{action:'right'},frames:[first,last]});const movie=builder.movie(),clip=movie.clips[1];
  assert.equal(snapshot.clips.length,1,'previous snapshots do not grow under an active response');
  assert.equal(movie.clips[0],snapshot.clips[0],'append retains prior scene identities');
  const expected=(await renderAsciiFrameV1({...world.rooms[0],objects:last.objects},world.blocks,last.camera)).text;
  assert.equal((await replayAscii(movie,world,clip,clip.duration)).text,expected);
  const before=(await renderAsciiFrameV1({...world.rooms[0],objects:first.objects},world.blocks,first.camera)).text;
  assert.equal((await replayAscii(movie,world,clip,50)).text,before,'ASCII stays on discrete physics ticks');
});

test('text reconstruction verifies saved state hashes and never writes to the source run', async t => {
  const {mkdtemp,rm,readFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
  const {BenchmarkGameRuntime}=await import('../benchmarking/v1/runtime.mjs');const {createRunIntegrity}=await import('../benchmarking/v1/integrity.mjs');
  const {openAsciiReplay}=await import('../benchmarking/ascii-replay-source.mjs');
  const directory=await mkdtemp(path.join(tmpdir(),'mazebench-view-replay-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=path.resolve(import.meta.dirname,'..'),runtime=await BenchmarkGameRuntime.create(root,directory,{startRoom:'HxI',actionLimit:20});
  const metadata={start_room:'HxI',integrity:await createRunIntegrity(root,directory,{})};await runtime.persist();
  for(const action of ['right','camera right','left','undo','reset'])await runtime.apply(action);
  const files=['game-state.json','summary.json','checkpoint.json','records/history.jsonl'];const before=await Promise.all(files.map(file=>readFile(path.join(directory,file),'utf8')));
  const source=await openAsciiReplay(root,directory,metadata);
  for(let move=0;move<=5;move++)assert((await source.readMove(move)).frames.length);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(path.join(directory,file),'utf8'))),before);
  const invalid=await openAsciiReplay(root,directory,metadata);invalid.saved.actions[0].stateHash='wrong';
  await assert.rejects(()=>invalid.readMove(1),/differs from the saved state/);
  assert.deepEqual(await Promise.all(files.map(file=>readFile(path.join(directory,file),'utf8'))),before);
});

test('recorded fatal crossings follow the visit count from the original run', async () => {
  const start = frame([cell('player', 7)]), pit = frame([], 'IxI');
  const world = makeWorld([room(start.objects), room([cell('player', 4)], 1)]);
  for (const roomsVisited of [1, 2]) {
    const records = [
      {action:{action:'initial'}, frames:[start]},
      {action:{action:'right', died:true, roomsVisited}, frames:[start, pit]}
    ];
    const movie = await compileRecordedReplay(world, 1, async i => records[i]);
    assert.equal(movie.clips[1].to, '1.json');
    assert.equal(movie.visits.length, roomsVisited);
  }
});
