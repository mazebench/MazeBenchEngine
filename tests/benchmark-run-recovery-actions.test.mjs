import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecoveryActions } from '../benchmarking/ui/run-recovery-actions.mjs';

const reset = Date.parse('2026-10-26T19:47:48Z');
const run = {
  id: 'same-run', provider: 'muse-code', observation_mode: 'vision', status: 'failed',
  capability_boundary_verified: true, action_count: 1212,
  error: 'API error 429: Subscription quota exhausted. Your usage window resets at 2026-10-26T19:47:48Z.'
};

test('quota recovery resumes the same run and unlocks at the reported reset', () => {
  const before = runRecoveryActions(run, reset - 1);
  assert.equal(before.failureAction, 'resume');
  assert.equal(before.resumeVisible, true);
  assert.equal(before.resumeDisabled, true);
  assert.equal(before.resumeAt, reset);
  const after = runRecoveryActions(run, reset);
  assert.equal(after.failureAction, 'resume');
  assert.equal(after.resumeDisabled, false);
  assert.equal(after.resumeAt, null);
  assert.equal(run.action_count, 1212);
});

test('quota resume works across harnesses and observation modes', () => {
  for (const provider of ['muse-code', 'codex', 'claude-code', 'kimi-code', 'antigravity', 'grok-build', 'prime-agent']) {
    for (const observation_mode of ['ascii', 'vision']) {
      const controls = runRecoveryActions({ ...run, provider, observation_mode, harness: 'prime-inference-direct-v2' }, reset + 1);
      assert.equal(controls.failureAction, 'resume', `${provider} ${observation_mode}`);
      assert.equal(controls.resumeDisabled, false);
    }
  }
});

test('unknown reset times allow manual resume without creating a fresh run', () => {
  const controls = runRecoveryActions({ ...run, error: 'HTTP 429: too many requests' });
  assert.equal(controls.failureAction, 'resume');
  assert.equal(controls.resumeDisabled, false);
});

test('rate-limit recovery preserves integrity, completion, and active-run safeguards', () => {
  for (const overrides of [
    { capability_boundary_verified: false }, { game_status: 'won' }, { game_status: 'action-limit' },
    { runner_active: true }, { provider: 'prime-agent', harness: 'native-python' },
    { auto_recovery: { enabled: true, state: 'waiting', attempts: 0, max_attempts: 5 } }
  ]) {
    const controls = runRecoveryActions({ ...run, ...overrides }, reset + 1);
    assert.equal(controls.resumeVisible, false);
    assert.equal(controls.failureAction, null);
  }
});

test('ordinary paused runs still resume, while unrelated failures retain their existing action', () => {
  assert.equal(runRecoveryActions({ ...run, status: 'paused' }).resumeDisabled, false);
  const controls = runRecoveryActions({ ...run, error: 'Unrelated runner failure' });
  assert.equal(controls.resumeVisible, false);
  assert.equal(controls.failureAction, 'new');
});
