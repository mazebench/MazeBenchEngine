// Aggregate billing metadata is not an action boundary. Recover only a terminal
// usage-report mismatch after rechecking every recorded response/tool boundary.
// Keep the accounting discrepancy and all gameplay in the audit trail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson } from './providers/claude-runner.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { isIncremental, verifyJournal } from './storage/journal.mjs';
import { findClaudeSession } from './recovery/claude-prefix.mjs';
export const CLAUDE_USAGE_ERROR = 'Claude reported usage for a different model.';
export const CLAUDE_USAGE_RECOVERY = 'claude-terminal-usage-report-v1';
export const needsClaudeUsageRecovery = run => run.provider === 'claude-code' && run.status === 'failed' && run.error === CLAUDE_USAGE_ERROR;
const execute = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hash(file) { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); }
async function* lines(file) { const input = createReadStream(file), reader = createInterface({ input, crlfDelay: Infinity }); try { for await (const line of reader) if (line.trim()) yield line; } finally { reader.close(); input.destroy(); } }
export async function auditClaudeUsageStream(source, { metadata, validatorFactory, acknowledged = new Set() }) {
  let turn, validate, last, violation, count = 0, responses = 0; const turns = new Set(), calls = new Map(), rejectedRooms = [];
  for await (const line of source) {
    assert(!violation, 'Unacknowledged failure is not the final provider event.');
    const event = JSON.parse(line); count++;
    if (event._turn_id !== turn) {
      assert(event._turn_id && !turns.has(event._turn_id), 'Noncontiguous provider attempt.');
      assert.equal(event.type, 'system'); assert.equal(event.subtype, 'init');
      turn = event._turn_id; turns.add(turn); calls.clear(); validate = validatorFactory({ model: metadata.model, toolsEnabled: metadata.tools_enabled });
    }
    if (event.session_id) assert.equal(event.session_id, metadata.claude_session_id, 'Session changed.');
    const problem = validate(event);
    if (problem) {
      assert.equal(problem, CLAUDE_USAGE_ERROR, 'Actual response/tool violation cannot be cleared as billing metadata.');
      assert.equal(event.type, 'result');
      if (!acknowledged.has(sha(line))) violation = { event, event_sha256: sha(line) };
    }
    if (event.type === 'assistant' && event.message?.model !== '<synthetic>') {
      assert.equal(event.message?.model, metadata.model, 'Missing or changed response model.'); responses++;
      for (const block of event.message?.content || []) if (block.type === 'tool_use') calls.set(block.id, { ...block, at: event._received_at });
    }
    if (event.type === 'user') for (const block of event.message?.content || []) if (block.type === 'tool_result') {
      const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
      if (call?.name !== 'mcp__mazebench__maze_action' || block.is_error !== true ||
          Object.keys(call.input || {}).join(',') !== 'action' || !/^room [A-Z]+[x×][A-Z]+$/.test(call.input.action)) continue;
      let result; try { result = JSON.parse(block.content); } catch { continue; }
      const error = `Room ${call.input.action.slice(5)} has not been visited.`;
      if (result && Object.keys(result).join(',') === 'error' && result.error === error)
        rejectedRooms.push({ action: call.input.action, error, requested_at: call.at, returned_at: event._received_at, tool_use_id: block.tool_use_id });
    }
    last = event;
  }
  assert(violation && violation.event === last && responses > 0, 'Missing isolated terminal usage mismatch.');
  assert(Number.isFinite(Date.parse(last._received_at)));
  return { ...violation, events_audited: count, responses_audited: responses, rejected_rooms: rejectedRooms };
}
export async function auditClaudeToolActivity(source, { terminalAt, actionCount, rejectedRooms = [] }) {
  const pending = new Map(), unused = new Set(rejectedRooms); let lastCount, rejected = 0;
  for await (const line of source) {
    const event = JSON.parse(line);
    assert(Date.parse(event.completed_at || event.at) < Date.parse(terminalAt));
    if (event.status === 'running') {
      assert(!pending.has(event.id), 'Duplicate tool execution.'); pending.set(event.id, event); continue;
    }
    const start = pending.get(event.id); assert(start, 'Tool result has no matching start.'); pending.delete(event.id);
    if (event.status === 'failed') {
      const { completed_at, action_count_after, error, ...original } = event;
      assert.deepEqual({ ...original, status: 'running' }, start, 'Rejected tool identity changed.');
      assert.equal(event.tool, 'maze_action');
      assert(Number.isSafeInteger(event.action_count_before) && event.action_count_before >= 0);
      assert.equal(action_count_after, event.action_count_before, 'Failed tool changed gameplay.');
      const proof = [...unused].find(item => item.action === event.action && item.error === error &&
        Date.parse(item.requested_at) <= Date.parse(event.at) && Date.parse(event.at) <= Date.parse(completed_at) &&
        Date.parse(completed_at) <= Date.parse(item.returned_at) && Date.parse(item.returned_at) - Date.parse(item.requested_at) < 10000);
      assert(proof, 'Unverified tool activity.'); unused.delete(proof); rejected++;
    } else assert.equal(event.status, 'completed', 'Unverified tool activity.');
    lastCount = event.action_count_after;
  }
  assert.equal(pending.size, 0, 'Unfinished tool execution.'); assert.equal(lastCount, actionCount);
  return { rejected_room_calls_verified: rejected };
}
export async function auditClaudeUsageSession(source, { metadata, terminal }) {
  let offset = 0, last, lastStart, count = 0;
  for await (const line of source) {
    const event = JSON.parse(line); lastStart = offset; offset += Buffer.byteLength(line) + 1; count++;
    if (event.sessionId) assert.equal(event.sessionId, metadata.claude_session_id);
    if (event.type === 'assistant') {
      assert([metadata.model, '<synthetic>'].includes(event.message?.model), 'Actual wrong-model conversation content requires separate recovery.');
      assert(!event.isSidechain, 'Delegated conversation content cannot be accepted.');
    }
    last = event;
  }
  assert(count > 0);
  const synthetic = last?.type === 'assistant' && last.message?.model === '<synthetic>' && last.isApiErrorMessage === true;
  if (synthetic) {
    assert.equal(terminal.is_error, true);
    assert.equal(last.apiError, terminal.api_error);
    assert(Math.abs(Date.parse(last.timestamp) - Date.parse(terminal._received_at)) < 1000);
    assert(last.message.content.every(block => block.type === 'text'), 'Error tail contains executable content.');
  }
  return { bytes_before: offset, bytes_after: synthetic ? lastStart : offset, removed_error_messages: synthetic ? 1 : 0 };
}
export async function recoverClaudeUsageReport({ root, directory, assertInactive, apply = false, claudeHome }) {
  assert.equal(typeof assertInactive, 'function');
  const repairs = path.join(directory, 'repairs'); await mkdir(repairs, { recursive: true, mode: 0o700 });
  const lock = path.join(repairs, '.claude-usage.lock'), handle = await open(lock, 'wx', 0o600);
  try {
    const before = await readFile(path.join(directory, 'run.json')), metadata = JSON.parse(before);
    assert(needsClaudeUsageRecovery(metadata)); await assertInactive(metadata);
    const violationBytes = await readFile(path.join(directory, 'integrity-violation.json'));
    assert.equal(JSON.parse(violationBytes).error, CLAUDE_USAGE_ERROR);
    const manifest = JSON.parse(await readFile(path.join(directory, 'integrity.json')));
    const policyPath = Object.keys(manifest.configuration.provider_runtime || {}).find(name => /^benchmarking\/providers(?:-v\d+)?\/claude-policy\.mjs$/.test(name));
    assert(policyPath);
    const policy = await import(pathToFileURL(path.join(root, policyPath)).href);
    await policy.verifyClaudeIntegrity(root, directory, metadata);
    if (isIncremental(directory)) verifyJournal(directory, { full: true });
    const acknowledged = new Set();
    for (const entry of metadata.usage_report_recoveries || []) {
      assert(/^[a-f0-9]{64}$/.test(entry.event_sha256));
      const audit = JSON.parse(await readFile(path.join(entry.archive, 'audit.json')));
      assert.equal(audit.phase, 'applied'); assert.equal(audit.kind, CLAUDE_USAGE_RECOVERY);
      assert.equal(audit.run_id, metadata.id); assert.equal(audit.event_sha256, entry.event_sha256);
      acknowledged.add(entry.event_sha256);
    }
    const evidence = await auditClaudeUsageStream(lines(path.join(directory, 'claude-events.jsonl')), { metadata, validatorFactory: policy.createClaudeBoundaryValidator, acknowledged });
    assert(Math.abs(Date.parse(evidence.event._received_at) - Date.parse(JSON.parse(violationBytes).at)) < 1000);
    const session = await findClaudeSession(metadata, claudeHome);
    const tail = await auditClaudeUsageSession(lines(session), { metadata, terminal: evidence.event });
    const summary = await readCheckpointJson(directory, 'summary.json');
    // Every completed action predates the terminal metadata. No unfinished MCP
    // operation may be silently carried across the recovery.
    const activityAudit = await auditClaudeToolActivity(lines(path.join(directory, 'tool-activity.jsonl')), {
      terminalAt: evidence.event._received_at, actionCount: summary.action_count, rejectedRooms: evidence.rejected_rooms });
    const preservedFiles = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md', 'claude-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
    const preserved = Object.fromEntries(await Promise.all(preservedFiles.map(async name => [name, await hash(path.join(directory, name))])));
    const sessionHash = await hash(session);
    const unchanged = async () => {
      await assertInactive(metadata);
      const ps = (await execute('ps', ['-axo', 'command='], { maxBuffer: 8 * 1024 * 1024 })).stdout;
      assert(!ps.split('\n').some(line => line.includes(metadata.claude_session_id) || line.includes(path.join(directory, 'agent-cwd'))), 'Runner still alive.');
      assert((await readFile(path.join(directory, 'run.json'))).equals(before));
      assert((await readFile(path.join(directory, 'integrity-violation.json'))).equals(violationBytes));
      for (const [name, expected] of Object.entries(preserved)) assert.equal(await hash(path.join(directory, name)), expected);
      assert.equal(await hash(session), sessionHash);
      await policy.verifyClaudeIntegrity(root, directory, metadata);
    };
    await unchanged();
    const audit = { kind: CLAUDE_USAGE_RECOVERY, phase: 'prepared', run_id: metadata.id, at: new Date().toISOString(),
      action_count: summary.action_count, gems_collected: summary.gems_collected, removed_actions: 0, ...tail,
      event_sha256: evidence.event_sha256, terminal_event: evidence.event, events_audited: evidence.events_audited,
      responses_audited: evidence.responses_audited, ...activityAudit, session_before_sha256: sessionHash, preserved_sha256: preserved,
      reason: 'Operator authorized preserving gameplay when only the terminal aggregate usage report failed validation. All recorded responses and tools were revalidated. Mixed aggregate usage remains recorded; its origin is not inferred from the counter.' };
    if (!apply) return audit;
    const backup = await mkdtemp(path.join(repairs, 'claude-usage-'));
    for (const name of ['run.json', 'integrity-violation.json']) await copyFile(path.join(directory, name), path.join(backup, name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await copyFile(session, path.join(backup, 'session.before.jsonl'), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await atomicJson(path.join(backup, 'audit.json'), audit); await unchanged();
    try {
      const fd = await open(session, 'r+'); try { await fd.truncate(tail.bytes_after); await fd.sync(); } finally { await fd.close(); }
      const restored = { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
        usage_report_recoveries: [...(metadata.usage_report_recoveries || []), { at: audit.at, event_sha256: audit.event_sha256, action_count: summary.action_count, archive: backup }] };
      await atomicJson(path.join(directory, 'run.json'), restored);
      await policy.verifyClaudeIntegrity(root, directory, restored);
      for (const [name, expected] of Object.entries(preserved)) assert.equal(await hash(path.join(directory, name)), expected);
      audit.phase = 'applied'; audit.session_after_sha256 = await hash(session); await atomicJson(path.join(backup, 'audit.json'), audit);
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      return { ...audit, backup };
    } catch (error) {
      await copyFile(path.join(backup, 'session.before.jsonl'), session); await writeOriginal();
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
    async function writeOriginal() { await copyFile(path.join(backup, 'run.json'), path.join(directory, 'run.json')); await copyFile(path.join(backup, 'integrity-violation.json'), path.join(directory, 'integrity-violation.json')); }
  } finally { await handle.close(); await rm(lock); }
}
