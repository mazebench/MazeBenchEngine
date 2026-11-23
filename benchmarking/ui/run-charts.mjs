import { benchmarkFetch } from "./benchmark-api.mjs";
import { runTabVisible } from "./run-tabs.mjs";
// Shared dashboard entry; keep reporting outside the frozen agent runtime.
const anchor = document.querySelector(".token-panel");
const runId = new URLSearchParams(location.search).get("id");
const numberFormatter = new Intl.NumberFormat();
const number = value => numberFormatter.format(value);
const weighted = episode => episode.weighted_duration_ms ?? episode.duration_ms;
const duration = ms => ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  : ms < 3600000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`
    : `${Math.floor(ms / 3600000)}h ${Math.floor(ms % 3600000 / 60000)}m`;
let data = null, busy = false, receivedAt = 0;
const plots = new Map();

if (anchor && runId) {
  anchor.insertAdjacentHTML("afterend", `
    <article class="panel run-chart-panel" id="thinking-panel" aria-labelledby="thinking-title">
      <header class="panel-heading">
        <div><span>Fast ×2 · Standard ×1</span><strong id="thinking-title">Weighted thinking time</strong></div>
        <label class="run-chart-controls">Show <select id="thinking-window"><option value="100">Last 100 episodes</option><option value="500">Last 500 episodes</option><option value="all">All episodes</option></select></label>
      </header>
      <div class="run-chart-stats"><span>Episodes<strong id="thinking-count">—</strong></span><span>Total<strong id="thinking-total">—</strong></span><span>Median<strong id="thinking-median">—</strong></span><span>Longest<strong id="thinking-longest">—</strong></span><output class="run-chart-live" id="thinking-live">Loading timing data…</output></div>
      <div class="run-chart-wrap"><svg id="thinking-chart" role="img" aria-label="Thinking duration by episode"></svg><output class="token-tooltip" id="thinking-tooltip" hidden></output></div>
      <details class="run-chart-note"><summary>How thinking time is measured</summary><p>Fast-mode intervals count at 2× elapsed time; standard-mode intervals count at 1×. This is a benchmark weighting, not measured compute time. Hover for actual elapsed time. Each episode runs from a tool result (or turn start) to the next tool call or final response, including generation and network/server waiting. Tool execution and interrupted intervals are excluded. Total sums all recorded episodes plus the current episode, regardless of the selected range. Amber compaction intervals count toward Total but are excluded from median/longest. Dashed cyan shows the current episode. History includes attempts before rollbacks.</p></details>
    </article>
    <article class="panel run-chart-panel" id="gems-panel" aria-labelledby="gems-title">
      <header class="panel-heading"><div><span>Collection progress</span><strong id="gems-title">Gems by move</strong></div><code id="gems-current">—</code></header>
      <div class="run-chart-wrap"><svg id="gems-chart" role="img" aria-label="Gem count by move count"></svg><output class="token-tooltip" id="gems-tooltip" hidden></output></div>
      <p class="run-chart-note">Exact gem count after each recorded move/action, including blocked moves, undo, reset and camera actions. Steps change at the collecting action. Uses the retained history after a rollback.</p>
    </article>`);
  document.getElementById("thinking-window").addEventListener("change", renderThinking);
  for (const id of ["thinking", "gems"]) attachHover(id);
  const observer = new ResizeObserver(() => {
    for (const id of ["thinking-tooltip", "gems-tooltip"]) document.getElementById(id).hidden = true;
    if (data && runTabVisible("analysis")) { renderThinking(); renderGems(); }
  });
  observer.observe(document.getElementById("thinking-panel"));
  document.addEventListener("visibilitychange", refresh);
  document.addEventListener("run-tab-change", () => {
    if (data && runTabVisible("analysis")) { renderThinking(); renderGems(); }
    refresh();
  });
  setInterval(refresh, 5000);
  setInterval(() => { if (data?.thinking?.current && runTabVisible("analysis")) renderThinking(); }, 1000);
}

function axes(id, { minX = 0, maxX, maxY, xLabel, yLabel, yFormat = number, integerY = false }) {
  const svg = document.getElementById(`${id}-chart`);
  const width = Math.max(300, svg.clientWidth || 800), height = 260;
  const left = 70, right = width - 26, top = 26, bottom = 207;
  maxX = Math.max(minX + 1, maxX);
  maxY = Math.max(1, maxY);
  const x = value => left + (value - minX) / (maxX - minX) * (right - left);
  const y = value => bottom - value / maxY * (bottom - top);
  const tickCount = width < 550 ? 3 : 5;
  const yStep = integerY ? Math.max(1, Math.ceil(maxY / 4)) : maxY / 4;
  const horizontal = Array.from({ length: Math.floor(maxY / yStep) + 1 }, (_, i) => {
    const value = i * yStep;
    return `<line class="token-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="token-axis" x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${yFormat(value)}</text>`;
  }).join("");
  const vertical = [...new Set(Array.from({ length: tickCount }, (_, i) => Math.round(minX + i / (tickCount - 1) * (maxX - minX))))].map(value =>
    `<text class="token-axis" x="${x(value)}" y="228" text-anchor="middle">${number(value)}</text>`).join("");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  return { svg, x, y, left, right, top, bottom, width, minX, maxX,
    markup: `${horizontal}${vertical}<text class="token-axis" x="${left}" y="15">${yLabel}</text><text class="token-axis" x="${(left + right) / 2}" y="251" text-anchor="middle">${xLabel}</text>` };
}

