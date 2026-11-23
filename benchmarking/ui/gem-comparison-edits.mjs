// User-requested comparison exclusion, verified against this run's action history.
// Move 7368 collected one gem in DxH (7 -> 8). The signed run stays intact.
const astraExclusion = { runId: "run-2026-09-04T19-29-31-992Z-772688", move: 7368, room: "D×H", count: 1 };

export function comparisonGemCount(run) {
  const count = run.gems_collected || 0;
  return run.id === astraExclusion.runId && run.action_count >= astraExclusion.move && count >= 8 ? count - 1 : count;
}

export function correctedGemSeries(series, runId) {
  if (!series || runId !== astraExclusion.runId) return series;
  const index = series.points.findIndex(point => point.move === astraExclusion.move && point.gems === 8);
  if (index < 1 || series.points[index - 1].gems !== 7) return series;
  const points = series.points.filter((_, i) => i !== index).map(point => ({ ...point,
    gems: Math.max(0, point.gems - (point.move >= astraExclusion.move ? 1 : 0))
  }));
  // Retain the endpoint if the excluded collection was the last recorded move.
  if (points.at(-1).move < series.moves) points.push({ move: series.moves, gems: Math.max(0, series.collected - 1) });
  return { ...series, points, collected: points.at(-1).gems, exclusion: astraExclusion };
}

export function editedGemSeries(series, edits = {}) {
  if (!series) return null;
  const original = series.points.map(point => ({ ...point, key: `${point.move}:${point.gems}` }));
  let points = original.map((point, i) => {
    const edit = i > 0 && edits?.[point.key];
    if (!edit || !Number.isSafeInteger(edit.move) || edit.move < 0 || !Number.isSafeInteger(edit.gems)
      || edit.gems < 0 || edit.gems > series.total) return point;
    return { ...point, move: edit.move, gems: edit.gems, edited: edit.move !== point.move || edit.gems !== point.gems };
  });
  // Reject stale/malformed saved coordinates that reverse the move axis.
  if (points.some((point, i) => i && point.move < points[i - 1].move)) points = original;
  return { ...series, points, moves: points.at(-1).move, collected: points.at(-1).gems,
    edited: points.some(point => point.edited) };
}

export function moveGemPoint(series, key, position) {
  const index = series?.points.findIndex(point => point.key === key) ?? -1;
  if (index <= 0 || !Number.isFinite(position.move) || !Number.isFinite(position.gems)) return null;
  return {
    move: Math.max(series.points[index - 1].move, Math.min(series.points[index + 1]?.move ?? Number.MAX_SAFE_INTEGER, Math.round(position.move))),
    gems: Math.max(0, Math.min(series.total, Math.round(position.gems)))
  };
}
