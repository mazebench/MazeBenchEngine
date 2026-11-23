export const X_AXES = {
  moves: 'Moves', responses: 'Responses',
  input_tokens_uncached: 'Uncached input tokens', total_tokens: 'Total tokens',
  cost_usd: 'Estimated API cost (USD)', thinking_ms: 'Weighted thinking time'
};

export const LOG_COST_MINIMUM = .1;
export const RUN_CAP_LABEL = '200M total tokens or $2,000';

export function runCapIndex(series) {
  return series?.performance?.findIndex(point => point.total_tokens > 200_000_000 || point.cost_usd > 2_000) ?? -1;
}

export function capRunHistory(series) {
  const index = runCapIndex(series);
  if (index === -1) return series;

  const performance = series.performance.slice(0, index);
  const moves = performance.at(-1)?.moves;
  const progress = (series.progress || []).filter(point => point.moves <= moves);
  if (progress.length && progress.at(-1).moves < moves && moves < series.progress.at(-1).moves) {
    progress.push({...progress.at(-1), moves});
  }

  const thinking = (series.thinking || []).filter(point => point.moves <= moves);
  // A duplicate at the final move includes thinking after that move.
  if (thinking.length > 1 && thinking.at(-1) === series.thinking.at(-1) && thinking.at(-1).moves === thinking.at(-2).moves) {
    thinking.pop();
  }
  return {...series, performance, progress, thinking, capped:true};
}

export function logarithmicScale(maximum, divisions, minimum = 0) {
  const firstTick = minimum || 1;
  const offset = minimum === 0 ? 1 : 0;
  const lastValue = maximum > minimum ? Math.max(maximum, firstTick) : firstTick * (minimum ? 10 : 1);
  const logStart = Math.log10(firstTick), logEnd = Math.log10(lastValue);
  const firstPower = Math.floor(logStart);
  const extent = offset + logEnd - logStart;
  const decades = Math.floor(logEnd) - firstPower;
  const intervals = Math.min(decades, divisions - 1);
  const ticks = minimum ? [firstTick] : [0, firstTick];
  for (let i = 1; i <= intervals; i++) ticks.push(10 ** (firstPower + Math.round(i * decades / intervals)));
  if (ticks.length === 1) ticks.push(lastValue);
  // Axes that start at zero use a linear interval before the first positive tick.
  return {
    ticks,
    position: value => (offset && value <= firstTick ? value / firstTick : offset + Math.log10(value) - logStart) / extent,
    valueAt: position => offset && position * extent <= 1 ? position * extent * firstTick : 10 ** (logStart + position * extent - offset)
  };
}

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const emptySeries = () => ({points:[], linePoints:[], estimated:false});

function boundaryPoint(before, after, x) {
  if (!before || !after || before.x >= x || after.x <= x) return;
  const project = before.x > 0 ? Math.log10 : value => value;
  const start = project(before.x), end = project(after.x);
  const fraction = end > start ? (project(x) - start) / (end - start) : (x - before.x) / (after.x - before.x);
  return {x, y:before.y + fraction * (after.y - before.y)};
}

export function progressSeries(entry, axis, metric, minimum = 0) {
  if (!Object.hasOwn(X_AXES, axis) || !['gems','rooms'].includes(metric)) return emptySeries();
  const exactMoves = axis === 'moves' && Array.isArray(entry.series?.progress) && entry.series.progress.length > 0;
  const thinking = axis === 'thinking_ms';
  const source = exactMoves ? entry.series.progress : thinking ? entry.series?.thinking : entry.series?.performance;
  const points = [];
  for (const sample of source || []) {
    if (!count(sample[axis]) || !count(sample[metric])) continue;
    const point = {x:sample[axis], y:sample[metric]};
    if (points.length && point.x < points.at(-1).x) return emptySeries();
    points.push(point);
  }
  // Join recorded score changes with straight lines, as in the benchmark comparison.
  const compact = points.filter((point,index) => index === 0 || index === points.length-1 || point.y !== points[index-1].y);
  const firstVisible = compact.findIndex(point => point.x >= minimum);
  const start = boundaryPoint(compact[firstVisible - 1], compact[firstVisible], minimum);
  const visible = firstVisible === -1 ? [] : compact.slice(firstVisible);
  const linePoints = start ? [start, ...visible] : visible;
  return {points:visible, linePoints, start, belowMinimum:compact.length > 0 && firstVisible === -1,
    estimated:!exactMoves && !thinking && entry.series?.performance_estimated === true,
    checkpoints:!exactMoves};
}

export function linearPath(points, x, y) {
  return points.map((p,i) => `${i ? 'L' : 'M'}${x(p.x)},${y(p.y)}`).join('');
}
