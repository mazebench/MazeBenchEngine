import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {MazeBenchEngineV1, instantiateMazeBenchEngineV1} from '../engine/v1/engine.mjs';
import {V2_BLOCK_CATALOG, decodeVoxelRoom} from '../render/v1/voxel-world-v2.mjs';
import {ConnectedWorldSessionV1} from '../play/v1/connected-world-session.mjs';
import {createEditorSolverSessionV1} from '../editor/v1/native-solver-runtime.mjs';
import {createNativeRoomSearch} from '../solutions/v1/native-search.mjs';
import {runRandomAgentV1} from '../world-solver/v1/random-agent.mjs';
import {runRoomBfsV1} from '../world-solver/v1/room-bfs.mjs';

const blocks = V2_BLOCK_CATALOG;
const binaries = ['engine/v1/voxel_physics.wasm', 'world-solver/v1/editor-solver.wasm',
  'world-solver/v1/random-agent.wasm', 'solutions/v1/solutions-solver.wasm'];
const engineAt = async path => instantiateMazeBenchEngineV1(await readFile(new URL(`../${path}`,import.meta.url)));
const actorTrace = result => result.frames.map(frame => frame.objects.filter(o =>
  ['player','weightless-slope','puncher'].includes(o.blockId)));

function punchedScene(height, treeId='t4') {
  return {width:10,height:10,objects:[
    {x:3,y:5,z:height,blockId:'player'},
    {x:4,y:4,z:height,blockId:'weightless-slope',orientation:'up',groupId:17},
    {x:3,y:4,z:height,blockId:'puncher',orientation:'right'},
    {x:7,y:4,z:0,blockId:treeId},
    ...Array.from({length:height+1},(_,z)=>({x:2,y:4,z,blockId:'wall'})),
    ...[{x:3,y:5},{x:3,y:4},{x:4,y:4}].flatMap(({x,y})=>
      Array.from({length:height},(_,z)=>({x,y,z,blockId:'wall'}))),
    ...Array.from({length:5},(_,z)=>({x:9,y:4,z,blockId:'wall'})),
    ...Array.from({length:100},(_,i)=>({x:i%10,y:Math.floor(i/10),z:0,blockId:'floor'}))
  ]};
}
const stackedWalls = room => ({...room,objects:room.objects.flatMap(o=>
  o.blockId==='t4' ? [0,1,2].map(dz=>({x:o.x,y:o.y,z:o.z+dz,blockId:'wall'})) : [o])});

for (const binary of binaries) {
  test(`${binary}: trees stop a punched player and slope at all three wall heights`,async()=>{
    const engine=await engineAt(binary);
    for(const height of [0,1,2,3]) {
      const tree=punchedScene(height);
      const expected=await engine.simulateCommand(stackedWalls(tree),'up',blocks);
      const actual=await engine.simulateCommand(tree,'up',blocks);
      assert.deepEqual(actorTrace(actual),actorTrace(expected),`tree collision at height ${height}`);
      assert.equal(actual.cycle,expected.cycle);
      assert.equal(actual.final.objects.length,tree.objects.length,'physics-only wall voxels must not leak into room state');
      assert.deepEqual(actual.final.objects[3],tree.objects[3],'tree remains one authored object');
    }
  });
}

test('all seven tree assets occupy three stacked collision voxels',async()=>{
  const engine=await engineAt(binaries[0]);
  for(const block of blocks.filter(b=>b.visual?.modelType==='tree')) {
    const tree=punchedScene(2,block.id);
    const actual=await engine.simulateCommand(tree,'up',blocks);
    const reference=stackedWalls(punchedScene(2));
    assert.deepEqual(actorTrace(actual),actorTrace(await engine.simulateCommand(reference,'up',blocks)),block.id);
  }
});

test('connected-room play preserves tree collision height and authored object count',async()=>{
  const engine=await engineAt(binaries[0]);
  const room={...punchedScene(1),fileName:'tree.json',position:['H','I'],columnIndex:0,rowIndex:0};
  const connected=new ConnectedWorldSessionV1(engine,blocks,[room]);
  const actual=await connected.simulateCommand(engine.createState(room),room,'up');
  const expected=await engine.simulateCommand(stackedWalls(room),'up',blocks);
  assert.deepEqual(actorTrace({frames:actual.frames.map(f=>f.state||f)}),actorTrace(expected));
  assert.equal(actual.final.objects.length,room.objects.length);
});

function treeBarrierWorld() {
  const room={fileName:'tree.json',position:['H','I'],columnIndex:0,rowIndex:0,width:5,height:3,objects:[
    {x:0,y:1,z:1,blockId:'player'}, {x:4,y:1,z:1,blockId:'gem'},
    {x:2,y:1,z:0,blockId:'t4'},
    ...[0,1,3,4].map(x=>({x,y:1,z:0,blockId:'wall'})),
    ...[0,2].flatMap(y=>Array.from({length:15},(_,i)=>({x:i%5,y,z:Math.floor(i/5),blockId:'wall'}))),
    ...Array.from({length:15},(_,i)=>({x:i%5,y:Math.floor(i/5),z:0,blockId:'floor'}))
  ]};
  return {columns:['H'],rows:['I'],roomWidth:5,roomHeight:3,blocks,rooms:[room]};
}

