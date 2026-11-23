import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { legacyTools, legacyPosition, readLegacyHeatmap } from '../benchmarking/legacy-heatmap-import.mjs';
import { comparisonCondition, comparisonConditionKey, comparisonModel } from '../benchmarking/ui/heatmap-import.mjs';

const options = { origin: 'http://localhost:3000', sourceKey: 'source', importedAt: '2026-10-24T04:00:00Z' };

test('legacy K3 aliases share a model selector while tool conditions and reasoning stay distinct', () => {
  const off = legacyTools({ kind: 'prime', harness: 'kimi_code' });
  assert.equal(off.enabled, false);
  assert.equal(legacyTools({ tools: true, tool_use: 'offline' }).enabled, true);
  assert.equal(legacyTools({ launch_params: { tools: false } }).enabled, false);
  assert.equal(legacyTools({ harness: 'mazebench_prime_agent', tools: false }).enabled, true);
  assert.equal(legacyTools({}).enabled, undefined);
  const imported = { source: { tool_use: 'unknown' }, tools_enabled: off.enabled };
  assert.equal(comparisonCondition(imported), 'Tools off');
  assert.equal(comparisonConditionKey(imported), comparisonConditionKey({ tools_enabled: false }));
  assert.equal(comparisonModel('moonshotai/kimi-k3'), comparisonModel('kimi/k3'));
  assert.notEqual(comparisonModel('kimi/k3'), comparisonModel('k3.1-pro'));
});

test('recorded top views invert yaw without inventing coordinates for pitched observations', () => {
  const rows = Array.from({ length: 64 }, () => ' '.repeat(64));
  rows[20] = ' '.repeat(12) + 'PPPP' + ' '.repeat(48);
  const status = { current_view: 'top', level: rows.join('\n') };
  assert.deepEqual(legacyPosition({ ...status, yaw: 0 }), { x: 3, y: 5 });
  assert.deepEqual(legacyPosition({ ...status, yaw: 1 }), { x: 5, y: 12 });
  assert.deepEqual(legacyPosition({ ...status, yaw: 2 }), { x: 12, y: 10 });
  assert.deepEqual(legacyPosition({ ...status, yaw: 3 }), { x: 10, y: 3 });
  assert.equal(legacyPosition({ ...status, current_view: 'top-diagonal' }), null);
  assert.deepEqual(legacyPosition({ player: { x: 4, y: 12 }, current_view: 'side' }), { x: 4, y: 12 });
});

test('an unstarred historical run imports every recorded position and preserves unknown coverage', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legacy-heatmap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ id: 'old-k3', kind: 'prime', model: 'prime', model_name: 'moonshotai/kimi-k3',
    harness: 'kimi_code', reasoning: 'high', level_id: 'level_HxI', game_id: 'maze', mode: 'text', status: 'finished' }));
  await writeFile(path.join(directory, 'initial-status.json'), JSON.stringify({ current_room: 'level_HxI', player: { x: 4, y: 12 } }));
  await writeFile(path.join(directory, 'actions.jsonl'), [
    { status: { current_room: 'level_HxI', player: { x: 4, y: 11 }, gem_count: 0 } },
    { status: { current_room: 'level_HxH', player: { x: 4, y: 15 }, gem_count: 1 } },
    { status: { current_room: 'level_HxH' } }
  ].map(JSON.stringify).join('\n') + '\n');
  const { metadata, report } = await readLegacyHeatmap(directory, options);
  assert.equal(metadata.action_count, 3); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.effort, 'high'); assert.equal(metadata.rooms_visited, 2); assert.equal(metadata.gems_collected, 1);
  assert.deepEqual(report.heatmap.points, [{ worldX: 116, worldY: 140, count: 1 }, { worldX: 116, worldY: 139, count: 1 }, { worldX: 116, worldY: 127, count: 1 }]);
  assert.deepEqual(metadata.source.position_coverage, { actions: 2, total_actions: 3, initial: true });
  const previous = { action_count: 3, heatmap: { points: [{ worldX: 116, worldY: 140, count: 4 }], total: 4 }, source: { imported_at: 'old' } };
  const preserved = await readLegacyHeatmap(directory, options, previous);
  assert.deepEqual(preserved.report.heatmap, previous.heatmap);
  assert.equal(preserved.metadata.source.position_source, 'previous-import');
});

test('a failed launch without positions is retained as an explicitly empty comparison', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'legacy-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'run.json'), JSON.stringify({ id: 'empty', model: 'kimi', model_name: 'kimi/k3', level_id: 'level_HxI', tools: true, status: 'failed' }));
  const { metadata, report } = await readLegacyHeatmap(directory, options);
  assert.equal(metadata.heatmap_available, false);
  assert.equal(metadata.tools_enabled, true);
  assert.equal(report.action_count, 0);
  assert.deepEqual(report.heatmap.points, []);
});
