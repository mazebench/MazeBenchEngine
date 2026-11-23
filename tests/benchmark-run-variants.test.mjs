import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRunVariants } from '../benchmarking/ui/run-variants.mjs';

const run = (id, overrides = {}) => ({
  id, model: 'gpt-6.1-terra', provider: 'codex', world: 'main-world',
  observation_mode: 'ascii', coding_mode: 'off', effort: 'max',
  action_count: 100, created_at: '2026-10-26T18:00:00Z', ...overrides
});

test('replays include ASCII and Vision conditions across launch pairs and without a pair', () => {
  const current = run('ascii-off', { pair_id: 'ascii-pair' });
  const library = [current,
    run('ascii-on', { pair_id: 'ascii-pair', coding_mode: 'python' }),
    run('vision-off', { pair_id: 'vision-pair', observation_mode: 'vision' }),
    run('vision-on', { pair_id: 'vision-pair', observation_mode: 'vision', coding_mode: 'python' }),
    run('ascii-any', { coding_mode: 'any' })];
  const original = [...library];
  assert.deepEqual(selectRunVariants(current, library).map(r => r.id),
    ['ascii-off', 'ascii-on', 'ascii-any', 'vision-off', 'vision-on']);
  assert.deepEqual(library, original, 'selection must not sort the shared library');
  assert.equal(selectRunVariants({ ...current, pair_id: undefined }, library).length, 5);
});

test('older implicit ASCII/Codex/main-world records match explicit vision metadata', () => {
  const current = run('ascii', { provider: undefined, world: undefined, observation_mode: undefined, coding_mode: undefined, tools_enabled: true });
  const vision = run('vision', { observation_mode: 'vision', coding_mode: undefined, tools_enabled: true });
  assert.deepEqual(selectRunVariants(current, [vision]).map(r => r.id), ['ascii', 'vision']);
});

test('unrelated models, harness providers, and worlds do not enter the switcher', () => {
  const current = run('current');
  assert.deepEqual(selectRunVariants(current, [
    run('model', { model: 'gpt-6.1-sol' }),
    run('provider', { provider: 'prime-agent' }),
    run('world', { world: 'ice-maze' }),
    run('empty', { model: undefined })
  ]), [current]);
});

test('retries collapse per condition while preserving the open run and freshest counters', () => {
  const current = run('current', { action_count: 123 });
  const library = [
    { ...current, action_count: 99 },
    run('new-repeat', { runner_active: true, created_at: '2026-10-26T20:00:00Z' }),
    run('vision-failed', { observation_mode: 'vision', action_count: 0, status: 'failed', created_at: '2026-10-26T22:00:00Z' }),
    run('vision-old', { observation_mode: 'vision', action_count: 900 }),
    run('vision-active', { observation_mode: 'vision', runner_active: true, action_count: 150, created_at: '2026-10-26T19:00:00Z' })
  ];
  assert.deepEqual(selectRunVariants(current, library), [current, library[4]]);
  assert.deepEqual(selectRunVariants(current, library.slice(0, 4)), [current, library[3]]);
});

test('distinct speed, effort, and benchmark versions remain available', () => {
  const current = run('current', { model: 'k3.1-pro', provider: 'kimi-code' });
  const others = [
    { ...current, id: 'fast', model: 'k3.1-pro-highspeed' },
    { ...current, id: 'high', effort: 'high' },
    { ...current, id: 'legacy', benchmark_version: { benchmark_release: '1.0' } }
  ];
  assert.deepEqual(new Set(selectRunVariants(current, others).map(r => r.id)), new Set(['current', 'fast', 'high', 'legacy']));
  assert.deepEqual(selectRunVariants(null, others), []);
});