function renderThinking() {
  if (!data) return;
  const value = data.thinking;
  document.getElementById("thinking-count").textContent = number(value.count);
  const median = value.weighted_median_ms ?? value.median_ms, longest = value.weighted_longest_ms ?? value.longest_ms;
  document.getElementById("thinking-median").textContent = duration(median);
  document.getElementById("thinking-longest").textContent = duration(longest);
  const fresh = !value.current || Date.now() - receivedAt < 15000;
  const advance = fresh ? Date.now() - receivedAt : 0;
  const current = value.current ? { ...value.current, duration_ms: value.current.duration_ms + advance,
    weighted_duration_ms: weighted(value.current) + advance * (value.current.weight || 1) } : null;
  document.getElementById("thinking-live").textContent = !fresh ? "Timing updates delayed"
    : current ? `Current: ${duration(weighted(current))} weighted · ${duration(current.duration_ms)} elapsed${current.compaction ? " · compaction observed" : ""}`
      : value.phase === "tool execution" ? "Executing tool…" : value.phase.replaceAll("-", " ");
  const limit = document.getElementById("thinking-window").value;
  const all = [...value.episodes, ...(current ? [current] : [])];
  const total = all.reduce((sum, episode) => sum + weighted(episode), 0);
  const totalElement = document.getElementById("thinking-total");
  totalElement.textContent = duration(total);
  const elapsedTotal = all.reduce((sum, episode) => sum + episode.duration_ms, 0);
  totalElement.title = `${number(Math.round(total / 1000))} weighted seconds; ${duration(elapsedTotal)} actual elapsed. Includes all recorded episodes, compaction intervals and the current episode.`;
  const points = limit === "all" ? all : all.slice(-Number(limit));
  const maxDuration = points.reduce((max, point) => Math.max(max, weighted(point)), 1000);
  const unit = maxDuration >= 3600000 ? 3600000 : maxDuration >= 60000 ? 60000 : 1000;
  const plot = axes("thinking", { minX: points[0]?.number ?? 1, maxX: points.at(-1)?.number ?? 1,
    maxY: Math.ceil(maxDuration / unit * 1.1), xLabel: "Thinking episode", yLabel: `Weighted ${unit === 1000 ? "seconds" : unit === 60000 ? "minutes" : "hours"}`,
    yFormat: v => Number(v.toFixed(1)).toString() });
  const completed = points.filter(point => point !== current);
  let marks = completed.length ? `<polyline class="thinking-series" points="${completed.map(point => `${plot.x(point.number)},${plot.y(weighted(point) / unit)}`).join(" ")}"/>` : "";
  for (const point of completed.filter(point => completed.length <= 500 || point.compaction)) marks += `<circle class="${point.compaction ? "thinking-compact" : "thinking-dot"}" cx="${plot.x(point.number)}" cy="${plot.y(weighted(point) / unit)}" r="${point.compaction ? 4 : 2.5}"/>`;
  if (current) {
    const last = completed.at(-1);
    if (last) marks += `<line class="thinking-live-line" x1="${plot.x(last.number)}" y1="${plot.y(weighted(last) / unit)}" x2="${plot.x(current.number)}" y2="${plot.y(weighted(current) / unit)}"/>`;
    marks += `<circle class="token-current-dot" cx="${plot.x(current.number)}" cy="${plot.y(weighted(current) / unit)}" r="4"/>`;
  }
  if (!points.length) marks = `<text class="token-empty" x="${plot.width / 2}" y="118" text-anchor="middle">No completed thinking episodes yet.</text>`;
  plot.svg.innerHTML = plot.markup + marks;
  plot.svg.setAttribute("aria-label", `${value.count} completed thinking episodes. Weighted total ${duration(total)}, including the current episode. Weighted median ${duration(median)}. Weighted longest ${duration(longest)}. Fast mode counts at 2× elapsed time.`);
  plots.set("thinking", { ...plot, points, unit });
}

