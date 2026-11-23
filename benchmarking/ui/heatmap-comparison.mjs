import { modelSlug } from "./model-label.mjs";
import { heatmapVisits } from "./heatmap.mjs";

// All maps use this one coordinate system and one logarithmic color scale.
const WORLD_SIZE = 256, ROOM_SIZE = 16;
export const HEAT_COLORS = [[255, 213, 87], [255, 126, 58], [222, 55, 92], [148, 72, 214]];

export function prepareHeatmap(heatmap = {}) {
  const counts = new Map();
  for (const point of heatmap.points || []) {
    const { worldX: x, worldY: y, count } = point || {};
    if (![x, y].every(n => Number.isInteger(n) && n >= 0 && n < WORLD_SIZE) || !Number.isFinite(count) || count <= 0) continue;
    const key = `${x},${y}`;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  const points = [...counts].map(([key, count]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, count };
  });
  return { points, counts, total: points.reduce((sum, p) => sum + p.count, 0), trackedActions: heatmap.trackedActions || 0 };
}

// Older vision owners return complete movement history for ?view=analysis;
// newer owners return aggregated points. Both represent the same world tiles.
export function comparisonReport(value) {
  let heatmap = value.heatmap;
  if (!heatmap) {
    if (value.history_delta || !Array.isArray(value.positions)) throw new Error("Complete visit history is unavailable.");
    const visits = heatmapVisits(value);
    heatmap = { trackedActions: visits.trackedActions,
      points: visits.positions.filter(Boolean).map(p => ({ ...p, count: 1 })) };
  }
  return { map: prepareHeatmap(heatmap), actions: value.action_count || 0 };
}

