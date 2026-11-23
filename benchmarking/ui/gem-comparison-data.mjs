// Keep recorded collection milestones and the actual endpoint of each run.
export function gemSeries(value) {
  if (!value?.available || !Array.isArray(value.points)) return null;
  const points = value.points.filter(point => Number.isSafeInteger(point.move) && point.move >= 0
    && Number.isFinite(point.gems) && point.gems >= 0).map(point => ({ move: point.move, gems: point.gems }));
  if (!points.length || points.some((point, i) => i && point.move < points[i - 1].move)) return null;
  const moves = Math.max(points.at(-1).move, Number.isSafeInteger(value.moves) ? value.moves : 0);
  if (points.at(-1).move < moves) points.push({ move: moves, gems: points.at(-1).gems });
  return { points, moves, collected: points.at(-1).gems, total: value.total > 0 ? value.total : 100 };
}

export function gemsAt(series, move) {
  if (move > series.moves) return null;
  let low = 0, high = series.points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (series.points[middle].move <= move) low = middle + 1; else high = middle;
  }
  return series.points[low - 1]?.gems ?? null;
}

export function limitGemSeries(series, maxMove) {
  if (!series || maxMove === null || maxMove >= series.moves) return series;
  const points = series.points.filter(point => point.move <= maxMove);
  if (!points.length) return null;
  const collected = points.at(-1).gems;
  if (points.at(-1).move < maxMove) points.push({ move: maxMove, gems: collected });
  return { ...series, points, moves: maxMove, collected };
}

export function gemLinePath(points, x, y) {
  return points.map((point, i) => `${i ? "L" : "M"}${x(point.move)},${y(point.gems)}`).join("");
}

export function axisExtent(value, divisions = 5) {
  const raw = Math.max(1, value) / divisions, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * magnitude >= raw) * magnitude);
  return { max: Math.ceil(Math.max(1, value) / step) * step, step };
}

export function layoutEndLabels(labels, top, bottom, gap = 24) {
  const placed = [];
  for (const label of [...labels].sort((a, b) => a.y - b.y)) {
    const desired = Math.max(top, Math.min(bottom, label.y));
    const candidates = [desired];
    for (let y = top; y <= bottom; y += gap) candidates.push(y);
    candidates.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
    const y = candidates.find(candidate => placed.every(other =>
      label.x >= other.x + other.width + 8 || other.x >= label.x + label.width + 8
      || Math.abs(candidate - other.labelY) >= gap)) ?? desired;
    placed.push({ ...label, labelY: y });
  }
  return placed;
}
