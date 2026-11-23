import { ConnectedWorldSessionV1 } from '../../play/current/connected-world-session.mjs';
import { engineRoleIdForObject, engineGenericIdForObject } from '../../engine/current/adapter.mjs';
import { ENGINE_WASM_SHA256 } from '../../engine/current/build-info.mjs';
import { replaySolutionImport } from './import-replay.mjs';

export const DIRECTIONS = ['up', 'right', 'down', 'left'];
export const FORMAT = 'mazebench-solutions-v1';
const clone = value => structuredClone(value);
const inside = (o, state) => o.x >= 0 && o.y >= 0 && o.x < state.width && o.y < state.height && o.z !== -2147483648;
export const roomLabel = room => room.position.join('×');

export async function worldFingerprint(world) {
  const source = JSON.stringify({ engine: ENGINE_WASM_SHA256,
    blocks: world.blocks.map(({id, roleId, visual}) => ({id, roleId, kind: visual?.kind})),
    rooms: world.rooms.map(({fileName, position, width, height, objects}) => ({fileName, position, width, height, objects})) });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

class LedgerWorld extends ConnectedWorldSessionV1 {
  projectSimulation(simulation, layout, sourceRoom) {
    const result = super.projectSimulation(simulation, layout, sourceRoom);
    result.collected = [...new Set([...simulation.frames, simulation.final].flatMap(state =>
      state.objects.filter(o => engineRoleIdForObject(o, this.definitionMap) === 'goal' && !inside(o,state)).map(o => o.solutionObjectId)))];
    return result;
  }
  freshRoomState(room) {
    const state = super.freshRoomState(room);
    state.objects = state.objects.filter(o => !this.collected.has(o.solutionObjectId));
    return state;
  }
}

export class SolutionsModel {
  constructor(engine, sourceWorld, fingerprint, startRoom=null) {
    this.engine = engine;
    this.fingerprint = fingerprint;
    this.world = { ...sourceWorld, rooms: sourceWorld.rooms.map(room => ({ ...room,
      objects: room.objects.map((o, i) => ({...o, solutionObjectId: `${room.fileName}:${i}`})) })) };
    this.blocks = new Map(this.world.blocks.map(b => [b.id, b]));
    this.rooms = new Map(this.world.rooms.map(r => [r.fileName, r]));
    this.physics = new LedgerWorld(engine, this.blocks, this.world.rooms);
    this.goalIds = new Map(this.world.rooms.map(r => [r.fileName, r.objects.filter(o => this.role(o) === 'goal').map(o => o.solutionObjectId)]));
    this.spots = new Map(); this.spotKeys = new Map(); this.routes = []; this.sequence = 0;
    this.routeChanges = []; this.routeTrace = null; this.progressCache = null;
    this.root = startRoom ? this.rooms.get(startRoom) : this.world.rooms.find(r => r.position.join('x') === 'HxI');
    if (!this.root) throw new Error(startRoom ? 'That starting room does not exist.' : 'The world has no H×I room.');
    for (const room of this.world.rooms) {
      const state = engine.createState(room);
      if (!this.player(state)) continue;
      const spot = { id: `start:${room.fileName}`, kind: 'start', room: room.fileName, state, collected: [],
        proven: room === this.root, path: room === this.root ? [] : null, route: null, entry: null };
      this.spots.set(spot.id, spot); this.spotKeys.set(this.key(spot), spot.id);
    }
    const start = this.spots.get(`start:${this.root.fileName}`);
    if (!start) throw new Error(`Room ${roomLabel(this.root)} needs an authored player start.`);
    this.verifiedRooms = new Set([this.root.fileName]); this.verifiedGems = new Set();
    this.roomProofs = new Map([[this.root.fileName, []]]); this.gemProofs = new Map();
    this.restoreSpot(start.id);
  }
  role(o) { return engineRoleIdForObject(o, this.blocks); }
  player(state) { return state.objects.find(o => this.role(o) === 'player' && inside(o, state)) || null; }
  position(state) { const p = this.player(state); return p ? {x:p.x,y:p.y,z:p.z} : null; }
  key(node) {
    // Include every physics field and the permanent gem ledger. Coordinates alone
    // would merge distinct block, lift, gate and button configurations.
    return JSON.stringify([node.room, [...node.collected].sort(), node.state.width, node.state.height,
      node.state.objects.map(o => [o.x,o.y,o.z,o.blockId,this.role(o),engineGenericIdForObject(o,this.blocks)])]);
  }
  async step(node, direction, onFrame=null) {
    if (!DIRECTIONS.includes(direction)) throw new Error('Unknown move.');
    const room = this.rooms.get(node.room), collected = new Set(node.collected);
    this.physics.collected = collected;
    const simulation = await this.physics.simulateCommand(node.state, room, direction);
    if (simulation.cycle || !this.player(simulation.final)) return { ...node, changed: false, rejected: simulation.cycle ? 'The move cycles back to its start.' : 'That move falls out of the room.', crossings: [], gained: [] };
    const frames = simulation.animationFrames?.length ? simulation.animationFrames
      : (simulation.frames?.length ? simulation.frames : [simulation.final]).map(state=>({room,state}));
    for (const id of simulation.collected || []) if (id) collected.add(id);
    const finalRoom = (simulation.room || room).fileName;
    let prior = room.fileName, entrance = null;
    for (const frame of frames) {
      const name = frame.room.fileName;
      if (name !== prior) {
        // Only a room where the command settles unlocks a start or resume spot.
        // Keep the last entry coordinate if momentum leaves and re-enters it.
        if (name === finalRoom) entrance = {room:name, position:this.position(frame.state)};
        prior=name;
      }
      const active = new Set(frame.state.objects.filter(o => inside(o,frame.state)).map(o => o.solutionObjectId));
      for (const id of this.goalIds.get(name) || []) if (!active.has(id)) collected.add(id);
    }
    const result = { room: finalRoom, state: simulation.final, collected: [...collected].sort(), crossings: entrance ? [entrance] : [],
      gained: [...collected].filter(id => !node.collected.includes(id)) };
    result.changed = this.key(node) !== this.key(result);
    // Only interactive playback opts in. Search nodes, undo history and saved
    // routes must not retain full animation traces for every attempted move.
    if(result.changed&&onFrame)for(const frame of frames)onFrame({room:frame.room.fileName,state:frame.state});
    return result;
  }
  sourceNode(id=this.source,start=this.sourceOptions) {
    const spot=this.spots.get(id);
    if(!spot)throw new Error('Unknown spawn point.');
    const collected=[...new Set([...spot.collected,...(start?.collected||[])])].sort();
    let state;
    if(start?.reset) {
      const room=this.rooms.get(spot.room);
      state=this.engine.createState(room);
      let player=this.player(state);
      if(!player){player=clone(this.player(spot.state));state.objects.push(player);}
      Object.assign(player,this.position(spot.state));
    }else state=clone(spot.state);
    state.objects=state.objects.filter(o=>!collected.includes(o.solutionObjectId));
    return {room:spot.room,state,collected};
  }
  // Exact source restoration is reserved for saved-run replay and undo.
  restoreSpot(id,start=null) {
    const node=this.sourceNode(id,start);
    this.source=id;this.sourceOptions=start?clone(start):null;this.current=node;
    this.pending=[];this.pendingSteps=[];return this.snapshot();
  }
  resume(id) {
    const spot=this.spots.get(id);
    if(!spot||!['start','entrance'].includes(spot.kind)||!this.canResume(id))throw new Error('Choose a start or entrance in a visited room.');
    this.commit('Manual route');
    return this.restoreSpot(id,{reset:true,collected:[...this.collectedGems]});
  }
  async refreshCurrentGems() {
    const missing=[...this.collectedGems].filter(id=>!this.current.collected.includes(id));
    if(!missing.length)return;
    const start={...this.sourceOptions,collected:[...new Set([...(this.sourceOptions?.collected||[]),...this.collectedGems])].sort()};
    let node=this.sourceNode(this.source,start);const steps=[];
    for(const direction of this.pending){node=await this.step(node,direction);if(!node.changed)throw new Error('Current moves could not be restored.');steps.push(node);}
    this.sourceOptions=start;this.current=node;this.pendingSteps=steps;
  }
  async move(direction,onFrame=null) {
    const result = await this.step(this.current, direction,onFrame);
    if (!result.changed) return { snapshot: this.snapshot(), message: result.rejected || 'No change.', rejected: result.rejected || null };
    this.current = result; this.pending.push(direction); this.pendingSteps.push(result);
    if (result.crossings.length || result.gained.length) this.commit(result.gained.length ? 'Gem route' : 'Room crossing');
    return { snapshot: this.snapshot(), message: result.crossings.length ? `Entered ${roomLabel(this.rooms.get(result.room))}. Resume spot saved.` : result.gained.length ? 'Gem reached. Route saved.' : 'Move recorded.' };
  }
  addSpot(node, {route, path, kind='endpoint', entry=null, changes=null, setup=null}) {
    const key = this.key(node); let spot = this.spots.get(this.spotKeys.get(key));
    if (!spot) {
      spot = { id: `spot:${++this.sequence}`, kind, room: node.room, state: clone(node.state), collected: [...node.collected], proven: path !== null, path, route, entry, setup };
      changes?.spots.set(spot.id,null);
      this.spots.set(spot.id, spot); this.spotKeys.set(key, spot.id);
    } else if (!spot.proven && path !== null) {
      if(changes&&!changes.spots.has(spot.id))changes.spots.set(spot.id,{...spot});
      spot.proven = true; spot.path = path; spot.route = route;
      if(spot.kind!=='start')spot.setup=setup;
    }
    if(kind==='entrance'&&spot.kind==='endpoint') {
      if(changes&&!changes.spots.has(spot.id))changes.spots.set(spot.id,{...spot});
      spot.kind='entrance';spot.entry=entry;
    }
    return spot;
  }
  commit(label='Saved route') {
    if (!this.pending.length) return null;
    const source = this.spots.get(this.source), actions = [...this.pending], routeId = `route:${this.routes.length+1}`;
    // Journal only collection changes; don't copy the entire graph per move.
    const changes={sequence:this.sequence,spots:new Map(),rooms:[],gems:[]};
    const crossed = [], gained = new Set(), spawns=[];
    for (let i=0;i<this.pendingSteps.length;i++) {
      const step = this.pendingSteps[i], path = source.proven ? [...source.path, ...actions.slice(0,i+1)] : null;
      for (const crossing of step.crossings) {
        crossed.push({...crossing, move:i+1});
        if (path) { this.verifiedRooms.add(crossing.room); if (!this.roomProofs.has(crossing.room)) {this.roomProofs.set(crossing.room,path);changes.rooms.push(crossing.room);} }
      }
      for (const gem of step.gained) {
        gained.add(gem);
        if (path) { this.verifiedGems.add(gem); if (!this.gemProofs.has(gem)) {this.gemProofs.set(gem,path);changes.gems.push(gem);} }
      }
      if (step.crossings.length) {
        const spot=this.addSpot(step, {route:routeId, path, kind:'entrance', entry:step.crossings.findLast(c=>c.room===step.room)?.position || null,changes,setup:{from:this.source,actions:actions.slice(0,i+1)}});
        spawns.push({id:spot.id,move:i+1});
      }
    }
    const path = source.proven ? [...source.path,...actions] : null;
    const end = this.addSpot(this.current,{route:routeId,path,changes,setup:{from:this.source,actions}});
    if(!spawns.some(s=>s.id===end.id&&s.move===actions.length))spawns.push({id:end.id,move:actions.length});
    const route = { id:routeId, from:this.source, to:end.id, actions, label, ...(this.sourceOptions?{start:clone(this.sourceOptions)}:{}), proven:source.proven, crossings:crossed, gems:[...gained],spawns };
    this.routes.push(route); this.routeChanges.push(changes);this.progressCache=null;
    // Keep just the latest route's states for instant repeated undo. Older
    // routes can rebuild this cache from their verified command sequence.
    this.routeTrace={route,steps:this.pendingSteps};
    this.source=end.id;this.sourceOptions=null; this.pending=[]; this.pendingSteps=[];
    return route;
  }
  undoRoute() {
    const last=this.routes.at(-1);
    return last?.to===this.source?last:null;
  }
  async undo() {
    if(this.pending.length) {
      this.pending.pop();this.pendingSteps.pop();
      this.current=this.pendingSteps.at(-1)||this.sourceNode();
      return {snapshot:this.snapshot(),message:'Last move removed.'};
    }
    const route=this.undoRoute();
    if(!route)return {snapshot:this.snapshot(),message:'No moves to undo from this start.'};
    let steps=this.routeTrace?.route===route?this.routeTrace.steps:null;
    if(!steps) {
      steps=[];let node=this.sourceNode(route.from,route.start??null);
      for(const direction of route.actions) {
        node=await this.step(node,direction);
        if(!node.changed)throw new Error('The saved route could not be verified for undo.');
        steps.push(node);
      }
      this.routeTrace={route,steps};
    }
    // Delete from the newest recorded route rather than saving an inverse move
    // or forking an unchanged saved route. No later route depends on this tail.
    const changes=this.routeChanges.pop();this.routes.pop();
    for(const [id,previous] of changes.spots) {
      if(previous)this.spots.set(id,previous);
      else {this.spotKeys.delete(this.key(this.spots.get(id)));this.spots.delete(id);}
    }
    for(const room of changes.rooms){this.roomProofs.delete(room);this.verifiedRooms.delete(room);}
    for(const gem of changes.gems){this.gemProofs.delete(gem);this.verifiedGems.delete(gem);}
    this.sequence=changes.sequence;this.routeTrace=null;this.progressCache=null;
    const index=steps.length-1;
    this.source=route.from;this.sourceOptions=route.start?clone(route.start):null;this.pending=route.actions.slice(0,index);this.pendingSteps=steps.slice(0,index);
    this.current=this.pendingSteps.at(-1)||this.sourceNode();
    // Preserve any earlier crossings/gems in the remaining generated route.
    this.commit(route.label);
    return {snapshot:this.snapshot(),message:'Last move deleted from the solution.'};
  }
  async applyRoute(actions, label='A* route',onFrame=null) {
    if (!Array.isArray(actions) || actions.length > 100000 || actions.some(d=>!DIRECTIONS.includes(d))) throw new Error('Invalid route.');
    // Replay before committing. A failed route cannot partially change the project.
    let node=this.current; const steps=[];
    for (const [i,action] of actions.entries()) { const step=await this.step(node,action,onFrame?frame=>onFrame({...frame,command:i+1}):null); if (!step.changed) throw new Error(step.rejected || 'Route contains a blocked move.'); steps.push(step); node=step; }
    this.current=node; this.pending.push(...actions); this.pendingSteps.push(...steps);
    return this.commit(label);
  }
  spawnRecipe(id) {
    const chunks=[],seen=new Set();let spot=this.spots.get(id);
    while(spot&&spot.kind!=='start') {
      if(seen.has(spot.id)||!spot.setup)throw new Error('Saved spawn has no replayable setup.');
      seen.add(spot.id);chunks.push(spot.setup.actions);spot=this.spots.get(spot.setup.from);
    }
    if(!spot)throw new Error('Saved spawn depends on a missing run.');
    return {base:spot.room===this.root.fileName?'game':'room',room:spot.room,actions:chunks.reverse().flat()};
  }
  collectionProgress() {
    if(this.progressCache)return this.progressCache;
    const visited=new Set([this.root.fileName]),collected=new Set(),spots=new Set(),runs=new Set();
    const bySource=new Map(),queue=[`start:${this.root.fileName}`];
    for(const route of this.routes) {
      if(!bySource.has(route.from))bySource.set(route.from,[]);
      bySource.get(route.from).push(route);
    }
    // A room start becomes available only after a physical visit. Old local
    // branches stay locked until a connected run reaches their starting room.
    for(let i=0;i<queue.length;i++) {
      const id=queue[i];if(spots.has(id)||!this.spots.has(id))continue;
      spots.add(id);
      for(const route of bySource.get(id)||[]) {
        runs.add(route.id);
        for(const crossing of route.crossings)if(!visited.has(crossing.room)) {
          visited.add(crossing.room);queue.push(`start:${crossing.room}`);
        }
        for(const gem of route.gems)collected.add(gem);
        for(const spawn of route.spawns)queue.push(spawn.id);
      }
    }
    return this.progressCache={visited,collected,spots,runs};
  }
  get visitedRooms() {return this.collectionProgress().visited;}
  get collectedGems() {return this.collectionProgress().collected;}
  canResume(id) {return this.collectionProgress().spots.has(id);}
  clearRuns() {
    const deleted=this.routes.length;
    // Replace the whole collection so drafts, spawn setups, proofs and undo
    // history cannot retain any of the cleared moves.
    Object.assign(this,new SolutionsModel(this.engine,this.world,this.fingerprint,this.root.fileName));
    return {snapshot:this.snapshot(),deleted,message:`All runs cleared. Start again in ${roomLabel(this.root)}.`};
  }
  async importJSON(json,progress=()=>{},{allowWorldChange=false,allowEngineChange=false}={}) {
    if(this.routes.length||this.pending.length)throw new Error('Clear all runs before importing a solution.');
    let saved;
    try{saved=JSON.parse(json);}catch{throw new Error('This file is not valid JSON.');}
    if(!saved||saved.format!==FORMAT||!Array.isArray(saved.routes))throw new Error('Choose a MazeBench Solutions JSON file exported from this page.');
    if((saved.startRoom||this.world.rooms.find(r=>r.position.join('x')==='HxI')?.fileName)!==this.root.fileName)
      throw new Error('This file starts in another room. Open that starting room before importing it.');
    const engineChanged=Boolean(saved.engine&&saved.engine!==ENGINE_WASM_SHA256);
    const worldChanged=saved.fingerprint!==this.fingerprint;
    if(engineChanged&&!allowEngineChange)throw Object.assign(new Error('The engine has changed since this solution was saved. You can import it and recheck its moves with the current engine.'),{code:'ENGINE_MISMATCH'});
    if(worldChanged&&!allowWorldChange)throw Object.assign(new Error('The rooms or engine have changed since this solution was saved. You can import it and recheck its moves.'),{code:'WORLD_MISMATCH'});
    const changed=worldChanged||engineChanged;
    // Keep only successful actions, with all IDs and progress rebuilt by replay.
    // Unexpected engine errors still leave the current collection untouched.
    const imported=new SolutionsModel(this.engine,this.world,this.fingerprint,this.root.fileName);
    const warnings=await replaySolutionImport(imported,saved,progress,{directions:DIRECTIONS,rebaseLedger:changed});
    await imported.refreshCurrentGems();
    Object.assign(this,imported);
    return {snapshot:this.snapshot(),warnings,message:`Imported ${this.routes.length} run${this.routes.length===1?'':'s'}${changed?engineChanged?' and rechecked them with the current engine and rooms':' and rechecked them against the edited world':''}.`};
  }
  snapshot() {
    const source=this.spots.get(this.source),progress=this.collectionProgress();
    return { startRoom:this.root.fileName, room:this.current.room, state:this.current.state, position:this.position(this.current.state), source:this.source, pending:[...this.pending], proven:source.proven,canUndo:this.pending.length>0||Boolean(this.undoRoute()),
      pathLength:source.proven ? source.path.length+this.pending.length : null,
      spots:[...this.spots.values()].map(({state,path,setup,...spot})=>{const recipe=this.spawnRecipe(spot.id);return {...spot,accessible:progress.spots.has(spot.id)&&['start','entrance'].includes(spot.kind),position:this.position(state),moves:path?.length??null,setupBase:recipe.base,setupRoom:recipe.room,setupMoves:recipe.actions.length};}),
      routes:this.routes.map(({actions,...route})=>({...route,accessible:progress.runs.has(route.id),moves:actions.length})),
      visitedRooms:[...progress.visited],collectedGems:[...progress.collected],
      roomProgress:[...this.goalIds].map(([room,ids])=>{const collected=ids.filter(id=>progress.collected.has(id)).length;return {room,visited:progress.visited.has(room),total:ids.length,collected,remaining:ids.length-collected};}),
      verifiedRooms:[...this.verifiedRooms], verifiedGems:[...this.verifiedGems],
      roomCount:this.rooms.size, gemCount:[...this.goalIds.values()].reduce((n,ids)=>n+ids.length,0) };
  }
  save() { return {format:FORMAT, fingerprint:this.fingerprint, startRoom:this.root.fileName, routes:this.routes.map(({from,actions,label,start})=>({from,actions:[...actions],label,...(start?{start:clone(start)}:{})})), draft:{from:this.source,actions:[...this.pending],...(this.sourceOptions?{start:clone(this.sourceOptions)}:{})}}; }
  export() { const saved=this.save();return {...saved, engine:ENGINE_WASM_SHA256, exportedAt:new Date().toISOString(),
    routes:saved.routes.map((route,i)=>({...route,to:this.routes[i].to,spawns:clone(this.routes[i].spawns)})),
    spawnSetups:[...this.spots.values()].filter(spot=>['start','entrance'].includes(spot.kind)&&this.canResume(spot.id)).map(spot=>({id:spot.id,room:spot.room,position:this.position(spot.state),setup:this.spawnRecipe(spot.id)})),
    roomProofs:Object.fromEntries(this.roomProofs), gemProofs:Object.fromEntries(this.gemProofs),
    currentPath:this.spots.get(this.source).proven ? [...this.spots.get(this.source).path,...this.pending] : null}; }
  async restore(saved, progress=()=>{},{rebaseLedger=false}={}) {
    if (saved.format!==FORMAT || saved.fingerprint!==this.fingerprint || !Array.isArray(saved.routes)) throw new Error('This solution belongs to a different world or engine.');
    if ((saved.startRoom||this.world.rooms.find(r=>r.position.join('x')==='HxI')?.fileName)!==this.root.fileName) throw new Error('This solution starts in another room.');
    // Room edits can renumber gem object IDs. Rebuild each reset's ledger from
    // replayed collections instead of reusing IDs from the previous geometry.
    const sourceOptions=start=>rebaseLedger&&start?.collected?{...start,collected:[...this.collectedGems]}:start;
    for (const [i,route] of saved.routes.entries()) {
      try{this.restoreSpot(route.from,sourceOptions(route.start));await this.applyRoute(route.actions,route.label);}
      catch(error){throw new Error(`Run ${i+1} could not be replayed: ${error.message}`);}
      progress(i+1,saved.routes.length);
    }
    if (saved.draft) {
      this.restoreSpot(saved.draft.from,sourceOptions(saved.draft.start));
      for (const action of saved.draft.actions) {
        const step=await this.step(this.current,action);
        if (!step.changed) throw new Error('Saved draft could not be replayed.');
        this.current=step; this.pending.push(action); this.pendingSteps.push(step);
      }
    }
    return this.snapshot();
  }
}
