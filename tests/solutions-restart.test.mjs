import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { SolutionRestartController } from '../solutions/v1/restart.mjs';
import { MoveSequencePlayer, parseMoveSequence } from '../ui/move-sequence.mjs';

function fixture() {
  const projects=new Map([['HxI',{routes:[1,2]}],['JxK',{routes:[3,4]}]]),events=[];
  let active='HxI';
  const controller=new SolutionRestartController({
    stop:()=>events.push('stop verification'),
    remove:async room=>{events.push(`delete ${room}`);projects.delete(room);},
    select:async room=>{events.push(`select ${room}`);active=room;},
    reload:()=>events.push('reload')
  });
  return {controller,projects,events,get active(){return active;}};
}

test('restart stops verification immediately and removes the selected starting room only',async()=>{
  const f=fixture();
  const restart=f.controller.restart('JxK');
  assert.deepEqual(f.events,['stop verification']);
  assert.equal(f.controller.stopped,true);
  await restart;
  assert.deepEqual(f.events,['stop verification','delete JxK','select JxK','reload']);
  assert.equal(f.active,'JxK');assert.equal(f.projects.has('JxK'),false);
  assert.deepEqual(f.projects.get('HxI'),{routes:[1,2]});
});

test('in-flight saves settle before deletion and late replies cannot recreate removed routes',async()=>{
  const f=fixture();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const save=f.controller.save(async()=>{await gate;f.events.push('save old routes');f.projects.set('JxK',{routes:[1,2,3,4]});});
  const restart=f.controller.restart('JxK');
  await Promise.resolve();
  assert.deepEqual(f.events,['stop verification']);
  await f.controller.save(()=>{throw new Error('A late reply must never save.');});
  release();await save;await restart;
  assert.deepEqual(f.events,['stop verification','save old routes','delete JxK','select JxK','reload']);
  assert.equal(f.projects.has('JxK'),false);
});

test('a failed old save does not prevent deletion or change the chosen starting room',async()=>{
  const f=fixture();let reject;
  const gate=new Promise((_,fail)=>{reject=fail;});
  const save=f.controller.save(()=>gate);
  const rejected=assert.rejects(save,/storage failed/);
  const restart=f.controller.restart('JxK');
  reject(new Error('storage failed'));
  await rejected;await restart;
  assert.equal(f.active,'JxK');assert.equal(f.projects.has('JxK'),false);
  assert.equal(f.events.at(-1),'reload');
});

test('restart can be retried after storage failure and never reloads before deletion succeeds',async()=>{
  const f=fixture(),remove=f.controller.remove;
  f.controller.remove=async()=>{throw new Error('delete failed');};
  await assert.rejects(f.controller.restart('JxK'),/delete failed/);
  assert.equal(f.controller.restarting,false);assert.equal(f.controller.stopped,true);
  assert.equal(f.projects.has('JxK'),true);assert.equal(f.events.includes('reload'),false);
  f.controller.remove=remove;
  await f.controller.restart('JxK');
  assert.equal(f.projects.has('JxK'),false);assert.equal(f.events.at(-1),'reload');
});

test('repeated clicks cannot launch a second deletion while a restart is pending',async()=>{
  const f=fixture();let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const save=f.controller.save(()=>gate);
  const restart=f.controller.restart('JxK');
  await f.controller.restart('HxI');
  release();await save;await restart;
  assert.equal(f.projects.has('HxI'),true);assert.equal(f.projects.has('JxK'),false);
  assert.equal(f.events.filter(event=>event==='reload').length,1);
});

