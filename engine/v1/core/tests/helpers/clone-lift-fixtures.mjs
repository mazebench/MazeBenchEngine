const at = (blockId,x,y,z,extra={}) => ({blockId,x,y,z,...extra});
const actor = (x,y,z,id=17) => at('clone',x,y,z,{genericId:id});
const lift = (x,y,z,id=0) => at('player-lift',x,y,z,
  {genericId:id,orientation:['top','front','right','back','left'][Math.floor(id/2)]});
const terrain = Array.from({length:36},(_,i)=>at('floor',i%6,Math.floor(i/6),0));
const player = at('player',0,0,1);
const move = (objects,dx=0,dy=-1,dz=0) => objects.map(o=>({...o,x:o.x+dx,y:o.y+dy,z:o.z+dz}));
const cases = [];
function add(name,actors,lifts,fixed=[],options={}) {
  const entered = move(actors);
  const raised = options.raised ?? false;
  const blocked = options.blocked ?? false;
  const side = options.side ?? false;
  const body = move(entered,side?1:0,0,side?0:raised?-1:1);
  const base = [options.player ?? player,...terrain,...fixed];
  const start = [...base,...actors,...lifts];
  const frames = [[...base,...entered,...lifts]];
  if (!blocked) frames.push([...base,...body,...lifts.map(o=>({...o,genericId:o.genericId^1}))]);
  cases.push({name,start,frames,world:{width:6,height:6,floorLayer:0}});
}
add('lowered top lift raises a clone',[actor(2,3,1)],[lift(2,2,1)]);
add('raised top lift lowers a clone',[actor(2,3,2)],[lift(2,2,1,1)],
  [at('wall',2,3,1)],{raised:true});
add('vertical clone polycube rises as one body',[actor(2,3,1),actor(2,3,2)],[lift(2,2,1)]);
add('a ceiling blocks the complete clone polycube',[actor(2,3,1),actor(2,3,2)],
  [lift(2,2,1)],[at('wall',2,2,3)],{blocked:true});
add('two feet actuate compatible lifts once',[actor(2,3,1),actor(3,3,1)],
  [lift(2,2,1),lift(3,2,1)]);
add('conflicting lifts leave a rigid clone unchanged',[actor(2,3,1),actor(3,3,2)],
  [lift(2,2,1),lift(3,2,1,1)],[at('wall',3,3,1)],{blocked:true});
add('independent clone IDs actuate their lifts together',[actor(2,3,1),actor(4,3,1,71)],
  [lift(2,2,1),lift(4,2,1)]);
add('side lift ejects a clone',[actor(2,3,1)],[lift(2,2,1,4)],
  [at('wall',1,2,1)],{side:true});
add('blocked side lift preserves its state and rider',[actor(2,3,1)],
  [lift(2,2,1,4)],[at('wall',1,2,1),at('wall',3,2,1)],{side:true,blocked:true});
add('side lift cannot eject a clone into the player',[actor(2,3,1)],
  [lift(2,2,1,4)],[at('wall',1,2,1),at('wall',3,1,1)],
  {side:true,blocked:true,player:at('player',3,2,1)});
for (const blocked of [false,true]) {
  const base = [player,...terrain,at('wall',1,2,1),
    ...(blocked?[at('wall',2,2,2)]:[])];
  const actors = [actor(3,2,1),actor(3,2,2)];
  cases.push({name:`raised side lift ${blocked?'rolls back a blocked clone entry':'lowers for inward clone entry'}`,
    direction:3,world:{width:6,height:6},start:[...base,...actors,lift(2,2,1,5)],frames:[
      [...base,...(blocked?actors:move(actors,-1,0)),lift(2,2,1,blocked?5:4)]
    ]});
}
{
  const base = [player,...terrain.filter(o=>!(o.x===2&&[3,4].includes(o.y))),
    at('ice-9679',2,3,0),at('ice-9679',2,4,0)];
  cases.push({name:'Ice entry triggers a clone lift on the following tick',world:{width:6,height:6},
    start:[...base,actor(2,4,1),lift(2,2,1)],frames:[
      [...base,actor(2,3,1),lift(2,2,1)],
      [...base,actor(2,2,1),lift(2,2,1)],
      [...base,actor(2,2,2),lift(2,2,1,1)]
    ]});
}
{
  const base = [player,...terrain];
  cases.push({name:'a carried clone does not retrigger a lift',world:{width:6,height:6},
    start:[...base,actor(2,3,1),actor(2,3,2,71),lift(2,2,2)],frames:[
      [...base,actor(2,2,1),actor(2,2,2,71),lift(2,2,2)]
    ]});
}
{
  const base = [...terrain];
  cases.push({name:'clone lift carries its player passenger',world:{width:6,height:6},
    start:[...base,at('player',2,3,2),actor(2,3,1),lift(2,2,1)],frames:[
      [...base,at('player',2,2,2),actor(2,2,1),lift(2,2,1)],
      [...base,at('player',2,2,3),actor(2,2,2),lift(2,2,1,1)]
    ]});
}
{
  const base = [player,...terrain,at('wall',1,4,1),at('wall',0,3,2),at('wall',5,3,2),
    ...[0,1,3,4,5].map(x=>at('wall',x,3,1)),lift(2,3,1,1),lift(3,3,2)];
  const puncher = sprung=>at('puncher',1,3,2,{genericId:sprung,orientation:'right'});
  cases.push({name:'punched clones cross lifts without actuating them',world:{width:6,height:6},
    start:[...base,actor(1,4,2),puncher(0)],frames:[
      [...base,actor(1,3,2),puncher(0)],
      [...base,actor(2,3,2),puncher(1)],
      [...base,actor(3,3,2),puncher(0)],
      [...base,actor(4,3,2),puncher(0)]
    ]});
}
export const cloneLiftFixtures = cases;
