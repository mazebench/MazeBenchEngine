// Extra tile entries between the already-recorded before/final positions.
// Collapse stationary engine ticks and vertical motion in this 2D heatmap.
// Never interpolate between snapshots: undo, teleports, and cycle rollback
// are not physical paths through the cells between their endpoints.
export function intermediatePlayerPositions(frames, { skipFinalRollback = false } = {}) {
  const valid = p => p && Number.isFinite(p.worldX) && Number.isFinite(p.worldY);
  const same = (a, b) => valid(a) && valid(b) && a.worldX === b.worldX && a.worldY === b.worldY;
  const visits = [];
  let previous = frames[0];
  const end = frames.length - (skipFinalRollback ? 1 : 0);
  for (let i = 1; i < end; i++) {
    const position = frames[i];
    if (valid(position) && !same(previous, position)) {
      visits.push({ worldX: position.worldX, worldY: position.worldY });
    }
    previous = position;
  }
  // The normal final position already contributes one visit via positions[].
  if (!skipFinalRollback && same(visits.at(-1), frames.at(-1))) visits.pop();
  return visits;
}
