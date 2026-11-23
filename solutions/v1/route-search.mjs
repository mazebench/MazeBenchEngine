import { DIRECTIONS } from './model.mjs';
import { createNativeRoomSearch } from './native-search.mjs';
import { searchRoute } from './search.mjs';

const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));

// Search room-local graphs natively, then connect verified entrances. Native
// proposals never prove crossings: replay them through connected physics first.
export async function planRoute(model,native,goal,options={}) {
  const start=model.current, started=performance.now(), maximumMs=options.maximumMs??60000;
  const cancelled=options.cancelled??(()=>false), elapsed=()=>performance.now()-started;
  const excludedRooms=new Set(goal.excludedRooms??model.visitedRooms);
  const excludedGems=new Set([...(goal.excludedGems??model.collectedGems),...start.collected]);
  if(!['gem','room','location'].includes(goal.kind))throw new Error('Choose a route target.');
  if(goal.kind==='location') {
    const room=model.rooms.get(goal.room);
    if(!room||!Number.isInteger(goal.x)||!Number.isInteger(goal.y)||goal.x<0||goal.y<0||goal.x>=room.width||goal.y>=room.height||(goal.z!=null&&!Number.isInteger(goal.z)))throw new Error('Choose a valid target coordinate.');
  }
  const reached=node=>goal.kind==='gem'?node.collected.some(id=>!excludedGems.has(id))
    :goal.kind==='room'?!excludedRooms.has(node.room)
    :node.room===goal.room&&(()=>{const p=model.player(node.state);return p&&p.x===goal.x&&p.y===goal.y&&(goal.z==null||p.z===goal.z);})();
  const targets=goal.kind==='location'?[{room:model.rooms.get(goal.room),x:goal.x,y:goal.y}]
    :goal.kind==='gem'?model.world.rooms.flatMap(room=>room.objects.filter(o=>model.role(o)==='goal'&&!excludedGems.has(o.solutionObjectId)).map(o=>({room,x:o.x,y:o.y})))
    :model.world.rooms.filter(room=>!excludedRooms.has(room.fileName)).map(room=>({room,x:room.width/2,y:room.height/2}));
  let expanded=0,transitions=0,verifiedCommands=0,roomJobs=0,limited=false,limitReason=null,lastYield=started;
  const result=(status,actions=[])=>({status,actions,expanded,transitions,verifiedCommands,roomJobs,elapsedMs:elapsed(),algorithm:'native-room-astar'});
  if(!targets.length)return result('no-targets');
  if(cancelled())return result('cancelled');
  if(reached(start))return result('found');
  const distance=node=>{
    const p=model.player(node.state),room=model.rooms.get(node.room);
    return Math.min(...targets.map(t=>Math.abs(room.columnIndex*room.width+p.x-t.room.columnIndex*t.room.width-t.x)+Math.abs(room.rowIndex*room.height+p.y-t.room.rowIndex*t.room.height-t.y)));
  };
  const open=[{node:start,actions:[],priority:distance(start)}], seen=new Set([model.key(start)]);
  const enqueue=(node,actions)=>{const key=model.key(node);if(seen.has(key))return;seen.add(key);open.push({node,actions,priority:distance(node)+actions.length*.05});};
  const pause=async()=>{
    if(performance.now()-lastYield<12)return;
    options.onProgress?.(result('searching'));await yieldTask();lastYield=performance.now();
  };
  // Keep almost all of the selected time for the fast search. Reserve a small
  // connected-physics fallback for continuous moves through unusual seams.
  const nativeBudget=maximumMs-Math.min(1000,maximumMs*.15);
  while(open.length&&elapsed()<nativeBudget&&!cancelled()) {
    open.sort((a,b)=>b.priority-a.priority);const job=open.pop();roomJobs++;
    const room=model.rooms.get(job.node.room);
    // Only verified candidate prefixes keep JS room states, not all A* nodes.
    const prefixes=new Map([['',job.node]]);
    const verify=async actions=>{
      let node=job.node,key='';
      for(let i=0;i<actions.length;i++) {
        if(cancelled()||elapsed()>=maximumMs)return null;
        key+=DIRECTIONS.indexOf(actions[i]);
        if(prefixes.has(key))node=prefixes.get(key);
        else {node=await model.step(node,actions[i]);verifiedCommands++;if(!node.changed)return null;prefixes.set(key,node);}
        if(reached(node))return {found:[...job.actions,...actions.slice(0,i+1)]};
        // Keep actual seam outcomes; do not trust the isolated route past one.
        if(node.room!==job.node.room){enqueue(node,[...job.actions,...actions.slice(0,i+1)]);return null;}
        await pause();
      }
      return {node};
    };
    const hasLocalTarget=goal.kind==='location'?goal.room===job.node.room:goal.kind==='gem'&&job.node.state.objects.some(o=>model.role(o)==='goal'&&!excludedGems.has(o.solutionObjectId));
    // Clicked tiles and local gems get the same direct search as editor Solve.
    const phases=hasLocalTarget?['target','edges']:['edges'];
    for(const phase of phases) {
      let boundaryMask=0;
      if(phase==='edges')DIRECTIONS.forEach((d,i)=>{if(model.physics.neighbor(room,d))boundaryMask|=1<<i;});
      if(phase==='edges'&&!boundaryMask)continue;
      let session;
      try{session=createNativeRoomSearch(model,native,job.node,phase==='target'?goal:null,{boundaryMask,excludedGems,heuristicWeight:options.heuristicWeight??3});}
      catch{limited=true;continue;}
      // A room's frontier must survive for the selected search duration. The
      // former two-second slice discarded hard puzzles even with more time set.
      let previousExpanded=0,previousTransitions=0,candidates=0,report=session.snapshot();
      while(elapsed()<nativeBudget&&!cancelled()) {
        report=session.run(128);
        expanded+=report.expanded-previousExpanded;transitions+=report.transitions-previousTransitions;
        previousExpanded=report.expanded;previousTransitions=report.transitions;
        if(report.status==='candidate') {
          const path=report.direction?[...report.actions,report.direction]:report.actions;
          const verified=await verify(path);
          if(verified?.found)return result('found',verified.found);
          if(verified?.node&&report.direction&&verified.node.crossings?.length)enqueue(verified.node,[...job.actions,...path]);
          session.continue();candidates++;
          // Keep the room queue moving; truncation is a limit, never an
          // unreachable proof. Alternate entrance board states stay distinct.
          if(phase==='edges'&&candidates>=32&&open.length){limited=true;break;}
        }else if(report.status!=='searching'){
          if(report.status==='limit')limitReason=report.limitReason;
          break;
        }
        // Use the editor's growing compact-state storage by default. An
        // explicit caller budget remains available for bounded searches.
        if(report.generated>=(options.maximumNativeNodes??Infinity)){limited=true;limitReason='states';break;}
        await pause();
      }
      if(report.status!=='exhausted')limited=true;
      if(cancelled()||elapsed()>=nativeBudget)break;
    }
    await pause();
  }
  if(cancelled())return result('cancelled');
  if(elapsed()>=nativeBudget)limitReason??='time';
  if(elapsed()>=maximumMs)return {...result('limit'),limitReason:'time'};
  // Also cover continuous commands that cross without settling at a boundary.
  const fallback=await searchRoute(model,goal,{...options,maximumMs:maximumMs-elapsed(),onProgress:p=>options.onProgress?.({...p,expanded:expanded+p.expanded,transitions:transitions+(p.transitions??0),elapsedMs:elapsed()})});
  expanded+=fallback.expanded;transitions+=fallback.transitions??0;
  const status=fallback.status==='exhausted'&&limited?'limit':fallback.status;
  return {...result(status,fallback.actions),fallback:true,...(status==='limit'?{limitReason:limitReason??fallback.limitReason??'time'}:{})};
}
