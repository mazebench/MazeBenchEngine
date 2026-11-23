import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bytes=await readFile(new URL('../../apps/web/public/physics/voxel_physics.wasm',import.meta.url));
const dynamic=new Set(['player','puncher','pushable','weightless-pushable','floating-floor']);
const floor=()=>Array.from({length:64},(_,i)=>[i%8,Math.floor(i/8),0,'floor',-1]);
const arena=()=>[[1,1,1,'player',-1],[3,3,1,'puncher',2],[2,3,1,'solid',-1],[7,3,1,'solid',-1],[6,3,1,'goal',-1],...floor()];

async function harness(voxels,width=8,height=8){
  const {instance:{exports:e}}=await WebAssembly.instantiate(bytes,{});
  const {instance:{exports:reference}}=await WebAssembly.instantiate(bytes,{});
  const ordered=voxels.toSorted((a,b)=>Number(dynamic.has(b[3]))-Number(dynamic.has(a[3])));
  const dynamicCount=ordered.filter(v=>dynamic.has(v[3])).length;
  const initial=Int32Array.from(ordered.flatMap(([x,y,z,role,id])=>{
    const name=new TextEncoder().encode(role);
    new Uint8Array(e.memory.buffer,e.role_buffer(),name.length).set(name);
    return [x,y,z,e.role_code(name.length),id];
  }));
  const buffer=new Int32Array(e.memory.buffer,e.voxel_buffer(),initial.length);
  const referenceBuffer=new Int32Array(reference.memory.buffer,reference.voxel_buffer(),initial.length);
  const prepare=state=>{
    buffer.set(state);
    assert.equal(e.search_prepare_scene(ordered.length,width,height,dynamicCount),1);
    assert.equal(e.search_prepare_quiescent_snapshot(ordered.length,width,height),1);
  };
  return {initial,trace(state,direction){
    prepare(state);
    referenceBuffer.set(state);
    const trace=(engine,view)=>{
      engine.reset_command();
      const frames=[];
      for(let tick=0;tick<1000;tick++){
        const result=engine.step_command_tick(ordered.length,width,height,direction);
        assert(result>=0);
        frames.push({tick:engine.command_tick(),state:Array.from(view),
          start:engine.command_cycle_start_tick(),repeat:engine.command_cycle_repeat_tick()});
        if(result===0)return frames;
      }
      assert.fail('command did not terminate');
    };
    const expected=trace(reference,referenceBuffer),actual=trace(e,buffer);
    assert.deepEqual(actual,expected,'prepared cycle hashing must preserve every frame and rollback tick');
    return actual;
  },check(state,direction){
    prepare(state);
    const handled=e.search_try_passive_quiescent_turn(ordered.length,width,height,direction),fast=buffer.slice();
    if(handled===0)assert.deepEqual(fast,state,'declining the fast path must leave every voxel unchanged');
    referenceBuffer.set(state);reference.reset_command();
    assert.equal(reference.simulate_turn(ordered.length,width,height,direction),0);
    const full=referenceBuffer.slice();
    if(handled===1)assert.deepEqual(fast,full,'fast and full physics must agree on coordinates, roles, and mechanism state');
    return {handled,state:full};
  }};
}

for(let rotation=0;rotation<4;rotation++)test(`passive puncher search matches full physics in all directions (rotation ${rotation})`,async()=>{
  const scene=arena().map(v=>{
    const out=[...v];for(let i=0;i<rotation;i++){[out[0],out[1]]=[7-out[1],out[0]];}
    if(out[3]==='puncher')out[4]=((1+rotation)%4)*2;
    return out;
  });
  const h=await harness(scene);let state=h.initial,handled=0;
  // Every branch from every reached board is checked; deterministic walking
  // includes resting beside and on the fixture, not just a single solution.
  let random=17;
  for(let step=0;step<100;step++){
    const outcomes=[];
    for(let d=0;d<4;d++){const r=h.check(state,d);outcomes.push(r.state);handled+=r.handled===1;}
    random=(Math.imul(random,1664525)+1013904223)>>>0;state=outcomes[(random>>>16)%4];
  }
  assert(handled>200,`ordinary walks should use the fast path (${handled})`);
  const contact=state.slice();contact[0]=scene.find(v=>v[3]==='puncher')[0];contact[1]=scene.find(v=>v[3]==='puncher')[1];contact[2]=1;
  for(let d=0;d<4;d++)assert.equal(h.check(contact,d).handled,0,'initial contact must use full physics');
});

