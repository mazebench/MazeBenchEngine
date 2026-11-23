// Operator-only correction of an authentication failure mislabeled as model
// activity by an older immutable runner. Never discard actual pre-init activity.
import assert from 'node:assert/strict';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, runtimeHashes, verifyIntegrity } from './antigravity/policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from './v1/integrity.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { readJsonLinesTail } from './storage/tail-jsonl.mjs';
import { atomicJson } from './providers/claude-runner.mjs';
const ERROR = 'Antigravity emitted activity before initialization.';
export function inspectAuthenticationFailure(events) {
  const last = events.at(-1); assert(last?._turn_id, 'Missing attempt identity.');
  const turn = events.filter(e => e._turn_id === last._turn_id);
  assert.equal(turn.length, 1, 'Authentication attempt contained activity.');
  assert.equal(last.event, 'result');
  assert.deepEqual(Object.keys(last).sort(), ['_received_at', '_turn_id', 'event', 'result']);
  const result = last.result;
  assert.deepEqual(Object.keys(result).sort(), ['conversation_id', 'duration_seconds', 'error', 'num_turns', 'response', 'status', 'usage']);
  assert.equal(result.conversation_id, ''); assert.equal(result.status, 'ERROR'); assert.equal(result.response, '');
  assert.equal(result.error, 'authentication failed or timed out'); assert.equal(result.duration_seconds, 0); assert.equal(result.num_turns, 0);
  assert.deepEqual(Object.keys(result.usage).sort(), ['cache_read_tokens', 'input_tokens', 'output_tokens', 'thinking_tokens', 'total_tokens']);
  assert(Object.values(result.usage).every(v => v === 0), 'Authentication attempt consumed model tokens.');
  return { turn_id: last._turn_id, failed_at: last._received_at };
}
export async function recoverAntigravityInitialization({ root, directory, assertInactive, apply = false }) {
  const read = name => readFile(path.join(directory, name));
  const before = await read('run.json'), metadata = JSON.parse(before), violationBytes = await read('integrity-violation.json'), violation = JSON.parse(violationBytes);
  assert.equal(metadata.provider, 'antigravity'); assert.equal(metadata.status, 'failed'); assert.equal(metadata.error, ERROR); assert.equal(violation.error, ERROR);
  assert.equal(metadata.capability_policy.name, 'antigravity-mcp-only-v1');
  await assertInactive(metadata);
  const events = await readJsonLinesTail(path.join(directory, 'antigravity-events.jsonl'), 64);
  const evidence = inspectAuthenticationFailure(events);
  assert(Math.abs(Date.parse(evidence.failed_at) - Date.parse(violation.at)) < 1000);
  const activity = await readJsonLinesTail(path.join(directory, 'tool-activity.jsonl'), 1);
  assert(activity.length && activity[0].status === 'completed');
  assert(Date.parse(activity[0].completed_at) < Date.parse(evidence.failed_at));
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity); assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  const frozen = manifest.configuration;
  assert.deepEqual(await runtimeHashes(root), frozen.antigravity_runtime);
  assert.equal(digest(await readFile(frozen.antigravity_executable)), frozen.antigravity_sha256);
  for (const [file, hash] of Object.entries(frozen.antigravity_config)) assert.equal(digest(await readFile(file)), hash);
  assert.equal(digest(await read('prompt.md')), frozen.effective_prompt_sha256);
  const summary = await readCheckpointJson(directory, 'summary.json');
  assert(!['won', 'action-limit'].includes(summary.game_status)); assert.equal(activity[0].action_count_after, summary.action_count);
  const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md', 'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
  const preserved = Object.fromEntries(await Promise.all(files.map(async name => [name, digest(await read(name))])));
  const audit = { kind: 'authentication-before-initialization', phase: 'prepared', at: new Date().toISOString(), run_id: metadata.id,
    conversation_id: metadata.antigravity_session_id, action_count: summary.action_count, ...evidence, preserved_sha256: preserved,
    reason: 'Zero-turn, zero-token authentication failure; no model or tool activity. Preserve the saved conversation and checkpoint.' };
  if (!apply) return audit;
  await assertInactive(metadata); assert((await read('run.json')).equals(before)); assert((await read('integrity-violation.json')).equals(violationBytes));
  for (const [name, hash] of Object.entries(preserved)) assert.equal(digest(await read(name)), hash);
  const backup = path.join(directory, 'repairs', 'authentication-before-init-' + digest(violationBytes)); await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(path.join(backup, 'run.before.json'), before, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
  await atomicJson(path.join(backup, 'audit.json'), audit);
  try {
    const repaired = { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
      recoveries: [...metadata.recoveries || [], { ...evidence, at: audit.at, reason: audit.kind, action_count: summary.action_count }] };
    await atomicJson(path.join(directory, 'run.json'), repaired);
    await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
    await verifyIntegrity(root, directory, repaired);
    for (const [name, hash] of Object.entries(preserved)) assert.equal(digest(await read(name)), hash);
    audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit); return { ...audit, backup };
  } catch (error) {
    await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 }); await writeFile(path.join(directory, 'run.json'), before);
    audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
  }
}
