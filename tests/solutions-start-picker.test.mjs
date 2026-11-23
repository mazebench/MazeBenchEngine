import assert from 'node:assert/strict';
import test from 'node:test';
import { StartRoomPicker, startingRoomChoices, matchesRoom, savedSolutionSummary, drawRoomPreview } from '../solutions/v1/start-room-picker.mjs';

const blocks=[{id:'p',roleId:'player'},{id:'g',roleId:'goal'}];
const room=(id,columnIndex,rowIndex,start=true)=>({fileName:id,position:[String.fromCharCode(72+columnIndex),String.fromCharCode(73+rowIndex)],columnIndex,rowIndex,width:16,height:16,objects:[...(start?[{blockId:'p',x:2,y:3,z:0}]:[]),{blockId:'g',x:4,y:5,z:1}]});
const world={blocks,rooms:[room('a',0,0),room('blocked',1,0,false),room('b',2,0),room('c',0,1)]};

function fixture(readProject=async()=>null) {
  const nodes=new Map();
  const element=()=>({value:'',textContent:'',children:[],attributes:{},handlers:{},disabled:false,open:false,
    style:{setProperty(){}},classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value;},
    addEventListener(type,callback){this.handlers[type]=callback;},append(...children){this.children.push(...children);},
    focus(){this.focused=true;},scrollIntoView(){},getContext(){return null;},
    showModal(){this.open=true;},close(){this.open=false;this.handlers.close?.();}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const document={getElementById:$,createElement:element};
  const picker=new StartRoomPicker({document,world,readProject,readProjectKeys:async()=>['key:b'],projectKey:id=>`key:${id}`});
  return {picker,$};
}

test('starting-room choices exclude missing or out-of-bounds starts and normalize coordinate searches',()=>{
  const choices=startingRoomChoices(world);
  assert.deepEqual(choices.map(choice=>choice.room.fileName),['a','blocked','b','c']);
  assert.equal(choices[1].start,undefined);assert.equal(choices[0].gems,1);
  for(const query of ['HxI','H×I','h i','Room H/I','H'])assert.equal(matchesRoom(choices[0].room,query),true);
  assert.equal(matchesRoom(choices[0].room,'P×P'),false);
  const invalid=room('invalid',0,0);invalid.objects[0].x=-1;
  assert.equal(startingRoomChoices({blocks,rooms:[invalid]})[0].start,undefined);
});

test('picker searches, filters saved rooms, skips unavailable starts and returns a room without opening it',async()=>{
  const {picker,$}=fixture(async key=>key==='key:b'?{routes:[{actions:['up','right']}],draft:{actions:['down']}}:null);
  await picker.open('a');
  assert.equal($('start-room').value,'a');assert.equal($('start-search').focused,true);
  assert.equal(picker.buttons.get('blocked').disabled,true);
  picker.navigate({key:'ArrowRight',preventDefault(){}});await Promise.resolve();
  assert.equal($('start-room').value,'b');assert.equal($('start-save-detail').textContent,'1 saved run · 3 moves');
  assert.equal($('confirm-start').textContent,'Continue J×I');
  $('start-saved-filter').onclick();
  assert.equal(picker.buttons.get('a').disabled,true);assert.equal(picker.buttons.get('b').disabled,false);
  $('start-default').onclick();assert.equal($('start-room').value,'a');assert.equal(picker.onlySaved,false);
  $('start-search').value='H×J';$('start-search').handlers.input();
  assert.equal($('start-room').value,'c');assert.equal($('confirm-start').disabled,false);
  $('start-search').value='Z×Z';$('start-search').handlers.input();
  assert.equal($('confirm-start').disabled,true);assert.match($('start-results').textContent,/No matching/);
  $('start-current').onclick();assert.equal($('start-room').value,'a');
  assert.equal($('start-dialog').open,true);
});

test('slow saved-progress reads cannot overwrite a newer selection or a closed dialog',async()=>{
  const reads=[];
  const {picker,$}=fixture(key=>new Promise(resolve=>reads.push({key,resolve})));
  await picker.open('a');
  const selected=picker.select(picker.choices.find(choice=>choice.room.fileName==='b'));
  reads[1].resolve({routes:[{actions:['up']}],draft:{actions:[]}});await selected;
  assert.equal($('confirm-start').textContent,'Continue J×I');
  reads[0].resolve({routes:[]});await Promise.resolve();
  assert.equal($('start-preview-name').textContent,'J×I');assert.equal($('confirm-start').textContent,'Continue J×I');
  const later=picker.select(picker.choices[0]);$('start-dialog').close();
  reads[2].resolve({routes:[{actions:['up']}]});await later;
  assert.equal($('confirm-start').textContent,'Open H×I');
});

test('saved-progress summaries count unfinished moves without replaying routes',()=>{
  assert.equal(savedSolutionSummary(null),null);
  assert.deepEqual(savedSolutionSummary({routes:[{actions:['up','down']},{actions:['right']}],draft:{actions:['left','up']}}),{runs:2,moves:5});
});

test('a new run suggests its previous starting room without presenting it as a current solution',async()=>{
  const {picker,$}=fixture();
  await picker.open(null,{initialRoom:'c'});
  assert.equal($('start-room').value,'c');
  assert.equal($('start-current').hidden,true);
  assert.equal($('confirm-start').textContent,'Start in H×J');
  assert.equal($('start-save-title').textContent,'Fresh start');
  await picker.open('a');
  assert.equal($('start-current').hidden,false);
  assert.equal($('confirm-start').textContent,'Return to solution');
});

test('every tile keeps its own preview when searching and selecting rooms',async()=>{
  const {picker,$}=fixture();
  const previews=new Map();
  for(const choice of picker.choices){
    const [preview,coordinate]=picker.buttons.get(choice.room.fileName).children;
    assert.equal(preview.width,128);assert.equal(preview.height,128);
    assert.equal(preview.attributes['aria-hidden'],'true');
    assert.equal(coordinate.textContent,choice.label);
    previews.set(choice.room.fileName,preview);
  }
  await picker.open('a');
  $('start-search').value='J×I';$('start-search').handlers.input();
  for(const [id,preview] of previews)assert.equal(picker.buttons.get(id).children[0],preview);
});

test('previews scale markers and omit hidden or out-of-bounds objects, including rooms without a start',()=>{
  const calls=[];
  const context={fillRect(...args){calls.push(['rect',this.fillStyle,...args]);},beginPath(){},closePath(){},fill(){},stroke(){},
    arc(...args){calls.push(['player',...args]);},moveTo(...args){calls.push(['gem',...args]);},lineTo(){}};
  const canvas={getContext:()=>context};
  const choice=startingRoomChoices(world)[0];
  const original=JSON.stringify(choice);
  const visible={...choice,room:{...choice.room,objects:[...choice.room.objects,
    {blockId:'g',x:-1,y:0,z:0},{blockId:'g',x:3,y:3,z:0,engineHidden:true},{blockId:'g',x:3,y:3,z:-2147483648}]}};
  drawRoomPreview(canvas,visible,new Map(blocks.map(block=>[block.id,block])),128);
  assert.equal(calls.filter(call=>call[0]==='gem').length,1);
  assert.equal(calls.filter(call=>call[0]==='player').length,1);
  for(const call of calls.filter(call=>call[0]==='gem'||call[0]==='player')){
    assert.ok(call[1]>0&&call[1]<128);assert.ok(call[2]>0&&call[2]<128);
  }
  assert.equal(JSON.stringify(choice),original);
  calls.length=0;
  drawRoomPreview(canvas,startingRoomChoices(world)[1],new Map(blocks.map(block=>[block.id,block])));
  assert.equal(calls.filter(call=>call[0]==='player').length,0);
  assert.equal(canvas.width,320);
});
