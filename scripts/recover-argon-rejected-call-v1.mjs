// Operator-only recovery of one confirmed, unexecuted argument-schema error.
// Preserve the original conversation, signed runtime, checkpoint and raw events.
import assert from 'node:assert/strict';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { boundaryValidator, digest, runtimeHashes, verifyIntegrity } from '../benchmarking/antigravity/policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../benchmarking/v1/integrity.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { atomicJson } from '../benchmarking/providers/claude-runner.mjs';

export const RUN = 'run-2026-10-14T05-04-51-008Z-166704';
const SESSION = '7425c91c-8a72-462a-b599-eceb8fccf84c';
const ERROR = 'Antigravity called an unexpected MCP server or tool.';
const expected = {
  'run.json': '67373ab5b8d92b6c170bd54efa7160ef60b3b21fdd11dc8d29afa5407ab6b9ff',
  'integrity.json': '57aadee2942ba749b192dd82de6308765b0dd0f4067a4cf22c759edf0652334c',
  'integrity-violation.json': '17fa818da04ddc0852b5b3c543a1a4c9e1b08fc0c5fa34a672c80eb808319931',
  'checkpoint.json': 'f009d6da31af3686012524218bf174a4c18ba3e116680456e565fb0918d88bcf',
  'antigravity-events.jsonl': '6db7acc3bb14420a9d6669114994823524983f1fe86bd9be25ecb2e25f876d02',
  'tool-activity.jsonl': '6286467821c3000dc03d735ff1f1c807e4a5e4f3dfcce85c95fc78ebd05efb42'
};

export function inspectRejectedCall(events, { conversationId, toolsEnabled }) {
  assert.equal(toolsEnabled, true);
  assert.equal(events.length, 2, 'Expected exactly one request and its rejection.');
  const [request, rejection] = events;
  for (const [i, event] of events.entries()) {
    const step = event.step_update, info = step?.tool_info;
    assert.equal(event.event, 'step_update');
    assert.equal(step?.conversation_id, conversationId);
    assert.equal(step?.state, i ? 'ERROR' : 'ACTIVE');
    assert.equal(step?.tool_name, 'call_mcp_tool');
    assert.equal(info?.name, 'call_mcp_tool');
    assert.deepEqual(Object.keys(info).sort(), i ? ['error', 'name', 'parameters'] : ['name', 'parameters']);
    assert.deepEqual(Object.keys(info.parameters), ['Arguments']);
    assert.equal(info.parameters.Arguments.ServerName, 'mazebench');
    assert.equal(info.parameters.Arguments.ToolName, 'python_exec');
    assert.equal(event._turn_id, request._turn_id);
    assert.equal(step.step_index, request.step_update.step_index);
    assert(Number.isFinite(Date.parse(event._received_at)));
  }
  assert.deepEqual(rejection.step_update.tool_info.parameters, request.step_update.tool_info.parameters);
  assert.deepEqual(rejection.step_update.tool_info.error, {
    type: 'TOOL_ERROR', message: "invalid arguments:\n- missing properties 'ServerName', 'ToolName'"
  });
  return { turn_id: request._turn_id, step_index: request.step_update.step_index, rejected_at: request._received_at };
}

