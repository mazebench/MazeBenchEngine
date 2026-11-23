// Operator-side recovery for immutable Antigravity runners. A schema rejection
// is recoverable only when the provider proves the call never reached MCP.
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
const { digest, toolNames } = legacyPolicy;
const policies = new Map([legacyPolicy, catalogPolicy].map(policy => [policy.POLICY, policy]));
const fixedActions = new Set(['up', 'down', 'left', 'right', 'undo', 'reset', 'camera up', 'camera down', 'camera left', 'camera right']);

export const REJECTED_MCP_REPAIR = 'antigravity-rejected-mcp-schema-v1';
export const REJECTED_MCP_ERROR = 'Antigravity called an unexpected MCP server or tool.';
export const REJECTED_DIRECT_PYTHON_ERROR = 'Forbidden Antigravity tool: python_exec.';
export const isRejectedMcpError = error => [REJECTED_MCP_ERROR, ...toolNames(true).map(tool => `Forbidden Antigravity tool: ${tool}.`)].includes(error);
export function needsRejectedMcpRepair(run) {
  return run.provider === 'antigravity' && run.status === 'failed' && isRejectedMcpError(run.error) && run.recovery_repair === REJECTED_MCP_REPAIR;
}
export function inspectRejectedMcpCall(events, { conversationId, toolsEnabled }) {
  assert.equal(events.length, 2, 'Expected one request and its rejection.');
  const [request, rejection] = events;
  const directPython = request?.step_update?.tool_name === 'python_exec';
  const directCall = directPython || toolNames(false).includes(request?.step_update?.tool_name);
  const missingTool = !directCall && request?.step_update?.tool_info?.parameters?.ServerName === 'mazebench';
  if (directPython) assert.equal(toolsEnabled, true, 'Direct Python recovery requires the original coding condition.');
  const transport = directCall ? request.step_update.tool_name : 'call_mcp_tool';
  assert(request?._turn_id && conversationId, 'Missing attempt/conversation identity.');
  assert(Number.isInteger(request.step_update?.step_index));
  for (const [i, event] of events.entries()) {
    const step = event.step_update, info = step?.tool_info;
    assert.equal(event.event, 'step_update');
    assert.equal(step?.conversation_id, conversationId);
    assert.equal(step?.state, i ? 'ERROR' : 'ACTIVE');
    assert.equal(step?.step_type, 'tool');
    assert.equal(step?.tool_name, transport);
    assert.equal(info?.name, transport);
    assert.deepEqual(Object.keys(info).sort(), i ? ['error', 'name', 'parameters'] : ['name', 'parameters']);
    assert.deepEqual(Object.keys(info.parameters).sort(), directCall ? ['Arguments', 'ServerName', 'ToolName'] : missingTool ? ['Arguments', 'ServerName'] : ['Arguments']);
    const routing = directCall || missingTool ? info.parameters : info.parameters.Arguments;
    assert.equal(routing?.ServerName, 'mazebench');
    if (missingTool) {
      assert.deepEqual(Object.keys(routing.Arguments).sort(), ['action']);
      assert(fixedActions.has(routing.Arguments.action), 'Not a recognized MazeBench action.');
    } else assert(toolNames(toolsEnabled).includes(routing.ToolName), 'Not an allowed MazeBench tool.');
    if (directCall) assert.equal(routing.ToolName, transport);
    assert.equal(event._turn_id, request._turn_id);
    assert.equal(step.step_index, request.step_update.step_index);
    assert(Number.isFinite(Date.parse(event._received_at)));
  }
  assert.deepEqual(rejection.step_update.tool_info.parameters, request.step_update.tool_info.parameters);
  const error = rejection.step_update.tool_info.error;
  assert.deepEqual(Object.keys(error).sort(), ['message', 'type']);
  assert.equal(error.type, 'TOOL_ERROR');
  if (directCall) assert.equal(error.message, `unknown tool: "${transport}" — check spelling`);
  else if (missingTool) assert.equal(error.message, "invalid arguments:\n- missing property 'ToolName'");
  else assert.match(error.message, /^invalid arguments:\n- missing properties 'ServerName', 'ToolName'(?:, 'toolSummary', 'toolAction')?$/);
  assert(Date.parse(rejection._received_at) >= Date.parse(request._received_at));
  assert(Date.parse(rejection._received_at) - Date.parse(request._received_at) < 1000);
  return { turn_id: request._turn_id, step_index: request.step_update.step_index,
    rejected_at: rejection._received_at, requested_at: request._received_at,
    failure_error: directCall ? `Forbidden Antigravity tool: ${transport}.` : REJECTED_MCP_ERROR,
    tool: directCall ? transport : missingTool ? null : request.step_update.tool_info.parameters.Arguments.ToolName,
    ...(missingTool ? { missing_property: 'ToolName', rejected_arguments: request.step_update.tool_info.parameters.Arguments } : {}) };
}
function matchFailure(metadata, violation, evidence) {
  assert.equal(metadata.provider, 'antigravity'); assert.equal(metadata.status, 'failed');
  assert.equal(metadata.error, evidence.failure_error); assert.equal(violation.error, evidence.failure_error);
  assert(policies.has(metadata.capability_policy?.name), 'Unsupported Antigravity policy.');
  assert.equal(metadata.observation_mode, 'ascii');
  assert(Math.abs(Date.parse(evidence.rejected_at) - Date.parse(violation.at)) < 1000);
  assert(Math.abs(Date.parse(evidence.rejected_at) - Date.parse(metadata.completed_at)) < 30000);
}
// This is only a scheduling hint. Applying a repair re-audits the entire final
// turn and performs every signed admission check; this never certifies a run.
export async function rejectedMcpCandidate(directory) {
  try {
    const metadata = JSON.parse(safeReadFile(directory, 'run.json'));
    const violation = JSON.parse(safeReadFile(directory, 'integrity-violation.json'));
    const events = await readJsonLinesTail(path.join(directory, 'antigravity-events.jsonl'), 2);
    const evidence = inspectRejectedMcpCall(events, { conversationId: metadata.antigravity_session_id, toolsEnabled: metadata.tools_enabled });
    matchFailure(metadata, violation, evidence); return true;
  } catch { return false; }
}
async function* jsonLines(directory, name) {
  const stream = createReadStream(null, { fd: safeOpenFile(directory, name), autoClose: true });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) { if (line.trim()) yield JSON.parse(line); } }
  finally { lines.close(); stream.destroy(); }
}
export async function auditRejectedMcpTurn(events, options, policy = legacyPolicy) {
  let turn, validate, problem, count = 0, pending = [];
  const seen = new Set();
  for await (const event of events) {
    assert(event._turn_id, 'Event is missing its attempt identity.');
    if (turn !== event._turn_id) {
      assert(!seen.has(event._turn_id), 'Noncontiguous attempt history.');
      turn = event._turn_id; seen.add(turn); pending = []; count = 0; problem = null;
      validate = policy.boundaryValidator(options);
    }
    count++; pending.push(event);
    if (pending.length > 2) { const previous = pending.shift(); problem ||= validate(previous); }
  }
  assert(count > 2, 'Missing initialization in final attempt.');
  assert.equal(problem, null, 'Earlier boundary violation requires separate review.');
  const evidence = inspectRejectedMcpCall(pending, options);
  // Ensures initialization was actually validated, even on a very short turn.
  assert.equal(validate({ event: 'audit_end' }), null);
  return { ...evidence, final_turn_events_audited: count };
}
async function fileHash(directory, name) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(null, { fd: safeOpenFile(directory, name), autoClose: true })) hash.update(chunk);
  return hash.digest('hex');
}
export async function recoverAntigravityRejectedCall({ root, directory, assertInactive, apply = false }) {
  const repairs = safeDirectory(directory, 'repairs', { create: true });
  const lock = path.join(repairs, '.rejected-mcp-schema.lock'), handle = await open(lock, 'wx', 0o600);
  const read = name => safeReadFile(directory, name, null);
  try {
    const before = read('run.json'), metadata = JSON.parse(before), violationBytes = read('integrity-violation.json'), violation = JSON.parse(violationBytes);
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
    const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md', 'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
    const preserved = Object.fromEntries(await Promise.all(files.map(async name => [name, await fileHash(directory, name)])));
    const evidence = await auditRejectedMcpTurn(jsonLines(directory, 'antigravity-events.jsonl'), {
      model: metadata.model, cwd: path.join(directory, 'agent-cwd'), conversationId: metadata.antigravity_session_id, toolsEnabled: metadata.tools_enabled
    }, policy);
    matchFailure(metadata, violation, evidence);
    const summary = await readCheckpointJson(directory, 'summary.json');
    assert(!['won', 'action-limit'].includes(summary.game_status));
    let lastActivity;
    for await (const activity of jsonLines(directory, 'tool-activity.jsonl')) {
      assert(Date.parse(activity.completed_at || activity.at) < Date.parse(evidence.requested_at), 'Activity continued after the rejected call.');
      lastActivity = activity;
    }
    assert.equal(lastActivity?.status, 'completed'); assert.equal(lastActivity.action_count_after, summary.action_count);
    const audit = { kind: REJECTED_MCP_REPAIR, phase: 'prepared', at: new Date().toISOString(), run_id: metadata.id,
      conversation_id: metadata.antigravity_session_id, action_count: summary.action_count, ...evidence, preserved_sha256: preserved,
      reason: 'Provider rejected an incorrectly routed MazeBench call before MCP execution. Resume the original conversation from the unchanged signed checkpoint.' };
    if (!apply) return audit;
    await assertInactive(metadata);
    assert(read('run.json').equals(before)); assert(read('integrity-violation.json').equals(violationBytes));
    for (const [name, hash] of Object.entries(preserved)) assert.equal(await fileHash(directory, name), hash, 'Evidence changed during recovery.');
    const backup = await mkdtemp(path.join(repairs, 'rejected-mcp-schema-' + digest(violationBytes) + '-'));
    await writeFile(path.join(backup, 'run.before.json'), before, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
    await atomicJson(path.join(backup, 'audit.json'), audit);
    await assertInactive(metadata);
    try {
      const repaired = { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
        recoveries: [...metadata.recoveries || [], { ...evidence, at: audit.at, reason: audit.kind, action_count: summary.action_count }] };
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      await policy.verifyIntegrity(root, directory, repaired);
      for (const [name, hash] of Object.entries(preserved)) assert.equal(await fileHash(directory, name), hash, `${name} changed.`);
      await atomicJson(path.join(directory, 'run.json'), repaired);
      audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit); return { ...audit, backup };
    } catch (error) {
      await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 });
      await writeFile(path.join(directory, 'run.json'), before);
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}
