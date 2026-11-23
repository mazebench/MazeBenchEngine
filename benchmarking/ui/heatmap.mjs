// Endpoints remain indexed by action for replay/rollback. Supplement them
// with the exact intermediate visits when the runtime recorded that data.
export function heatmapVisits(run) {
  const positions = [...(run.positions || [])];
  let trackedActions = 0;
  for (const action of run.actions || []) {
    if (!Array.isArray(action.traversedPositions)) continue;
    trackedActions++;
    for (const position of action.traversedPositions) positions.push(position);
  }
  const current = (run.positions || []).findLast(p => p && Number.isFinite(p.worldX) && Number.isFinite(p.worldY));
  return { positions, current, trackedActions };
}