export function comparisonBounds(maps, fullWorld = false) {
  const points = maps.flatMap(map => map?.points || []);
  if (fullWorld || !points.length) return { minX: 0, minY: 0, columns: WORLD_SIZE, rows: WORLD_SIZE };
  let minX = WORLD_SIZE, minY = WORLD_SIZE, maxX = 0, maxY = 0;
  for (const { x, y } of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  // Round out to complete rooms so room labels and unvisited space stay legible.
  minX = Math.floor(minX / ROOM_SIZE) * ROOM_SIZE;
  minY = Math.floor(minY / ROOM_SIZE) * ROOM_SIZE;
  return { minX, minY, columns: Math.ceil((maxX + 1) / ROOM_SIZE) * ROOM_SIZE - minX,
    rows: Math.ceil((maxY + 1) / ROOM_SIZE) * ROOM_SIZE - minY };
}

export function croppedBounds(map) {
  if (!map?.points.length) return { minX: 0, minY: 0, columns: 1, rows: 1 };
  let minX = WORLD_SIZE, minY = WORLD_SIZE, maxX = 0, maxY = 0;
  for (const { x, y } of map.points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, columns: maxX - minX + 1, rows: maxY - minY + 1 };
}

export function visitValue(count, total, scale) {
  return scale === "share" ? (total ? count / total * 100 : 0) : count;
}

export function comparisonScale(maps, scale = "count") {
  let maximum = 0, minimum = Infinity;
  for (const map of maps.filter(Boolean)) for (const point of map.points) {
    const value = visitValue(point.count, map.total, scale);
    maximum = Math.max(maximum, value); minimum = Math.min(minimum, value);
  }
  return { maximum, minimum: Number.isFinite(minimum) ? minimum : 0 };
}

export function heatColor(value, { minimum, maximum }) {
  const fraction = maximum > minimum ? Math.log(value / minimum) / Math.log(maximum / minimum) : 0;
  const scaled = Math.max(0, Math.min(1, fraction)) * (HEAT_COLORS.length - 1);
  const index = Math.min(HEAT_COLORS.length - 2, Math.floor(scaled)), blend = scaled - index;
  return `rgb(${HEAT_COLORS[index].map((channel, i) => Math.round(channel + (HEAT_COLORS[index + 1][i] - channel) * blend)).join(",")})`;
}

export function mapLayout(bounds, size) {
  const cell = (size - 48) / Math.max(bounds.columns, bounds.rows);
  return { ...bounds, cell, left: (size - bounds.columns * cell) / 2, top: (size - bounds.rows * cell) / 2 };
}

export function tileAt(layout, x, y) {
  const column = Math.floor((x - layout.left) / layout.cell), row = Math.floor((y - layout.top) / layout.cell);
  if (column < 0 || row < 0 || column >= layout.columns || row >= layout.rows) return null;
  return { x: layout.minX + column, y: layout.minY + row };
}

export function roomAt({ x, y }) {
  return `${String.fromCharCode(65 + Math.floor(x / ROOM_SIZE))}×${String.fromCharCode(65 + Math.floor(y / ROOM_SIZE))}`;
}

export function defaultComparison(runs, leftId, rightId, thirdId, count = 2) {
  const find = id => runs.find(run => run.id === id);
  const left = find(leftId) || runs.find(run => run.model === "gpt-6-luna" && !run.tools_enabled) || runs[0];
  const candidates = runs.filter(run => run.id !== left?.id);
  const right = find(rightId) || candidates.find(run => /^claude-haiku-5[.-]5$/.test(run.model) && Boolean(run.tools_enabled) === Boolean(left?.tools_enabled))
    || candidates.find(run => run.model !== left?.model && Boolean(run.tools_enabled) === Boolean(left?.tools_enabled)) || candidates[0];
  const choices = [left?.id || "", right?.id || ""];
  if (count === 3) {
    const remaining = runs.filter(run => !choices.includes(run.id));
    const third = find(thirdId) || remaining.find(run => /^claude-haiku-4[.-]5(?:-|$)/.test(run.model))
      || remaining.find(run => run.model !== left?.model && run.model !== right?.model) || remaining[0];
    choices.push(third?.id || "");
  }
  return choices;
}

export function displayModelName(model = "") {
  return modelSlug(model);
}

export function drawComparisonMap(canvas, map, bounds, scale, colors, selected, { screenshotMode = false, screenshotCell = 1 } = {}) {
  canvas.style.width = screenshotMode ? `${bounds.columns * screenshotCell}px` : "";
  canvas.style.height = screenshotMode ? `${bounds.rows * screenshotCell}px` : "";
  const width = canvas.clientWidth, height = screenshotMode ? canvas.clientHeight : width;
  if (!width || !height) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = screenshotMode ? "#000" : "#101113"; ctx.fillRect(0, 0, width, height);
  const layout = screenshotMode ? { ...bounds, left: 0, top: 0, cell: screenshotCell } : mapLayout(bounds, width);
  const { left, top, cell, minX, minY, columns, rows } = layout;
  if (!screenshotMode) { ctx.fillStyle = "#1b1c20"; ctx.fillRect(left, top, columns * cell, rows * cell); }
  const inset = !screenshotMode && cell > 4 ? Math.min(.7, cell / 12) : 0;
  for (const point of map?.points || []) {
    ctx.fillStyle = heatColor(visitValue(point.count, map.total, scale), colors);
    const x = left + (point.x - minX) * cell, y = top + (point.y - minY) * cell;
    if (screenshotMode) {
      // Shared physical-pixel edges prevent antialiasing seams looking like a grid.
      const x1 = Math.round(x * ratio), y1 = Math.round(y * ratio);
      ctx.fillRect(x1 / ratio, y1 / ratio, (Math.round((x + cell) * ratio) - x1) / ratio, (Math.round((y + cell) * ratio) - y1) / ratio);
    } else ctx.fillRect(x + inset, y + inset, cell - inset * 2, cell - inset * 2);
  }
  if (screenshotMode) return layout;
  ctx.strokeStyle = "#ffffff25"; ctx.lineWidth = 1;
  ctx.fillStyle = "#98989f"; ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let column = 0; column <= columns; column += ROOM_SIZE) {
    const x = left + column * cell;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + rows * cell); ctx.stroke();
    if (column < columns) ctx.fillText(String.fromCharCode(65 + (minX + column) / ROOM_SIZE), x + ROOM_SIZE * cell / 2, top - 12);
  }
  for (let row = 0; row <= rows; row += ROOM_SIZE) {
    const y = top + row * cell;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + columns * cell, y); ctx.stroke();
    if (row < rows) ctx.fillText(String.fromCharCode(65 + (minY + row) / ROOM_SIZE), left - 12, y + ROOM_SIZE * cell / 2);
  }
  if (selected && selected.x >= minX && selected.y >= minY && selected.x < minX + columns && selected.y < minY + rows) {
    const x = left + (selected.x - minX) * cell, y = top + (selected.y - minY) * cell;
    ctx.strokeStyle = "#ffffff70"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + cell / 2, top); ctx.lineTo(x + cell / 2, top + rows * cell);
    ctx.moveTo(left, y + cell / 2); ctx.lineTo(left + columns * cell, y + cell / 2); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.strokeRect(x - 1, y - 1, cell + 2, cell + 2);
  }
  return layout;
}
