import { loadMazeBenchEngineV1 } from '../../engine/current/engine.mjs';
import { SolutionsModel, worldFingerprint } from './model.mjs';
import { searchRoute } from './search.mjs';
import { planRoute } from './route-search.mjs';
import { compileFullSolution, setupCommands } from './full-solution.mjs';
import { instantiateMazeBenchEngineV1 } from '../../engine/current/engine.mjs';
let model, fingerprint, sourceWorld, engine, cancelled=false, queue=Promise.resolve();
let nativePromise;
function nativeEngine(){return nativePromise??=fetch(new URL('./solutions-solver.wasm',import.meta.url)).then(r=>{if(!r.ok)throw new Error('Room solver unavailable.');return instantiateMazeBenchEngineV1(r);});}
self.onmessage=({data})=>{
  if(data.type==='cancel'){cancelled=true;return;}
  queue=queue.catch(()=>{}).then(async()=>{
    const {id,type,payload={}}=data;
    const progress=value=>self.postMessage({id,type:'progress',value});
    try {
      let value;const frames=[],capture=frame=>frames.push(frame);
      if(type==='init') {sourceWorld=payload.world;[engine,fingerprint]=await Promise.all([loadMazeBenchEngineV1(),worldFingerprint(sourceWorld)]);model=new SolutionsModel(engine,sourceWorld,fingerprint);value={fingerprint,snapshot:model.snapshot()};}
      else if(type==='restore') {const restored=new SolutionsModel(engine,sourceWorld,fingerprint,payload.saved.startRoom);await restored.restore(payload.saved,(done,total)=>progress({restoring:true,done,total}));model=restored;await model.refreshCurrentGems();value={snapshot:model.snapshot()};}
      else if(type==='new-solution') {model=new SolutionsModel(engine,sourceWorld,fingerprint,payload.room);value={snapshot:model.snapshot()};}
      else if(type==='move')value={...await model.move(payload.direction,capture),frames};
      else if(type==='undo'){value=await model.undo();await model.refreshCurrentGems();value.snapshot=model.snapshot();}
      else if(type==='clear-runs')value=model.clearRuns();
      else if(type==='import'){
        let saved;
        try{saved=JSON.parse(payload.json);}catch{throw new Error('This file is not valid JSON.');}
        const imported=new SolutionsModel(engine,sourceWorld,fingerprint,saved?.startRoom||undefined);
        value=await imported.importJSON(payload.json,(done,total)=>progress({restoring:true,done,total}),{allowWorldChange:payload.allowWorldChange===true,allowEngineChange:payload.allowEngineChange===true});
        model=imported;
      }
      else if(type==='resume')value={snapshot:model.resume(payload.id),message:'Room reset to this spawn. Collected gems stay collected.'};
      else if(type==='search'){
        cancelled=false;
        const options={maximumNodes:payload.maximumNodes??20000,maximumMs:payload.maximumMs??60000,onProgress:progress,cancelled:()=>cancelled};
        const native=await nativeEngine().catch(()=>null);
        const result=native?await planRoute(model,native,payload.goal,options):await searchRoute(model,payload.goal,options);
        if(result.status==='found'&&result.actions.length)await model.applyRoute(result.actions,payload.goal.kind==='location'?'Location route':payload.goal.kind==='gem'?'Gem route':'New room route',capture);
        value={snapshot:model.snapshot(),search:result,frames};
      }
      else if(type==='replay') {
        const route=model.routes.find(r=>r.id===payload.id);if(!route)throw new Error('Unknown route.');
        let node=model.sourceNode(route.from,route.start??null);frames.push({room:node.room,state:node.state,command:0});
        for(const [i,action] of route.actions.entries())node=await model.step(node,action,frame=>capture({...frame,command:i+1}));
        value={frames,actions:route.actions};
      }
      else if(type==='moves') {
        const route=model.routes.find(r=>r.id===payload.id);if(!route)throw new Error('Unknown route.');
        const source=model.spots.get(route.from);
        const recipe=model.spawnRecipe(source.id);
        value={actions:route.actions,path:[...setupCommands(model,recipe),...route.actions],anchor:recipe.base==='game'?'Start of game':`Go to room ${model.rooms.get(recipe.room).position.join('×')}`};
      }
      else if(type==='spawn-moves'){
        const recipe=model.spawnRecipe(payload.id);
        value={actions:setupCommands(model,recipe),path:null,anchor:recipe.base==='game'?'Start of game':`Go to room ${model.rooms.get(recipe.room).position.join('×')}`,spawn:true};
      }
      else if(type==='full-solution'||type==='export'){
        cancelled=false;
        const fullSolution=await compileFullSolution(model,{onProgress:progress,cancelled:()=>cancelled});
        value=type==='export'?{...model.export(),fullSolution}:fullSolution;
      }
      else throw new Error('Unknown Solutions action.');
      self.postMessage({id,type:'complete',value,saved:['move','undo','clear-runs','import','resume','search','restore','new-solution'].includes(type)?model.save():null});
    }catch(error){self.postMessage({id,type:'error',error:error.message||String(error),code:error.code});}
  });
};