function renderGems() {
  const value = data.gems;
  document.getElementById("gems-panel").hidden = !value.applicable;
  if (!value.applicable) return;
  document.getElementById("gems-current").textContent = `${number(value.collected)} / ${number(value.total)} gems · ${number(value.moves)} moves`;
  const max = value.points.reduce((max, point) => Math.max(max, point.gems), 1);
  const maxY = Math.ceil(max / Math.max(1, Math.ceil(max / 4))) * Math.max(1, Math.ceil(max / 4));
  const plot = axes("gems", { maxX: value.moves, maxY, xLabel: "Move count", yLabel: "Gem count", integerY: true });
  const points = value.points.flatMap((point, index) => [
    ...(index ? [`${plot.x(point.move)},${plot.y(value.points[index - 1].gems)}`] : []),
    `${plot.x(point.move)},${plot.y(point.gems)}`
  ]);
  const dots = value.points.filter((point, i) => i === 0 || point.gems !== value.points[i - 1].gems).map(point =>
    `<circle class="gem-dot" cx="${plot.x(point.move)}" cy="${plot.y(point.gems)}" r="3"/>`).join("");
  plot.svg.innerHTML = plot.markup + (value.available ? `<polyline class="gem-series" points="${points.join(" ")}"/>${dots}`
    : `<text class="token-empty" x="${plot.width / 2}" y="118" text-anchor="middle">Gem history unavailable.</text>`);
  plot.svg.setAttribute("aria-label", `${value.collected} gems after ${value.moves} moves. Gem count over retained move history.`);
  plots.set("gems", { ...plot, points: value.points });
}

function attachHover(id) {
  const svg = document.getElementById(`${id}-chart`), tooltip = document.getElementById(`${id}-tooltip`);
  svg.addEventListener("pointermove", event => {
    const plot = plots.get(id);
    if (!plot?.points.length) return;
    const bounds = svg.getBoundingClientRect();
    const px = (event.clientX - bounds.left) / bounds.width * plot.width;
    const value = plot.minX + Math.max(0, Math.min(1, (px - plot.left) / (plot.right - plot.left))) * (plot.maxX - plot.minX);
    if (id === "thinking") {
      const point = plot.points.reduce((best, p) => Math.abs(p.number - value) < Math.abs(best.number - value) ? p : best);
      tooltip.textContent = `Episode ${number(point.number)} · ${duration(weighted(point))} weighted · ${duration(point.duration_ms)} elapsed · after action ${number(point.action_count)}${point.room ? ` · ${point.room}` : ""} · ${point.next_tool || "in progress"}${point.compaction ? " · includes compaction" : ""}`;
    } else {
      const move = Math.min(data.gems.moves, Math.round(value));
      const point = plot.points.findLast(p => p.move <= move);
      tooltip.textContent = point ? `Move ${number(move)} · ${number(point.gems)} gems` : "No recorded gem count at this move";
    }
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(bounds.width - tooltip.offsetWidth - 8, event.clientX - bounds.left + 12))}px`;
  });
  svg.addEventListener("pointerleave", () => { tooltip.hidden = true; });
}

async function refresh() {
  if (busy || !runTabVisible("analysis")) return;
  if (Date.now() - receivedAt < (document.body.dataset.runnerActive === "true" ? 5000 : 60000)) return;
  busy = true;
  try {
    const response = await benchmarkFetch(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/charts`);
    if (!response.ok) throw new Error("Chart telemetry unavailable");
    data = await response.json(); receivedAt = Date.now();
    renderThinking(); renderGems();
  } catch {
    document.getElementById("thinking-live").textContent = "Chart telemetry unavailable · retrying…";
  } finally { busy = false; }
}