test('Ice crossing and falling through a puncher decline before writing the scene',async()=>{
  const sliding=arena();sliding[0]=[3,6,1,'player',-1];
  for(const v of sliding)if(v[3]==='floor'&&v[0]===3)v[3]='ice';
  let h=await harness(sliding);assert.equal(h.check(h.initial,0).handled,0);
  const falling=arena();falling[0]=[3,4,3,'player',-1];falling.push([3,4,2,'ice',-1]);
  h=await harness(falling);assert.equal(h.check(h.initial,0).handled,0);
});

test('sprung, carried, unsupported and body-contact punchers retain the full kernel',async()=>{
  for(const kind of ['sprung','carried','unsupported','body-contact']){
    const scene=arena();
    if(kind==='sprung')scene[1][4]=3;
    if(kind==='carried')scene[2][3]='pushable';
    if(kind==='unsupported')scene.splice(2,1);
    if(kind==='body-contact')scene.push([3,3,1,'pushable',-1]);
    const h=await harness(scene);
    for(let d=0;d<4;d++)assert.equal(h.check(h.initial,d).handled,0,kind);
  }
});

test('DxL reached states agree with independent unprepared command physics',async()=>{
  const {voxels,width,height}=JSON.parse(await readFile(new URL('./fixtures/dxl-search.json',import.meta.url),'utf8'));
  const h=await harness(voxels,width,height),states=[h.initial],seen=new Set([h.initial.join(',')]);
  let handled=0;
  for(let head=0;head<Math.min(states.length,12000);head++){
    for(let direction=0;direction<4;direction++){
      const r=h.check(states[head],direction);handled+=r.handled===1;
      const key=r.state.join(',');if(r.state[0]>=0&&!seen.has(key)){seen.add(key);states.push(r.state);}
    }
  }
  assert(handled>1000,`unrelated mechanisms should not disable ordinary walking (${handled})`);
});

test('remote ramp bodies and nearby ramps or Floating Floors use exact physics',async()=>{
  for(const kind of ['remote-rider','near-ramp','floating-support','floating-push']){
    const scene=arena();
    if(kind==='remote-rider')scene.push([5,5,1,'ice-slope-up',-1],[5,5,2,'weightless-pushable',12]);
    if(kind==='near-ramp')scene.push([1,0,1,'ice-slope-up',-1]);
    if(kind==='floating-support'){scene[0]=[1,1,2,'player',-1];scene.push([1,1,1,'solid',-1],[1,0,1,'floating-floor',-1]);}
    if(kind==='floating-push')scene.push([1,0,1,'floating-floor',-1]);
    const h=await harness(scene);
    assert.equal(h.check(h.initial,0).handled,0,kind);
  }
});

for(const gem of [false,true])test(`prepared puncher cycles preserve exact tick traces and rollback (gem=${gem})`,async()=>{
  const scene=[[1,4,1,'player',-1],[1,3,1,'puncher',2],[6,3,1,'puncher',6],
    [0,3,1,'solid',-1],[7,3,1,'solid',-1],...floor()];
  if(gem)scene.push([4,3,1,'goal',-1]);
  const h=await harness(scene);
  const frames=h.trace(h.initial,0);
  assert(frames.at(-1).repeat>0,'opposed punchers must produce a detected cycle');
  assert.deepEqual(frames.at(-1).state,Array.from(h.initial),'cycle rollback restores the entire starting board');
});
