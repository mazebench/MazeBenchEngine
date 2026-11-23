import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonSeries} from '../benchmarking/comparison-report.mjs';
import {progressSeries,linearPath,logarithmicScale,LOG_COST_MINIMUM,capRunHistory} from '../benchmarking/ui/comparison-chart-data.mjs';
import {scale} from '../benchmarking/ui/comparison-chart.mjs';
const summary={action_count:3,actions:[
 {index:1,at:'2026-01-01T00:00:02Z',totalGems:1,gemsCollected:1,roomsVisited:1},
 {index:2,at:'2026-01-01T00:00:04Z',totalGems:1,gemsCollected:0,roomsVisited:2},
 {index:3,at:'2026-01-01T00:00:06Z',totalGems:2,gemsCollected:1,roomsVisited:2}
]};
const record=(second,usage={})=>({timestamp:Date.parse(`2026-01-01T00:00:0${second}Z`),usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10,...usage}});
test('response checkpoints join retained actions, subtract cache once, and keep final tool moves',()=>{
 const series=comparisonSeries(summary,[record(1),record(3),record(5)],{model:'test'}, {price:{rates:[2,.2,2,10]}});
 assert.deepEqual(series.progress.map(p=>[p.moves,p.gems,p.rooms]),[[0,0,1],[1,1,1],[2,1,2],[3,2,2]]);
 assert.deepEqual(series.performance.map(p=>[p.moves,p.responses,p.input_tokens_uncached,p.total_tokens]),[[0,0,0,0],[0,1,20,110],[1,2,40,220],[2,3,60,330],[3,3,60,330]]);
 assert.ok(Math.abs(series.performance.at(-1).cost_usd-.000468)<1e-10);
 assert.deepEqual(progressSeries({series},'responses','gems').points,[{x:0,y:0},{x:2,y:1},{x:3,y:2}]);
});
test('unknown costs are missing, never a fabricated zero-cost run',()=>{
 const series=comparisonSeries(summary,[record(3)],{model:'unknown-model'});
 assert.equal(progressSeries({series},'cost_usd','gems').points.length,0);
 assert.ok(progressSeries({series},'total_tokens','rooms').points.length>0);
 assert.equal(comparisonSeries(summary,[]).performance.length,0);
 assert.deepEqual(comparisonSeries({action_count:100,gems_collected:4},[]).progress,[]);
});
test('weighted thinking progress uses completed episodes and works without token records', () => {
  const end = second => Date.parse(`2026-01-01T00:00:0${second}Z`);
  const episodes = [
    {ended_at: end(1), duration_ms: 500, weighted_duration_ms: 1000},
    {ended_at: end(4), duration_ms: 1000, weighted_duration_ms: 2000},
    {ended_at: end(7), duration_ms: 750, weighted_duration_ms: 750}
  ];
  const series = comparisonSeries(summary, [], {}, {}, episodes);
  assert.deepEqual(series.performance, []);
  assert.deepEqual(series.thinking.map(point => [point.moves, point.thinking_ms]),
    [[0, 0], [1, 1000], [2, 3000], [3, 3000], [3, 3750]]);
  assert.deepEqual(progressSeries({series}, 'thinking_ms', 'gems').points,
    [{x:0,y:0}, {x:1000,y:1}, {x:3000,y:2}, {x:3750,y:2}]);
  assert.deepEqual(progressSeries({series}, 'thinking_ms', 'rooms').points,
    [{x:0,y:1}, {x:3000,y:2}, {x:3750,y:2}]);
  assert.equal(comparisonSeries(summary, []).unavailable.thinking_ms, 'No completed thinking episodes recorded');
});
test('per-response prices use historical speed and reported provider cost',()=>{
 const seen=[];
 const series=comparisonSeries(summary,[record(1),record(3),record(5,{cost_usd:.02})],{model:'test',service_tier_history:[{at:'2026-01-01T00:00:00Z',service_tier:'standard'},{at:'2026-01-01T00:00:02Z',service_tier:'fast'}]}, {priceFor:(_model,_at,tier)=>{seen.push(tier);return {rates:[1,0,1,tier==='fast'?20:10]};}});
 assert.deepEqual(seen,['standard','fast']);
 assert.ok(series.performance.at(-1).cost_usd>.02);
});
test('cost scale supports fractions and chart uses diagonal segments',()=>{
 const axis=scale(.0034,5);
 assert.ok(axis.maximum>=.0034&&axis.maximum<.01);
 assert.equal(linearPath([{x:0,y:0},{x:10,y:2}],x=>x,y=>y),'M0,0L10,2');
 assert.equal(progressSeries({series:{performance:[{total_tokens:10,gems:0},{total_tokens:5,gems:1}]}},'total_tokens','gems').points.length,0);
});
test('logarithmic x-axis keeps the origin and spaces positive decades evenly', () => {
  const moves = logarithmicScale(1000, 5);
  assert.deepEqual(moves.ticks, [0, 1, 10, 100, 1000]);
  assert.deepEqual(moves.ticks.map(moves.position), [0, .25, .5, .75, 1]);
  assert.equal(moves.valueAt(moves.position(37)).toFixed(6), '37.000000');

  const zero = logarithmicScale(0, 3);
  assert.equal(zero.position(0), 0);
  assert.deepEqual(zero.ticks, [0, 1]);
});
test('logarithmic cost starts at ten cents and clips the line before the first visible milestone', () => {
  const cost = logarithmicScale(10, 5, LOG_COST_MINIMUM);
  assert.deepEqual(cost.ticks, [.1, 1, 10]);
  assert.deepEqual(cost.ticks.map(cost.position), [0, .5, 1]);
  const shortAxis = logarithmicScale(.36, 5, LOG_COST_MINIMUM);
  assert.deepEqual(shortAxis.ticks, [.1, .36]);

  const entry = {series: {performance: [{cost_usd: 0, gems: 0}, {cost_usd: .01, gems: 1}, {cost_usd: 1, gems: 3}]}};
  const visible = progressSeries(entry, 'cost_usd', 'gems', LOG_COST_MINIMUM);
  assert.deepEqual(visible.points, [{x: 1, y: 3}]);
  assert.deepEqual(visible.start, {x: .1, y: 2});
  assert.deepEqual(progressSeries(entry, 'cost_usd', 'gems').points.map(point => point.x), [0, .01, 1]);
  entry.series.performance.pop();
  assert.equal(progressSeries(entry, 'cost_usd', 'gems', LOG_COST_MINIMUM).belowMinimum, true);
});

