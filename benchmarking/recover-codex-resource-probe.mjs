// Operator-authorized recovery for interrupted, read-only resource discovery.
// Signed runtime, benchmark settings, game journal and agent audit stay intact.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, mkdir, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from './v1/integrity.mjs';
import { eventBoundaryViolation, verifyDirectToolModelCatalog } from './v1/supervisor.mjs';
import { visionRuntimeHashes } from './vision/policy.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { atomicJson } from './providers/claude-runner.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const probes = new Set(['list_mcp_resources', 'list_mcp_resource_templates']);
const failure = tool => `Capability boundary violation: unexpected mcp_tool_call (${tool}). Run invalidated.`;
export const resourceProbeFailure = error => [...probes].some(tool => error === failure(tool));
const empty = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
export function blockedResourceProbe(event) {
  const item = event?.item;
  return event?.type === 'item.started' && item?.type === 'mcp_tool_call' && item.server === 'codex'
    && probes.has(item.tool) && empty(item.arguments) && item.status === 'in_progress' && item.result === null && item.error === null;
}
export function interruptedProbeCall(record, event) {
  const call = record?.payload;
  let args; try { args = JSON.parse(call?.arguments); } catch { return false; }
  return record.type === 'response_item' && call.type === 'function_call' && call.name === event.item.tool
    && empty(args) && typeof call.call_id === 'string' && call.call_id.length > 0
    && Math.abs(Date.parse(record.timestamp) - Date.parse(event._received_at)) < 5000;
}
async function fileHash(file) {
  const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex');
}
async function findSession(metadata, home) {
  const found = [];
  for (const delta of [-1, 0, 1]) {
    const day = new Date(Date.parse(metadata.created_at) + delta * 86400000).toISOString().slice(0, 10).replaceAll('-', '/');
    const directory = path.join(home, 'sessions', day);
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of names) if (name.endsWith(`-${metadata.codex_thread_id}.jsonl`)) found.push(path.join(directory, name));
  }
  assert.equal(found.length, 1, 'The original Codex session could not be uniquely located.'); return found[0];
}
async function scanEvents(directory, metadata) {
  const allowed = new Set();
  for (const recovery of metadata.resource_probe_recoveries || []) {
    assert(/^[a-f0-9]{64}$/.test(recovery.event_sha256), 'Invalid prior recovery record.');
    const audit = JSON.parse(await readFile(path.join(directory, 'repairs', 'resource-probe-' + recovery.event_sha256, 'audit.json'), 'utf8'));
    assert.equal(audit.phase, 'applied'); assert.equal(audit.run_id, metadata.id); assert.equal(audit.thread_id, metadata.codex_thread_id);
    assert.equal(audit.event_sha256, recovery.event_sha256); allowed.add(recovery.event_sha256);
  }
  let last, lastHash, violation;
  const stream = createReadStream(path.join(directory, 'agent-events.jsonl'));
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line), digest = hash(line);
      if (event.type === 'thread.started') assert.equal(event.thread_id, metadata.codex_thread_id, 'Conversation identity changed.');
      if (eventBoundaryViolation(event, { toolsEnabled: metadata.tools_enabled })) {
        assert(blockedResourceProbe(event), 'Unrelated tool violation cannot be recovered.');
        if (!allowed.has(digest)) { assert(!violation, 'More than one unaudited violation.'); violation = { event, hash: digest }; }
      }
      last = event; lastHash = digest;
    }
  } finally { lines.close(); stream.destroy(); }
  assert(violation && last === violation.event && lastHash === violation.hash, 'Only an unfinished final resource probe can be recovered.');
  assert.equal(metadata.error, failure(last.item.tool)); return violation;
}
async function sessionTail(file) {
  const fd = await open(file, 'r');
  try {
    const { size } = await fd.stat(), length = Math.min(size, 65536), bytes = Buffer.alloc(length);
    await fd.read(bytes, 0, length, size - length);
    let end = bytes.length; while (end && [10, 13].includes(bytes[end - 1])) end--;
    const start = bytes.lastIndexOf(10, end - 1) + 1;
    assert(start || length === size, 'Session tail is too large for a resource probe.');
    return { record: JSON.parse(bytes.subarray(start, end).toString('utf8')), offset: size - length + start, size };
  } finally { await fd.close(); }
}
async function verifyPreservedRuntime(root, directory, metadata) {
  assert.equal(metadata.provider, 'codex'); assert.equal(metadata.observation_mode, 'vision'); assert.equal(metadata.world, 'main-world');
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity), frozen = manifest.configuration;
  assertRunConfiguration(metadata, manifest); assert.equal(frozen.provider, 'codex'); assert.equal(frozen.observation_mode, 'vision');
  assert.deepEqual(await visionRuntimeHashes(root), frozen.vision_runtime, 'Signed vision runtime changed.');
  assert.equal(await fileHash(path.join(directory, 'prompt.md')), frozen.effective_prompt_sha256, 'Prompt changed.');
  assert.deepEqual(metadata.capability_policy, frozen.codex_policy);
  assert.equal(await fileHash(frozen.codex_policy.codex_executable), frozen.codex_policy.codex_sha256, 'Codex executable changed.');
  await verifyDirectToolModelCatalog(directory, metadata.model, frozen.codex_policy.model_catalog);
  verifyCheckpoint(directory);
}
export async function recoverCodexResourceProbe({ root, directory, assertInactive, apply = false, codexHome = path.join(os.homedir(), '.codex') }) {
  assert.equal(typeof assertInactive, 'function', 'An owning-supervisor inactivity check is required.');
  const repairs = path.join(directory, 'repairs'); await mkdir(repairs, { recursive: true, mode: 0o700 });
  const lock = path.join(repairs, '.resource-probe.lock'), handle = await open(lock, 'wx', 0o600);
  try {
    const original = await readFile(path.join(directory, 'run.json')), metadata = JSON.parse(original);
    assert.equal(path.basename(directory), metadata.id); assert.equal(metadata.status, 'failed'); assert(resourceProbeFailure(metadata.error), 'Not a recoverable resource probe.');
    assert(metadata.codex_thread_id, 'The original conversation is required.'); await assertInactive(metadata);
    const violationBytes = await readFile(path.join(directory, 'integrity-violation.json'));
    assert.deepEqual(JSON.parse(violationBytes), { error: metadata.error }, 'Unrelated invalidation must be reviewed.');
    await verifyPreservedRuntime(root, directory, metadata);
    const summary = await readCheckpointJson(directory, 'summary.json'); assert(!['won', 'action-limit'].includes(summary.game_status), 'Game is complete.');
    const candidate = await scanEvents(directory, metadata), session = await findSession(metadata, codexHome), tail = await sessionTail(session);
    assert(interruptedProbeCall(tail.record, candidate.event), 'The blocked call has a result or is not the final session record.');
    const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md', 'agent-events.jsonl'];
    const preserved = Object.fromEntries(await Promise.all(files.map(async file => [file, await fileHash(path.join(directory, file))])));
    const sessionHash = await fileHash(session);
    const unchanged = async () => {
      await assertInactive(metadata);
      const commands = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
      assert(!commands.split('\n').some(line => line.includes(path.join(directory, 'agent-cwd'))), 'An agent process is still alive.');
      assert((await readFile(path.join(directory, 'run.json'))).equals(original), 'Run changed during recovery.');
      assert((await readFile(path.join(directory, 'integrity-violation.json'))).equals(violationBytes));
      for (const [file, digest] of Object.entries(preserved)) assert.equal(await fileHash(path.join(directory, file)), digest, `${file} changed during recovery.`);
      assert.equal(await fileHash(session), sessionHash, 'Session changed during recovery.');
    };
    await unchanged();
    const audit = { version: 1, phase: 'prepared', at: new Date().toISOString(), kind: 'blocked-resource-probe', run_id: metadata.id, thread_id: metadata.codex_thread_id,
      action_count: summary.action_count, tool: candidate.event.item.tool, event_sha256: candidate.hash, call_id: tail.record.payload.call_id,
      session_before_sha256: sessionHash, session_bytes_before: tail.size, session_bytes_after: tail.offset, preserved_sha256: preserved,
      reason: 'Operator authorized rollback of an unfinished, result-free resource-discovery call and automatic recovery of this same failure class.' };
    if (!apply) return { ...audit, applied: false };
    const backup = path.join(repairs, 'resource-probe-' + candidate.hash); await mkdir(backup, { mode: 0o700 });
    await writeFile(path.join(backup, 'run.before.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
    await copyFile(session, path.join(backup, 'session.before.jsonl'));
    await atomicJson(path.join(backup, 'audit.json'), audit); await unchanged();
    let modified = false;
    try {
      const fd = await open(session, 'r+'); try { await fd.truncate(tail.offset); modified = true; await fd.sync(); } finally { await fd.close(); }
      audit.session_after_sha256 = await fileHash(session);
      const entry = { at: audit.at, kind: audit.kind, action_count: audit.action_count, event_sha256: candidate.hash, tool: audit.tool };
      await atomicJson(path.join(directory, 'run.json'), { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
        resource_probe_recoveries: [...(metadata.resource_probe_recoveries || []), entry] });
      await verifyPreservedRuntime(root, directory, JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')));
      for (const [file, digest] of Object.entries(preserved)) assert.equal(await fileHash(path.join(directory, file)), digest);
      audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit);
      // Clear admission last, after every check and backup is durable. Until
      // this rename the original supervisor still refuses any concurrent resume.
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      return { ...audit, applied: true, backup };
    } catch (error) {
      // No agent is started by this operation. Restore only the three operator
      // files touched here; game state and historical events were never edited.
      if (modified) await copyFile(path.join(backup, 'session.before.jsonl'), session);
      await writeFile(path.join(directory, 'run.json'), original);
      await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 });
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}
