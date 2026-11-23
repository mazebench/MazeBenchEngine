import { DIRECTIONS } from './model.mjs';

class MinHeap {
  items=[];
  push(item) { const a=this.items; a.push(item); let i=a.length-1; while(i>0) { const p=(i-1)>>1; if(this.less(a[p],item))break; a[i]=a[p];i=p; } a[i]=item; }
  less(a,b) { return a.f<b.f || (a.f===b.f && a.h<=b.h); }
  pop() { const a=this.items, first=a[0], last=a.pop(); if(a.length) { let i=0; while(i*2+1<a.length) { let c=i*2+1; if(c+1<a.length&&this.less(a[c+1],a[c]))c++; if(this.less(last,a[c]))break; a[i]=a[c];i=c; } a[i]=last; } return first; }
}
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));

export async function searchRoute(model, goal, {maximumNodes=8000, maximumMs=15000, heuristicWeight=3, start=model.current, onProgress=()=>{}, cancelled=()=>false}={}) {
  if (!['gem','room','location'].includes(goal.kind)) throw new Error('Choose a route target.');
  if(goal.kind==='location') {
    const room=model.rooms.get(goal.room);
    if(!room || !Number.isInteger(goal.x)||!Number.isInteger(goal.y)||goal.x<0||goal.y<0||goal.x>=room.width||goal.y>=room.height || (goal.z!=null&&!Number.isInteger(goal.z))) throw new Error('Choose a valid target coordinate.');
  }
  const excludedRooms=new Set(goal.excludedRooms || model.visitedRooms), excludedGems=new Set(goal.excludedGems || model.collectedGems);
  const origin=start;
  const reached=node=>goal.kind==='gem' ? node.collected.some(id=>!excludedGems.has(id)&&!origin.collected.includes(id))
    : goal.kind==='room' ? !excludedRooms.has(node.room)
      : node.room===goal.room && (()=>{const p=model.player(node.state);return p&&p.x===goal.x&&p.y===goal.y&&(goal.z==null||p.z===goal.z);})();
  const targets=goal.kind==='location' ? [{...goal,room:model.rooms.get(goal.room)}]
    : goal.kind==='gem' ? model.world.rooms.flatMap(room=>room.objects.filter(o=>model.role(o)==='goal'&&!excludedGems.has(o.solutionObjectId)&&!origin.collected.includes(o.solutionObjectId)).map(o=>({...o,room})))
      : model.world.rooms.filter(room=>!excludedRooms.has(room.fileName)).map(room=>({room,x:room.width/2,y:room.height/2}));
  if (!targets.length) return {status:'no-targets',actions:[],expanded:0};
  const heuristic=node=>{
    const p=model.player(node.state), room=model.rooms.get(node.room);
    const x=room.columnIndex*room.width+p.x, y=room.rowIndex*room.height+p.y;
    return Math.min(...targets.map(t=>Math.abs(x-t.room.columnIndex*t.room.width-t.x)+Math.abs(y-t.room.rowIndex*t.room.height-t.y)));
  };
  // A* over full engine states. Manhattan distance guides search, but ice/punch
  // movement makes it non-admissible; a found route is not a shortest-path claim.
  const open=new MinHeap(), seen=new Map(), nodes=[], objects=new Map();
  function intern(state) { return {...state,objects:state.objects.map(o=>{const key=JSON.stringify(o);if(!objects.has(key))objects.set(key,o);return objects.get(key);})}; }
  const h=heuristic(origin), initialKey=model.key(origin);
  nodes.push({...origin,g:0,h,f:h*heuristicWeight,parent:-1,index:0,key:initialKey}); open.push(nodes[0]); seen.set(initialKey,0);
  const started=performance.now(); let expanded=0, transitions=0;
  function result(status,node=null) {const actions=[];while(node&&node.parent>=0){actions.push(node.action);node=nodes[node.parent];}return {status,actions:actions.reverse(),expanded,generated:nodes.length,transitions,elapsedMs:performance.now()-started};}
  while(open.items.length) {
    if(cancelled()) return result('cancelled');
    if(performance.now()-started>=maximumMs)return {...result('limit'),limitReason:'time'};
    if(nodes.length>=maximumNodes)return {...result('limit'),limitReason:'states'};
    const node=open.pop(); if(seen.get(node.key)!==node.g)continue;
    if(reached(node))return result('found',node);
    const parent=node.index; expanded++;
    for(const action of DIRECTIONS) {
      const next=await model.step(node,action);transitions++;
      if(!next.changed)continue;
      const key=model.key(next),g=node.g+1;
      if((seen.get(key)??Infinity)<=g)continue;
      const h=heuristic(next);const entry={...next,state:intern(next.state),g,h,f:g+h*heuristicWeight,parent,action,index:nodes.length,key};
      nodes.push(entry);seen.set(key,g);
      if(reached(entry))return result('found',entry);
      open.push(entry);
      if(nodes.length>=maximumNodes)break;
    }
    if(expanded%16===0){onProgress(result('searching'));await yieldTask();}
  }
  return result('exhausted');
}