test('Solutions requires confirmation to restart at 140 / 244 during verification of a non-default room',async()=>{
  const rooms=[['a.json',['H','I']],['b.json',['J','K']]].map(([fileName,position],i)=>({fileName,position,rowIndex:i,columnIndex:i,width:4,height:3,objects:[{blockId:'player',x:1,y:1,z:0}]}));
  const world={rooms,blocks:[{id:'player',roleId:'player'}]};
  const snapshot={startRoom:'a.json',room:'a.json',state:rooms[0],position:{x:1,y:1,z:0},canUndo:false,pending:[],routes:[],spots:[],visitedRooms:['a.json'],collectedGems:[],roomCount:2,gemCount:0,roomProgress:rooms.map(room=>({room:room.fileName,total:0,collected:0,remaining:0,visited:room.fileName==='a.json'}))};
  const projects=new Map([['worldhash',{routes:['other solution']}],['active:worldhash','b.json'],['worldhash:b.json',{startRoom:'b.json',routes:Array(244).fill({})}]]);
  const elements=new Map();
  const element=()=>({value:'',textContent:'',disabled:true,hidden:false,open:false,showModal(){this.open=true;},close(){this.open=false;},classList:{toggle(){},add(){}},addEventListener(){},setAttribute(){},replaceChildren(){},append(){}});
  const $=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
  let worker,verificationStarted,oldReply,reloads=0;
  const verifying=new Promise(resolve=>{verificationStarted=resolve;});
  class Worker {
    constructor(){worker=this;}
    postMessage(data){
      if(data.type==='init')queueMicrotask(()=>this.onmessage({data:{id:data.id,type:'complete',value:{fingerprint:'worldhash',snapshot}}}));
      if(data.type==='restore'){
        assert.equal(data.payload.saved.startRoom,'b.json');
        oldReply=this.onmessage;
        this.onmessage({data:{id:data.id,type:'progress',value:{restoring:true,done:140,total:244}}});
        verificationStarted();
      }
    }
    terminate(){this.terminated=true;}
  }
  class Renderer {constructor(canvas,world){this.world=world;}setWorld(world){this.world=world;}selectCell(){}resize(){}}
  const source=(await readFile(new URL('../solutions/v1/main.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify('http://localhost:8080/solutions/v1/main.mjs'));
  const context={console,URL,Worker,MoveSequencePlayer,parseMoveSequence,SolutionRestartController,
    document:{getElementById:$,querySelectorAll:()=>[],createElement:element,createTextNode:text=>text},window:{addEventListener(){}},
    location:{reload:()=>{reloads++;}},ResizeObserver:class{observe(){}},
    loadMainWorldV2:async()=>world,NumberedMazeRenderer:Renderer,installTruncateControls(){},bindCameraHold(){},roomContextWorld:w=>w,roomFromEngineStateV1:(state,room)=>room,
    readProject:async key=>projects.get(key),saveProject:async(key,value)=>projects.set(key,value),deleteProject:async key=>projects.delete(key)
  };
  // Run the page's actual initialization and handlers with its browser services stubbed.
  const page=vm.runInNewContext(`(async()=>{${source}\n})()`,context);
  await verifying;
  assert.equal($('status').textContent,'Verifying saved routes · 140 / 244');
  assert.equal($('restart-solution').disabled,false);
  await $('restart-solution').onclick();
  assert.equal($('restart-dialog').open,true);
  assert.match($('restart-description').textContent,/starting in J×K/);
  assert.equal(worker.terminated,undefined);assert.equal(reloads,0);
  assert.equal(projects.has('worldhash:b.json'),true);
  $('cancel-restart').onclick();
  assert.equal($('restart-dialog').open,false);
  await $('confirm-restart').onclick();
  assert.equal(worker.terminated,undefined);assert.equal(reloads,0);
  assert.equal(projects.has('worldhash:b.json'),true);
  $('restart-solution').onclick();
  await $('confirm-restart').onclick();
  assert.equal($('restart-dialog').open,false);
  assert.equal(worker.terminated,true);assert.equal(reloads,1);
  assert.equal(projects.has('worldhash:b.json'),false);
  assert.deepEqual(projects.get('worldhash'),{routes:['other solution']});
  assert.equal(projects.get('active:worldhash'),'b.json');
  await oldReply({data:{id:2,type:'complete',saved:{startRoom:'b.json',routes:['stale']},value:{snapshot}}});
  assert.equal(projects.has('worldhash:b.json'),false);
  // Termination deliberately leaves the old page's restore awaiting its discarded worker.
  void page;
});
