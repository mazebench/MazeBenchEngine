// Read historical artifacts only. Never start the old run service or replay
// historical commands against today's engine/levels to invent missing visits.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { readLegacyRunVersion } from './legacy-run-version.mjs';
import { importLeaderboardHeatmap } from './ui/heatmap-import.mjs';

export function legacyTools(meta) {
  const harness = String(meta.harness || meta.launch_params?.harness || '').toLowerCase().replaceAll('-', '_');
  if (harness === 'mazebench_prime_agent') return { enabled: true, basis: 'native-python-harness' };
  for (const value of [meta.tools, meta.launch_params?.tools]) {
    if (typeof value === 'boolean') return { enabled: value, basis: 'recorded-tools-flag' };
  }
  const toolUse = meta.tool_use || meta.launch_params?.tool_use;
  if (['read-only', 'offline'].includes(toolUse)) return { enabled: toolUse === 'offline', basis: 'recorded-tool-use' };
  // The historical Prime launcher defaulted tools to false, including its
  // native Kimi Code harness. Native Prime Agent above always exposes Python.
  if (meta.kind === 'prime' || meta.model === 'prime') return { enabled: false, basis: 'legacy-prime-default' };
  return { enabled: undefined, basis: 'unrecorded' };
}

export function legacyPosition(status) {
  const player = status?.player;
  if (player && [player.x, player.y].every(n => Number.isInteger(n) && n >= 0 && n < 16)) return { x: player.x, y: player.y };
  if (status?.current_view !== 'top' || typeof status.level !== 'string') return null;
  // Same inverse camera mapping as the old run viewer. Pitched ASCII views
  // mix depth and elevation and cannot be safely decoded this way.
  const rows = status.level.split(/\r?\n/);
  const ys = [], xs = [];
  for (const [y, row] of rows.entries()) for (let x = 0; x < row.length; x++) if (row[x] === 'P') { xs.push(x); ys.push(y); }
  if (!xs.length) return null;
  const x = Math.floor(Math.min(...xs) / 4), y = Math.floor(Math.min(...ys) / 4);
  if (x >= 16 || y >= 16) return null;
  switch (((Number(status.yaw) || 0) % 4 + 4) % 4) {
    case 1: return { x: y, y: 15 - x };
    case 2: return { x: 15 - x, y: 15 - y };
    case 3: return { x: 15 - y, y: x };
    default: return { x, y };
  }
}

async function optionalJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function readLegacyHeatmap(directory, options, previousReport = null) {
  const meta = await optionalJson(path.join(directory, 'run.json'));
  if (!meta) throw new Error('Missing historical run metadata.');
  const level = meta.level_id || meta.launch_params?.level_id;
  if (!/^level_[A-P]x[A-P]$/i.test(level || '') || (meta.game_id && meta.game_id !== 'maze')) throw new Error('Not a Main World run.');
  const cells = new Map(), rooms = new Set([level]);
  let actions = 0, recordedActions = 0, initialRecorded = false, gems = 0;
  const visit = (status, fallbackRoom, action = false) => {
    const room = status?.current_room || fallbackRoom;
    if (!/^level_[A-P]x[A-P]$/i.test(room || '')) return false;
    const position = legacyPosition(status);
    if (!position) return false;
    const [column, row] = room.slice(6).toUpperCase().split('X');
    const x = (column.charCodeAt(0) - 65) * 16 + position.x;
    const y = (row.charCodeAt(0) - 65) * 16 + position.y;
    const key = `${x},${y}`;
    cells.set(key, (cells.get(key) || 0) + 1);
    rooms.add(room);
    if (action) recordedActions++;
    return true;
  };
  const initial = await optionalJson(path.join(directory, 'initial-status.json'));
  if (initial) initialRecorded = visit(initial, level);
  try {
    const stream = createInterface({ input: createReadStream(path.join(directory, 'actions.jsonl')), crlfDelay: Infinity });
    for await (const line of stream) {
      if (!line.trim()) continue;
      const record = JSON.parse(line), status = record.status || record;
      actions++;
      visit(status, status.current_room || level, true);
      for (const room of status.visited_levels || []) if (/^level_[A-P]x[A-P]$/i.test(room)) rooms.add(room);
      if (Number.isFinite(status.gem_count)) gems = Math.max(gems, status.gem_count);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tools = legacyTools(meta);
  const result = importLeaderboardHeatmap({ run: {
    id: meta.id || path.basename(directory), model_name: meta.model_name || meta.model,
    provider: meta.kind === 'prime' ? 'prime' : meta.model,
    level_id: level, url: '/agent/runs/' + encodeURIComponent(meta.id || path.basename(directory)),
    mode: meta.mode || meta.launch_params?.mode || 'text', tools: tools.enabled,
    tool_use: meta.tool_use || meta.launch_params?.tool_use || 'unknown',
    reasoning: meta.reasoning || meta.reasoning_effort || meta.launch_params?.reasoning || meta.launch_params?.reasoning_effort,
    harness: meta.harness || meta.launch_params?.harness,
    harness_label: meta.harness_label || ({ kimi: 'Kimi Code', claude: 'Claude Code', codex: 'Codex' })[meta.model],
    created_at: meta.created_at, status: meta.status, turns: actions, room_count: rooms.size, gem_count: gems
  }, heatmap: { room_size: 16, cells: [...cells].map(([key, count]) => [...key.split(',').map(Number), count]),
    unique_cells: cells.size, total_visits: [...cells.values()].reduce((sum, count) => sum + count, 0) }
  }, { ...options, allowEmpty: true });
  result.metadata.benchmark_version = readLegacyRunVersion(directory);
  const source = result.metadata.source;
  source.tools_basis = tools.basis;
  source.position_source = 'recorded-player-or-top-view';
  source.position_coverage = { actions: recordedActions, total_actions: actions, initial: initialRecorded };
  // Retain a prior comparison snapshot if it recovered more history for this
  // exact action count. Do not shrink an existing map or combine counts from
  // overlapping snapshots. Its original provenance remains explicit.
  if (previousReport?.action_count === actions && previousReport.heatmap?.total > result.report.heatmap.total) {
    result.report.heatmap = previousReport.heatmap;
    source.position_source = 'previous-import';
    source.previous_imported_at = previousReport.source?.imported_at;
    delete source.position_coverage;
  }
  result.metadata.heatmap_available = result.report.heatmap.points.length > 0;
  return result;
}
