// Report-only derivation from existing records. No game state or run manifest
// changes are needed, including for Ice Maze runs already in progress.
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const liveStatuses = new Set(["preparing", "queued", "running", "continuing", "pausing"]);

export function iceLevelTimings(run, now = Date.now()) {
  if (run?.world !== "ice-maze") return [];
  const total = Number.isInteger(run.levels_total) && run.levels_total > 0 ? Math.min(1000, run.levels_total) : 30;
  const rows = Array.from({ length: total }, (_, i) => ({ level: i + 1, entered: i === 0, started_at: i === 0 ? timestamp(run.created_at) : null,
    solved_at: null, solved: false, actions: 0, solve_action: null }));
  for (const action of run.actions || []) {
    if (!Number.isInteger(action.level)) continue;
    const row = rows[action.level - 1];
    if (!row) continue;
    row.entered = true;
    if (action.action === "next") {
      // Entering a board starts its timer, but is not a move on that board.
      row.started_at ??= timestamp(action.at);
      continue;
    }
    row.actions++;
    if (!row.solved && action.levelsSolved >= row.level) {
      row.solved = true; row.solved_at = timestamp(action.at); row.solve_action = action.index;
    }
  }
  const live = liveStatuses.has(run.status) && run.runner_active !== false;
  const stoppedAt = timestamp(run.status === "paused" ? run.paused_at : run.status === "stopped" ? run.stopped_at : run.completed_at) ?? timestamp(run.updated_at);
  const end = live ? now : stoppedAt;
  return rows.map(row => {
    // Older or incomplete records can still identify solved levels, but must
    // never invent a finish time or display an unknown duration as zero.
    row.solved ||= row.level <= (run.levels_solved || 0);
    row.entered ||= row.solved || row.level === run.level_number;
    const finish = row.solved ? row.solved_at : end;
    return { ...row,
      status: row.solved ? "solved" : !row.entered ? "pending" : live ? "playing" : run.status === "paused" ? "paused" : "unsolved",
      elapsed_ms: row.entered && row.started_at !== null && finish !== null && finish >= row.started_at ? finish - row.started_at : null };
  });
}

export function formatLevelDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function renderIceLevelTimings(run, document, now = Date.now()) {
  const panel = document.getElementById("ice-level-timings");
  panel.hidden = run.world !== "ice-maze";
  if (panel.hidden) return;
  const rows = run.ice_timing_rows || iceLevelTimings(run, now), solved = rows.filter(row => row.solved);
  const current = rows.find(row => row.status === "playing");
  document.getElementById("ice-level-timings-summary").textContent = `${solved.length} / ${rows.length} solved${current ? ` · Level ${current.level} in progress` : ""}`;
  const body = document.getElementById("ice-level-timings-body");
  const maximum = Math.max(1, ...rows.map(row => row.elapsed_ms || 0));
  // Keep existing rows so live updates preserve keyboard focus and scrolling.
  if (body.children.length !== rows.length) {
    body.replaceChildren(...rows.map(row => {
      const tr = document.createElement("tr"), heading = document.createElement("th");
      heading.scope = "row"; heading.textContent = `Level ${row.level}`; tr.append(heading);
      for (let i = 0; i < 3; i++) tr.append(document.createElement("td"));
      const bar = document.createElement("i"), time = document.createElement("span");
      bar.setAttribute("aria-hidden", "true"); tr.children[2].className = "ice-level-duration"; tr.children[2].append(bar, time);
      return tr;
    }));
  }
  for (const [index, row] of rows.entries()) {
    const tr = body.children[index]; tr.dataset.status = row.status;
    tr.children[1].textContent = { solved: "Solved", pending: "Not started", playing: "In progress", paused: "Paused", unsolved: "Unsolved" }[row.status];
    tr.children[2].lastChild.textContent = formatLevelDuration(row.elapsed_ms);
    tr.children[2].firstChild.style.width = `${Math.max(0, (row.elapsed_ms || 0) / maximum * 100)}%`;
    tr.children[3].textContent = row.entered ? row.actions.toLocaleString() : "—";
  }
}
