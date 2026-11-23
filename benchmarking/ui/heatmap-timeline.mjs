import { prepareHeatmap } from "./heatmap-comparison.mjs";

const validPosition = p => p && [p.worldX, p.worldY].every(n => Number.isInteger(n) && n >= 0 && n < 256);

// Match heatmapVisits exactly, while retaining action boundaries. Never infer
// paths between endpoints: old runs, teleports and undos may have no path trace.
export function heatmapTimeline(run) {
  const { actions, positions } = run;
  if (run.history_delta || !Array.isArray(actions) || !Array.isArray(positions)
    || (positions.length !== actions.length + 1 && (positions.length || actions.length))
    || (run.action_count != null && run.action_count !== actions.length)) {
    throw new Error("Complete movement history is unavailable for this run.");
  }
  const tiles = [], ends = new Uint32Array(actions.length + 1), counts = new Map();
  const times = new Float64Array(actions.length + 1), start = Date.parse(run.created_at);
  let timed = Number.isFinite(start), previous = start, trackedActions = 0;
  const add = position => {
    if (!validPosition(position)) return;
    const tile = position.worldY * 256 + position.worldX;
    tiles.push(tile); counts.set(tile, (counts.get(tile) || 0) + 1);
  };
  add(positions[0]); ends[0] = tiles.length;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (Array.isArray(action.traversedPositions)) {
      trackedActions++;
      for (const position of action.traversedPositions) add(position);
    }
    add(positions[i + 1]); ends[i + 1] = tiles.length;
    const at = Date.parse(action.at);
    if (!Number.isFinite(at) || at < previous) timed = false;
    times[i + 1] = at - start; previous = at;
  }
  const finalMap = prepareHeatmap({ trackedActions, points: [...counts].map(([tile, count]) => ({
    worldX: tile % 256, worldY: Math.floor(tile / 256), count,
  })) });
  return { tiles: Uint16Array.from(tiles), ends, times: timed ? times : null,
    moveCount: actions.length, elapsedMs: timed ? times[times.length - 1] : null, finalMap };
}

export function timelineState() {
  return { counts: new Map(), total: 0, cursor: 0, move: -1 };
}

// Called in increasing order by the encoder, so even very long histories are
// scanned only once. A negative threshold is the empty introductory frame.
export function advanceTimeline(state, timeline, mode, threshold) {
  if (threshold < 0) return state;
  if (mode === "elapsed" && !timeline.times) throw new Error("This run has incomplete timestamps. Choose Moves instead.");
  let move = state.move;
  if (mode === "elapsed") {
    while (move < timeline.moveCount && timeline.times[move + 1] <= threshold) move++;
  } else move = Math.max(move, Math.min(timeline.moveCount, Math.floor(threshold)));
  const end = move < 0 ? 0 : timeline.ends[move];
  while (state.cursor < end) {
    const tile = timeline.tiles[state.cursor++];
    state.counts.set(tile, (state.counts.get(tile) || 0) + 1); state.total++;
  }
  state.move = move;
  return state;
}

export function animationExtent(timelines, mode) {
  const animated = timelines.filter(t => !t.snapshot);
  if (!animated.length) throw new Error("These imported heatmaps contain final snapshots only. Select a local run with movement history to animate.");
  if (mode === "elapsed" && animated.some(t => !t.times)) throw new Error("A selected run has incomplete timestamps. Choose Moves instead.");
  return Math.max(0, ...animated.map(t => mode === "elapsed" ? t.elapsedMs : t.moveCount));
}