export async function recoverArgonRejectedCall({ root, directory, apply = false }) {
  assert.equal(path.basename(directory), RUN);
  const repairs = path.join(directory, 'repairs'); await mkdir(repairs, { recursive: true, mode: 0o700 });
  const lock = path.join(repairs, '.argon-rejected-call.lock'), handle = await open(lock, 'wx', 0o600);
  const read = name => readFile(path.join(directory, name));
  const inactive = async () => {
    const response = await fetch(`http://localhost:8090/api/benchmark/v1/runs/${RUN}`, { signal: AbortSignal.timeout(30000) });
    assert(response.ok); const run = await response.json();
    assert.equal(run.runner_active, false); assert.equal(run.status, 'failed');
    assert.equal(run.action_count, 12386); assert.equal(run.antigravity_session_id, SESSION);
  };
  try {
    await inactive();
    for (const [file, hash] of Object.entries(expected)) assert.equal(digest(await read(file)), hash, `${file} differs from reviewed evidence.`);
    const original = await read('run.json'), metadata = JSON.parse(original), violationBytes = await read('integrity-violation.json');
    assert.equal(metadata.id, RUN); assert.equal(metadata.model, 'gemini-4-argon-high');
    assert.equal(metadata.antigravity_session_id, SESSION); assert.equal(metadata.error, ERROR);
    assert.equal(metadata.tools_enabled, true); assert.equal(metadata.status, 'failed');
    const manifest = await verifyRunIntegrity(root, directory, metadata.integrity);
    assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
    const frozen = manifest.configuration;
    assert.deepEqual(await runtimeHashes(root), frozen.antigravity_runtime);
    assert.equal(digest(await readFile(frozen.antigravity_executable)), frozen.antigravity_sha256);
    for (const [file, hash] of Object.entries(frozen.antigravity_config)) assert.equal(digest(await readFile(file)), hash);
    assert.equal(digest(await read('prompt.md')), frozen.effective_prompt_sha256);
    const summary = await readCheckpointJson(directory, 'summary.json'); assert.equal(summary.action_count, 12386);
    assert(!['won', 'action-limit'].includes(summary.game_status));
    const jsonl = async file => (await read(file)).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const events = await jsonl('antigravity-events.jsonl'), evidence = inspectRejectedCall(events.slice(-2), { conversationId: SESSION, toolsEnabled: true });
    assert.equal(evidence.step_index, 25011); assert.equal(evidence.rejected_at, JSON.parse(violationBytes).at);
    const first = events.findIndex(event => event._turn_id === evidence.turn_id), tail = events.slice(first);
    assert.equal(tail[0]?.event, 'init'); assert(tail.every(event => event._turn_id === evidence.turn_id));
    const validate = boundaryValidator({ model: metadata.model, cwd: path.join(directory, 'agent-cwd'), conversationId: SESSION, toolsEnabled: true });
    for (const event of tail.slice(0, -2)) assert.equal(validate(event), null, 'Earlier boundary violation requires separate review.');
    const activity = await jsonl('tool-activity.jsonl');
    assert.equal(activity.at(-1)?.status, 'completed'); assert.equal(activity.at(-1)?.action_count_after, summary.action_count);
    assert(activity.every(event => Date.parse(event.completed_at || event.at) < Date.parse(evidence.rejected_at)), 'Activity continued after the rejected call.');
    const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md', 'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
    const preserved = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await read(file))])));
    const audit = { kind: 'rejected-mcp-argument-schema', phase: 'prepared', at: new Date().toISOString(), run_id: RUN,
      conversation_id: SESSION, action_count: summary.action_count, ...evidence, final_turn_events_audited: tail.length,
      reason: 'User requested same-session resume. Provider explicitly rejected misplaced routing fields before execution; no outside tool ran and no game state changed.',
      preserved_sha256: preserved };
    if (!apply) return { ...audit, applied: false };
    await inactive();
    for (const [file, hash] of Object.entries(expected)) assert.equal(digest(await read(file)), hash, 'Evidence changed during review.');
    const backup = path.join(repairs, 'argon-rejected-call-' + digest(violationBytes)); await mkdir(backup, { mode: 0o700 });
    await writeFile(path.join(backup, 'run.before.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
    await atomicJson(path.join(backup, 'audit.json'), audit);
    try {
      const repaired = { ...metadata, status: 'paused', error: null, completed_at: null, paused_at: audit.at, updated_at: audit.at,
        rejected_call_recoveries: [...metadata.rejected_call_recoveries || [], { at: audit.at, ...evidence, action_count: summary.action_count }] };
      await atomicJson(path.join(directory, 'run.json'), repaired);
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      // All original provider admission checks must still pass, including immutable config flags.
      await verifyIntegrity(root, directory, repaired);
      for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(await read(file)), hash, `${file} changed.`);
      audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit);
      return { ...audit, applied: true, backup };
    } catch (error) {
      await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 });
      await writeFile(path.join(directory, 'run.json'), original);
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], RUN);
  console.log(JSON.stringify(await recoverArgonRejectedCall({ root: path.resolve(import.meta.dirname, '..'),
    directory: path.join(os.homedir(), 'records/mazebench-benchmark', RUN), apply: process.argv.includes('--apply') }), null, 2));
}
