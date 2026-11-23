import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Pass a saved WASM path to compare identical workloads before/after a change.
const wasm=process.argv[2]??new URL('../../apps/web/public/physics/voxel_physics.wasm',import.meta.url);
const {instance:{exports:engine}}=await WebAssembly.instantiate(await readFile(wasm),{});
const dxl=JSON.parse(await readFile(new URL('../tests/fixtures/dxl-search.json',import.meta.url),'utf8'));
const arena={width:16,height:16,voxels:[
  [1,1,1,'player',-1], [14,14,1,'goal',-1], [8,8,1,'puncher',2],
  [7,8,1,'solid',-1], [15,8,1,'solid',-1],
  ...Array.from({length:256},(_,i)=>[i%16,Math.floor(i/16),0,'floor',-1])
]};
const roles=new Map();
function role(name){
  if(!roles.has(name)){
    const bytes=new TextEncoder().encode(name);
    new Uint8Array(engine.memory.buffer,engine.role_buffer(),bytes.length).set(bytes);
    roles.set(name,engine.role_code(bytes.length));
  }
  return roles.get(name);
}
for(const [name,scene,budget] of [['puncher-arena',arena,10000],['DxL',dxl,500]]){
  const buffer=new Int32Array(engine.memory.buffer,engine.voxel_buffer(),scene.voxels.length*5);
  const initial=Int32Array.from(scene.voxels.flatMap(([x,y,z,r,id])=>[x,y,z,role(r),id]));
  function solve(){
    buffer.set(initial);const started=performance.now();
    const status=engine.search_solve(scene.voxels.length,scene.width,scene.height,budget);
    return {ms:performance.now()-started,status,expanded:engine.search_expanded(),local:engine.search_local_expanded(),
      commands:engine.search_command_transitions(),full:engine.search_full_physics_transitions(),
      actions:Array.from({length:engine.search_solution_length()},(_,i)=>engine.search_solution_step(i))};
  }
  const expected=solve();
  if(expected.status===1){
    buffer.set(initial);
    for(const direction of expected.actions)assert.equal(engine.simulate_turn(scene.voxels.length,scene.width,scene.height,direction),0);
    for(const [i,v]of scene.voxels.entries())if(v[3]==='goal')assert.equal(buffer[i*5],-1,'solution must collect every gem');
  }
  const samples=[];
  for(let sample=0;sample<5;sample++){
    let ms=0,runs=0;
    do{
      const result=solve();ms+=result.ms;runs++;
      assert.equal(result.status,expected.status);assert.equal(result.commands,expected.commands);assert.deepEqual(result.actions,expected.actions);
    }while(ms<250);
    samples.push(ms/runs);
  }
  const medianMs=samples.sort((a,b)=>a-b)[2];
  console.log(JSON.stringify({name,status:expected.status,medianMs:Number(medianMs.toFixed(3)),commands:expected.commands,
    commandsPerSecond:Math.round(expected.commands*1000/medianMs),fullPhysicsCommands:expected.full,
    globalStates:expected.expanded,localStates:expected.local,moves:expected.actions.length}));
}