test('run budgets truncate the same recorded score across every chart axis', () => {
  const before = {moves: 8, responses: 4, total_tokens: 200_000_000, input_tokens_uncached: 7_000_000, cost_usd: 120, gems: 10, rooms: 12};
  const after = {...before, moves: 12, responses: 8, total_tokens: 201_000_000, gems: 17, rooms: 20};
  const history = {
    performance: [before, after],
    progress: [{...before, moves: 6}, after],
    thinking: [{...before, moves: 6, thinking_ms: 400}, {...after, thinking_ms: 800}]
  };
  const series = capRunHistory(history);
  const expected = {moves: 8, responses: 4, total_tokens: 200_000_000, input_tokens_uncached: 7_000_000, cost_usd: 120, thinking_ms: 400};
  for (const [axis, x] of Object.entries(expected)) {
    assert.deepEqual(progressSeries({series}, axis, 'gems').points.at(-1), {x,y:10});
    assert.deepEqual(progressSeries({series}, axis, 'rooms').points.at(-1), {x,y:12});
  }
  assert.equal(series.capped, true);
  assert.equal(progressSeries({series:history}, 'input_tokens_uncached', 'gems').points.at(-1).y, 17);
});

test('an API cost above $2,000 can truncate a run before its token budget', () => {
  const before = {moves: 1, total_tokens: 90_000_000, cost_usd: 2000, gems: 3};
  const after = {moves: 2, total_tokens: 91_000_000, cost_usd: 2001, gems: 4};
  const history = {performance: [before, after]};
  const series = capRunHistory(history);
  assert.deepEqual(series.performance, [before]);
  assert.equal(series.capped, true);

  const withinBudget = {performance: [before]};
  assert.equal(capRunHistory(withinBudget), withinBudget);
});
