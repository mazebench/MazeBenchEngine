import { DIRECTIONS } from './model.mjs';
import { engineVoxelCountV1 } from '../../engine/current/adapter.mjs';

// Upload a room once. Expansion, hashing, passive movement and A* stay native.
export function createNativeRoomSearch(model, native, node, goal, {boundaryMask=0, heuristicWeight=3, excludedGems=new Set()}={}) {
  const state=node.state, e=native.exports;
  if(typeof e.solutions_solver_begin!=='function')throw new Error('Solutions solver is unavailable.');
  if(engineVoxelCountV1(state,model.blocks)>e.search_voxel_capacity())throw new Error('Room exceeds the native search capacity.');
  let mask=0n, ordinal=0;
  for(const object of state.objects) {
    if(model.role(object)!=='goal')continue;
    if(!excludedGems.has(object.solutionObjectId)&&object.x>=0&&object.y>=0)mask|=1n<<BigInt(ordinal);
    ordinal++;
  }
  const kind=goal?.kind==='location'&&goal.room===node.room?1:goal?.kind==='gem'&&mask?2:0;
  const {count}=native.writeState(state,model.blocks);
  if(e.solutions_solver_begin(count,state.width,state.height,kind,
    // Storage records the player on a surface at z; the engine uses z + 1.
    goal?.x??0,goal?.y??0,(goal?.z??0)+1,goal?.z==null?1:0,
    Number(mask&0xffffffffn),Number(mask>>32n),boundaryMask,heuristicWeight)!==1)throw new Error('Room is not supported by native search.');
  let status=0;
  return {
    run(maximumExpansions=256) {status=e.editor_solver_run(maximumExpansions);return this.snapshot();},
    snapshot() {
      const found=status===1||status===3;
      return {status:found?'candidate':status===4?'exhausted':status===0?'searching':'limit',
        ...(status===2?{limitReason:'memory'}:{}),
        expanded:e.editor_solver_expanded(),transitions:e.editor_solver_command_transitions(),generated:e.editor_solver_node_count(),
        direction:found?DIRECTIONS[e.solutions_solver_direction()]??null:null,
        actions:found?Array.from({length:e.editor_solver_solution_length()},(_,i)=>DIRECTIONS[e.editor_solver_solution_step(i)]):[]};
    },
    continue() {if(e.solutions_solver_continue()!==1)throw new Error('No native candidate to continue.');status=0;}
  };
}