test('canonical gem and edge search cannot route through the upper tree trunk',async()=>{
  const engine=await engineAt(binaries[0]),room=treeBarrierWorld().rooms[0];
  assert.equal(engine.solve(room,blocks).status,'unsolved');
  assert.ok(engine.findEdges(room,blocks).edges.every(edge=>edge.solution.filter(d=>d==='right').length<2));
});

test('editor and Solutions native search use the full tree collision volume',async()=>{
  const room=treeBarrierWorld().rooms[0];
  const editor=await engineAt(binaries[1]);
  const session=createEditorSolverSessionV1(editor,room,blocks);
  let result=session.snapshot();
  while(result.statusCode===0) result=session.runChunk(100);
  assert.equal(result.status,'unsolved');
  const solutions=await engineAt(binaries[3]);
  const model={blocks,role:o=>blocks.find(b=>b.id===o.blockId)?.roleId};
  const native=createNativeRoomSearch(model,solutions,{room:room.fileName,state:room},
    {kind:'location',room:room.fileName,x:4,y:1,z:1});
  let planned=native.snapshot();
  while(planned.status==='searching') planned=native.run(100);
  assert.equal(planned.status,'exhausted');
});

test('random world batches and each room search mode retain the upper tree blocker',async()=>{
  const engine=await engineAt(binaries[2]);
  assert.equal((await runRandomAgentV1(engine,treeBarrierWorld(),{maximumActions:1000,seed:1})).gems,0);
  for(const metaStrategy of ['breadth','depth','super-astar','row-astar']) {
    const visited=new Set();
    const result=await runRoomBfsV1(engine,treeBarrierWorld(),{metaStrategy,
      onProgress:message=>message.visitedCells?.forEach(cell=>visited.add(cell))});
    assert.equal(result.gems,0,metaStrategy);
    assert.ok(!visited.has(9),`${metaStrategy} cannot visit the far side of the tree`);
  }
});


test('AxK stops the elevated punch at its tree instead of passing through the upper trunk',async()=>{
  const engine=await engineAt(binaries[0]);
  const room=decodeVoxelRoom(JSON.parse(await readFile(new URL('./fixtures/axk-tree-punch.json',import.meta.url),'utf8')));
  const actual=await engine.simulateCommand(room,'down',blocks);
  assert.equal(actual.cycle,null);
  assert.deepEqual(actual.frames.map(f=>{
    const {x,y,z}=f.objects.find(o=>o.blockId==='player');return [x,y,z];
  }),[[3,7,1],[4,7,1],[5,7,1],[6,7,1],[7,7,1],[7,7,0]]);
  assert.equal(actual.final.objects.filter(o=>o.blockId==='t4').length,1);
});

test('expanded collision count preserves authored indices and enforces native capacities',async()=>{
  const room=treeBarrierWorld().rooms[0],engine=await engineAt(binaries[0]);
  const before=structuredClone(room),resident=engine.writeState(room,blocks);
  assert.equal(resident.count,room.objects.length+2);
  assert.deepEqual(room,before);
  const treeIndex=room.objects.findIndex(o=>o.blockId==='t4');
  for(const [index,z] of [[treeIndex,1],[room.objects.length,2],[room.objects.length+1,3]]) {
    assert.deepEqual(Array.from(resident.buffer.slice(index*5,index*5+4)),
      [2,1,z,engine.roleCode('solid')|0]);
  }
  const tiny=new MazeBenchEngineV1({physics_abi_version:()=>4,voxel_stride:()=>5,
    voxel_capacity:()=>room.objects.length,search_voxel_capacity:()=>room.objects.length});
  assert.throws(()=>tiny.writeState(room,blocks),/supports at most/);
  assert.throws(()=>tiny.solve(room,blocks),/search supports at most/);
  assert.throws(()=>tiny.findEdges(room,blocks),/search supports at most/);
});

test('native world uploads and Row A* edge restoration preserve expanded tree cells across rooms',async()=>{
  const world=treeBarrierWorld(),destination={...world.rooms[0],fileName:'next.json',position:['I','I'],columnIndex:1};
  const source={...world.rooms[0],objects:world.rooms[0].objects.filter(o=>o.blockId!=='gem'&&o.blockId!=='t4'&&
    !(o.blockId==='wall'&&o.x===1&&o.y===2))};
  source.objects.push({x:2,y:1,z:0,blockId:'wall'},{x:1,y:2,z:0,blockId:'t4'});
  world.columns=['H','I'];world.rooms=[source,destination];
  const engine=await engineAt(binaries[2]);
  const random=await runRandomAgentV1(engine,world,{maximumActions:1000,seed:1});
  assert.equal(random.rooms,2);assert.equal(random.gems,0);
  const result=await runRoomBfsV1(engine,world,{metaStrategy:'row-astar'});
  assert.equal(result.rooms,2);assert.equal(result.gems,0);
});
