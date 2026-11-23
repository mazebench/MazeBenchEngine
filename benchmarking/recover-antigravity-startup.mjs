// Immutable runners classify even zero-work provider startup failures as
// pre-init activity. Recover only a proven, single failed startup event.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rename, rm, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import * as legacyPolicy from './antigravity/policy.mjs';
import * as catalogPolicy from './antigravity-v2/policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from './v1/integrity.mjs';
import { safeOpenFile, safeReadFile, safeDirectory } from './v1/safe-files.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { isIncremental, verifyJournal } from './storage/journal.mjs';
import { readJsonLinesTail } from './storage/tail-jsonl.mjs';
import { atomicJson } from './providers/claude-runner.mjs';
const { digest } = legacyPolicy;
const policies = new Map([legacyPolicy, catalogPolicy].map(policy => [policy.POLICY, policy]));

export const STARTUP_ERROR = 'Antigravity emitted activity before initialization.';
export const STARTUP_REPAIR = 'antigravity-zero-work-startup-v1';
export const needsAntigravityStartupRecovery = run => run.provider === 'antigravity' && run.status === 'failed' &&
  run.error === STARTUP_ERROR && run.recovery_repair === STARTUP_REPAIR;

export function inspectStartupFailure(event) {
  assert.deepEqual(Object.keys(event).sort(), ['_received_at', '_turn_id', 'event', 'result']);
  assert.equal(event.event, 'result'); assert(event._turn_id);
  assert(Number.isFinite(Date.parse(event._received_at)));
  const r = event.result;
  assert.deepEqual(Object.keys(r).sort(), ['conversation_id', 'duration_seconds', 'error', 'num_turns', 'response', 'status', 'usage']);
  assert.equal(r.status, 'ERROR'); assert.equal(r.conversation_id, ''); assert.equal(r.response, '');
  assert.equal(r.duration_seconds, 0); assert.equal(r.num_turns, 0);
  assert.deepEqual(Object.keys(r.usage).sort(), ['cache_read_tokens', 'input_tokens', 'output_tokens', 'thinking_tokens', 'total_tokens']);
  assert(Object.values(r.usage).every(value => value === 0), 'Startup failure contains model usage.');
  assert(typeof r.error === 'string' && (r.error === 'context canceled' || r.error === 'authentication failed or timed out' ||
    /^Eligibility check failed: /.test(r.error) && /connect: connection refused|timeout|timed out|temporary failure|no such host/i.test(r.error)),
  'Not a recognized zero-work provider startup failure.');
  return { turn_id: event._turn_id, failed_at: event._received_at, provider_error: r.error,
    event_sha256: digest(JSON.stringify(event)), removed_actions: 0 };
}
export async function auditStartupFailure(events) {
  let turn, count = 0, last; const seen = new Set();
  for await (const event of events) {
    assert(event._turn_id, 'Missing attempt identity.');
    if (turn !== event._turn_id) {
      assert(!seen.has(event._turn_id), 'Noncontiguous attempt history.');
      seen.add(event._turn_id); turn = event._turn_id; count = 0;
    }
    count++; last = event;
  }
  assert.equal(count, 1, 'The failed attempt contains other activity.');
  return inspectStartupFailure(last);
}
function matchFailure(metadata, violation, evidence) {
  assert.equal(metadata.provider, 'antigravity'); assert.equal(metadata.status, 'failed');
  assert.equal(metadata.error, STARTUP_ERROR); assert.equal(violation.error, STARTUP_ERROR);
  assert(policies.has(metadata.capability_policy?.name), 'Unsupported Antigravity policy.');
  assert.equal(metadata.observation_mode, 'ascii'); assert(metadata.antigravity_session_id);
  assert(Math.abs(Date.parse(violation.at) - Date.parse(evidence.failed_at)) < 1000);
  assert(Math.abs(Date.parse(metadata.completed_at) - Date.parse(evidence.failed_at)) < 30000);
}
export async function antigravityStartupCandidate(directory) {
  try {
    const tail = await readJsonLinesTail(path.join(directory, 'antigravity-events.jsonl'), 2);
    const evidence = inspectStartupFailure(tail.at(-1));
    assert(tail.length < 2 || tail[0]._turn_id !== evidence.turn_id);
    matchFailure(JSON.parse(safeReadFile(directory, 'run.json')), JSON.parse(safeReadFile(directory, 'integrity-violation.json')), evidence);
    return evidence;
  } catch { return null; }
}
async function* jsonLines(directory, name) {
  const stream = createReadStream(null, { fd: safeOpenFile(directory, name), autoClose: true });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) yield JSON.parse(line); }
  finally { lines.close(); stream.destroy(); }
}
async function fileHash(directory, name) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(null, { fd: safeOpenFile(directory, name), autoClose: true })) hash.update(chunk);
  return hash.digest('hex');
}
export async function recoverAntigravityStartup({ root, directory, assertInactive, apply = false }) {
  const repairs = safeDirectory(directory, 'repairs', { create: true });
  const lock = path.join(repairs, '.antigravity-startup.lock'), handle = await open(lock, 'wx', 0o600);
  const read = name => safeReadFile(directory, name, null);
  try {
    const before = read('run.json'), metadata = JSON.parse(before), violationBytes = read('integrity-violation.json');
    await assertInactive(metadata);
    const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
    assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
    if (isIncremental(directory)) verifyJournal(directory, { full: true });
    const frozen = manifest.configuration;
    const policy = policies.get(frozen.antigravity_policy);
    assert(policy && frozen.antigravity_policy === metadata.capability_policy?.name, 'Provider policy changed.');
    assert.deepEqual(await policy.runtimeHashes(root), frozen.antigravity_runtime);
    assert.equal(digest(await readFile(frozen.antigravity_executable)), frozen.antigravity_sha256);
    for (const [file, hash] of Object.entries(frozen.antigravity_config)) assert.equal(digest(await readFile(file)), hash);
    assert.equal(digest(read('prompt.md')), frozen.effective_prompt_sha256);
    const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md',
      'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
    const preserved = Object.fromEntries(await Promise.all(files.map(async file => [file, await fileHash(directory, file)])));
    const evidence = await auditStartupFailure(jsonLines(directory, 'antigravity-events.jsonl'));
    matchFailure(metadata, JSON.parse(violationBytes), evidence);
    const summary = await readCheckpointJson(directory, 'summary.json');
    assert(!['won', 'action-limit'].includes(summary.game_status));
    let last;
    for await (const activity of jsonLines(directory, 'tool-activity.jsonl')) {
      assert(Date.parse(activity.completed_at || activity.at) < Date.parse(evidence.failed_at), 'Activity continued after startup failure.');
      last = activity;
    }
    assert.equal(last?.status, 'completed'); assert.equal(last.action_count_after, summary.action_count);
    const audit = { kind: STARTUP_REPAIR, phase: 'prepared', at: new Date().toISOString(), run_id: metadata.id,
      action_count: summary.action_count, gems_collected: summary.gems_collected, ...evidence, preserved_sha256: preserved };
    if (!apply) return audit;
    await assertInactive(metadata);
    assert(read('run.json').equals(before)); assert(read('integrity-violation.json').equals(violationBytes));
    for (const [file, hash] of Object.entries(preserved)) assert.equal(await fileHash(directory, file), hash, 'Evidence changed.');
    const backup = await mkdtemp(path.join(repairs, 'antigravity-startup-'));
    await writeFile(path.join(backup, 'run.before.json'), before, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
    await atomicJson(path.join(backup, 'audit.json'), audit);
    await assertInactive(metadata);
    try {
      const repaired = { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
        recoveries: [...metadata.recoveries || [], { ...evidence, at: audit.at, reason: STARTUP_REPAIR, action_count: summary.action_count }] };
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      await policy.verifyIntegrity(root, directory, repaired);
      for (const [file, hash] of Object.entries(preserved)) assert.equal(await fileHash(directory, file), hash, `${file} changed.`);
      await atomicJson(path.join(directory, 'run.json'), repaired);
      audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit); return { ...audit, backup };
    } catch (error) {
      await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 });
      await writeFile(path.join(directory, 'run.json'), before);
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}
