import assert from 'node:assert/strict';
import test from 'node:test';
import { intermediatePlayerPositions } from '../benchmarking/storage/heatmap.mjs';
import { heatmapVisits } from '../benchmarking/ui/heatmap.mjs';
import { historyResponse, mergeRunUpdate } from '../benchmarking/storage/history-delta.mjs';
const p=(worldX,worldY=0,z=0)=>({worldX,worldY,z});
test('tile entry counts ignore stationary/vertical ticks, retain revisits, and exclude synthetic cycle rollback',()=>{
  assert.deepEqual(intermediatePlayerPositions([p(0),p(1),p(1),p(1,0,1),p(2),p(1)]),[{worldX:1,worldY:0},{worldX:2,worldY:0}]);
  assert.deepEqual(intermediatePlayerPositions([p(0),p(5)]),[]);
  assert.deepEqual(intermediatePlayerPositions([p(0),p(1),p(2),p(0)],{skipFinalRollback:true}),[{worldX:1,worldY:0},{worldX:2,worldY:0}]);
  assert.deepEqual(intermediatePlayerPositions([p(0),p(1),p(1,0,-1),null]),[{worldX:1,worldY:0}]);
});
test('mixed legacy/new history, incremental refresh, and rollback include paths exactly once',()=>{
  const old=historyResponse({id:'run',history_epoch:'a',positions:[p(0),p(4)],actions:[{index:1}],novelty:[true,false]});
  const next=historyResponse({...old,positions:[...old.positions,p(7)],actions:[...old.actions,{index:2,traversedPositions:[p(5),p(6)]}],novelty:[true,false,true]},old.history_cursor);
  const merged=mergeRunUpdate(old,next),map=heatmapVisits(merged);
  assert.deepEqual(map.positions.map(p=>p.worldX),[0,4,7,5,6]);
  assert.equal(map.current.worldX,7);assert.equal(map.trackedActions,1);
  const rolled=historyResponse({...merged,history_epoch:'b',positions:[p(0),p(4)],actions:[{index:1}],novelty:[true,false]},merged.history_cursor);
  assert(!rolled.history_delta);
  assert.deepEqual(heatmapVisits(rolled).positions.map(p=>p.worldX),[0,4]);
});
