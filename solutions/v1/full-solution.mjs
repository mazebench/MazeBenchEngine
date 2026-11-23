import { engineGenericIdForObject } from '../../engine/current/adapter.mjs';

export function roomCommand(model,id) {return `room ${model.rooms.get(id).position.join('x')}`;}
export function setupCommands(model,recipe) {
  return [...(recipe.base==='room'?[roomCommand(model,recipe.room)]:[]),...recipe.actions];
}

// Gems persist between runs. Compare the physical board without goal records,
// so a removed gem never prevents a valid entrance from being reconstructed.
// Connected entry can reorder objects relative to the authored reset board.
function boardKey(model,node) {
  return JSON.stringify([node.room,node.state.width,node.state.height,node.state.objects
    .filter(o=>model.role(o)!=='goal')
    .map(o=>JSON.stringify([o.x,o.y,o.z,o.blockId,model.role(o),engineGenericIdForObject(o,model.blocks)]))
    .sort()]);
}

export async function compileFullSolution(model,{onProgress=()=>{},cancelled=()=>false}={}) {
  const root=model.spots.get(`start:${model.root.fileName}`);
  let current={room:root.room,state:root.state,collected:[]};
  let visited=new Set([root.room]),commands=[],lastYield=performance.now();
  const runs=[...model.routes];
  if(model.pending.length)runs.push({id:'draft',from:model.source,start:model.sourceOptions,actions:model.pending,gems:[],to:null});
  const remaining=[...runs],completed=[],errors=new Map();
  const check=async()=>{
    if(cancelled())throw new Error('Full solution cancelled.');
    if(performance.now()-lastYield>16){onProgress({compiling:true,done:completed.length,total:runs.length,commands:commands.length});await new Promise(resolve=>setTimeout(resolve,0));lastYield=performance.now();}
  };
  let advanced=true;
  while(remaining.length&&advanced) {
    advanced=false;
    for(let i=0;i<remaining.length;) {
      const run=remaining[i],source=model.sourceNode(run.from,run.start??null),recipe=model.spawnRecipe(run.from);
      const same=boardKey(model,current)===boardKey(model,source);
      if(!same&&!visited.has(recipe.room)) {errors.set(run.id,`Visit ${model.rooms.get(recipe.room).position.join('×')} before using its room start.`);i++;continue;}
      let node=current;const reached=new Set(visited),next=[];
      const move=async direction=>{
        await check();const step=await model.step(node,direction);
        if(step.rejected)throw new Error(step.rejected);
        // A previously collected gem can turn a formerly useful move into a
        // harmless no-op; it is still a valid benchmark directional command.
        node=step;next.push(direction);for(const crossing of step.crossings)reached.add(crossing.room);
      };
      try {
        if(!same) {
          const room=model.rooms.get(recipe.room),state=model.engine.createState(room);
          state.objects=state.objects.filter(o=>!node.collected.includes(o.solutionObjectId));
          if(!model.player(state))throw new Error('This room has no authored start.');
          node={room:room.fileName,state,collected:[...node.collected]};
          next.push(roomCommand(model,room.fileName));
          for(const direction of recipe.actions)await move(direction);
          if(boardKey(model,node)!==boardKey(model,source))throw new Error('Entrance setup does not reproduce this reset room. This run is not included in the full solution.');
        }
        const setupLength=next.length;
        for(const direction of run.actions)await move(direction);
        if(run.to&&boardKey(model,node)!==boardKey(model,model.spots.get(run.to)))throw new Error('Run did not reach its saved endpoint.');
        if(run.gems.some(id=>!node.collected.includes(id)))throw new Error('Run did not reproduce its gem collections.');
        completed.push({id:run.id,startCommand:commands.length,endCommand:commands.length+next.length,setupCommands:setupLength});
        commands.push(...next);current=node;visited=reached;remaining.splice(i,1);errors.delete(run.id);advanced=true;
      }catch(error){if(cancelled())throw error;errors.set(run.id,error.message);i++;}
    }
  }
  return {format:'mazebench-full-solution-v1',start:model.root.position.join('x'),commands,
    complete:remaining.length===0,runs:completed,blockedRuns:remaining.map(run=>({id:run.id,reason:errors.get(run.id)})),
    rooms:[...visited],gems:[...current.collected],moves:commands.filter(command=>!command.startsWith('room ')).length,
    roomCommands:commands.filter(command=>command.startsWith('room ')).length};
}
