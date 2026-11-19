import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunIntegrity, signCheckpoint } from '../benchmarking/v1/integrity.mjs';
import * as legacyPolicy from '../benchmarking/antigravity/policy.mjs';
import * as catalogPolicy from '../benchmarking/antigravity-v2/policy.mjs';
const { digest } = legacyPolicy;
import { inspectRejectedMcpCall, auditRejectedMcpTurn, recoverAntigravityRejectedCall, REJECTED_MCP_ERROR, REJECTED_MCP_REPAIR } from '../benchmarking/recover-antigravity-rejected-call.mjs';
import { recoveryFailure } from '../benchmarking/auto-resume-failure.mjs';
const options = { conversationId: 'saved-session', toolsEnabled: true, model: 'gemini-4-argon-high', cwd: process.cwd() };
const at = '2026-11-06T11:24:51.422Z';
function rejected(tool = 'maze_sequence') {
  const parameters = { Arguments: { ServerName: 'mazebench', ToolName: tool, sequence: 'DR', toolSummary: 'Move', toolAction: 'Moving' } };
  return ['ACTIVE', 'ERROR'].map(state => ({ event: 'step_update', _turn_id: 'attempt', _received_at: at,
    step_update: { conversation_id: options.conversationId, step_index: 44, step_type: 'tool', tool_name: 'call_mcp_tool', state,
      tool_info: { name: 'call_mcp_tool', parameters: structuredClone(parameters), ...(state === 'ERROR' ? { error: {
        type: 'TOOL_ERROR', message: "invalid arguments:\n- missing properties 'ServerName', 'ToolName', 'toolSummary', 'toolAction'"
      } } : {}) } } }));
}
function missingTool() {
  const events = rejected();
  for (const event of events) event.step_update.tool_info.parameters = { Arguments: { action: 'camera up' }, ServerName: 'mazebench' };
  events[1].step_update.tool_info.error.message = "invalid arguments:\n- missing property 'ToolName'";
  return events;
}
function directTool(tool = 'maze_observe') {
  const events = rejected(tool);
  for (const event of events) {
    event.step_update.tool_name = tool;
    event.step_update.tool_info.name = tool;
    event.step_update.tool_info.parameters = { Arguments: {}, ServerName: 'mazebench', ToolName: tool };
  }
  events[1].step_update.tool_info.error.message = `unknown tool: "${tool}" — check spelling`;
  return events;
}
const init = () => ({ event: 'init', _turn_id: 'attempt', _received_at: at, conversation_id: options.conversationId,
  init: { model: options.model, cwd: options.cwd, agent: 'mazebench', permission_mode: 'request-review' } });
test('schema rejection supports allowed gameplay tools and Python only in coding-on runs', () => {
  for (const tool of ['maze_observe', 'maze_action', 'maze_sequence', 'python_exec']) assert.equal(inspectRejectedMcpCall(rejected(tool), options).tool, tool);
  assert.throws(() => inspectRejectedMcpCall(rejected('python_exec'), { ...options, toolsEnabled: false }));
  assert.equal(inspectRejectedMcpCall(rejected(), { ...options, toolsEnabled: false }).tool, 'maze_sequence');
  const older = rejected('python_exec'); older[1].step_update.tool_info.error.message = "invalid arguments:\n- missing properties 'ServerName', 'ToolName'";
  assert.equal(inspectRejectedMcpCall(older, options).tool, 'python_exec');
});
test('no successful, ambiguous, forbidden, stale or mismatched call is recoverable', () => {
  for (const mutate of [
    e => { e[1].step_update.state = 'DONE'; },
    e => { e[1].step_update.tool_info.output = 'Executed'; },
    e => { e.forEach(v => { v.step_update.tool_info.parameters.Arguments.ServerName = 'outside'; }); },
    e => { e.forEach(v => { v.step_update.tool_info.parameters.Arguments.ToolName = 'run_command'; }); },
    e => { e.forEach(v => { v.step_update.tool_info.parameters.ServerName = 'mazebench'; }); },
    e => { e[1].step_update.tool_info.error.message = 'execution failed'; },
    e => { e[1].step_update.step_index++; },
    e => { e[1]._turn_id = 'another'; },
    e => { e[1].step_update.conversation_id = 'another'; },
    e => { e[1]._received_at = '2026-11-06T11:25:51.422Z'; },
    e => { e[1].step_update.tool_info.parameters.Arguments.sequence = 'RR'; }
  ]) { const events = rejected(); mutate(events); assert.throws(() => inspectRejectedMcpCall(events, options)); }
});
test('missing tool name requires a proven schema rejection of an allowed game action', () => {
  const evidence = inspectRejectedMcpCall(missingTool(), { ...options, toolsEnabled: false });
  assert.equal(evidence.missing_property, 'ToolName'); assert.equal(evidence.tool, null);
  assert.deepEqual(evidence.rejected_arguments, { action: 'camera up' });
  for (const mutate of [
    e => e.forEach(v => { v.step_update.tool_info.parameters.Arguments.action = 'run_command'; }),
    e => e.forEach(v => { v.step_update.tool_info.parameters.Arguments.code = 'print(1)'; }),
    e => e.forEach(v => { v.step_update.tool_info.parameters.ToolName = 'maze_action'; }),
    e => e.forEach(v => { v.step_update.tool_info.parameters.ServerName = 'outside'; }),
    e => { e[1].step_update.tool_info.output = 'executed'; },
    e => { e[1].step_update.tool_info.error.message = 'execution failed'; },
    e => { e[1].step_update.tool_info.parameters.Arguments.action = 'camera down'; }
  ]) { const events = missingTool(); mutate(events); assert.throws(() => inspectRejectedMcpCall(events, options)); }
});
test('direct gameplay calls recover only when the provider reports the matching unknown tool', () => {
  for (const tool of ['maze_observe', 'maze_action', 'maze_sequence']) {
    const evidence = inspectRejectedMcpCall(directTool(tool), { ...options, toolsEnabled: false });
    assert.equal(evidence.tool, tool); assert.equal(evidence.failure_error, `Forbidden Antigravity tool: ${tool}.`);
  }
  assert.equal(inspectRejectedMcpCall(directTool('python_exec'), options).tool, 'python_exec');
  assert.throws(() => inspectRejectedMcpCall(directTool('python_exec'), { ...options, toolsEnabled: false }));
  for (const mutate of [
    e => e.forEach(v => { v.step_update.tool_info.parameters.ToolName = 'maze_action'; }),
    e => { e[1].step_update.tool_info.error.message = 'execution failed'; },
    e => { e[1].step_update.tool_info.error.message = 'unknown tool: "run_command" — check spelling'; },
    e => { e[1].step_update.tool_info.output = 'executed'; },
    e => e.forEach(v => { v.step_update.tool_info.parameters.ServerName = 'outside'; })
  ]) { const events = directTool(); mutate(events); assert.throws(() => inspectRejectedMcpCall(events, options)); }
});
test('audit requires initialized final attempt, with no preceding boundary violation', async () => {
  const valid = [init(), ...rejected()];
  assert.equal((await auditRejectedMcpTurn(valid, options)).final_turn_events_audited, 3);
  const oldFailure = { ...init(), _turn_id: 'old', event: 'result' };
  assert.equal((await auditRejectedMcpTurn([oldFailure, ...valid], options)).turn_id, 'attempt');
  await assert.rejects(auditRejectedMcpTurn(rejected(), options));
  await assert.rejects(auditRejectedMcpTurn([{ ...init(), conversation_id: 'wrong' }, ...rejected()], options));
  const forbidden = { event: 'step_update', _turn_id: 'attempt', step_update: { tool_name: 'run_command' } };
  await assert.rejects(auditRejectedMcpTurn([init(), forbidden, ...rejected()], options));
  await assert.rejects(auditRejectedMcpTurn([init(), oldFailure, ...valid], options), /Noncontiguous/);
  await assert.rejects(auditRejectedMcpTurn([...valid, { event: 'result', _turn_id: 'attempt' }], options));
});
async function signedFixture(t, policy = legacyPolicy, rejectedEvents = rejected()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-rejected-repair-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'record');
  for (const folder of ['benchmarking/v1', 'benchmarking/storage', 'engine/v1', 'play/v1', 'render/v1', 'render-ascii/v1', 'level-data/v2/main-world', 'benchmarking/antigravity', 'benchmarking/antigravity-v2', 'record/agent-cwd']) await mkdir(path.join(root, folder), { recursive: true });
  const executable = path.join(root, 'agy'); await writeFile(executable, 'fixture-executable');
  const config = { provider: 'antigravity', antigravity_policy: policy.POLICY, antigravity_version: '1.3.5', antigravity_executable: executable,
    antigravity_sha256: digest('fixture-executable'), antigravity_runtime: await policy.runtimeHashes(root), antigravity_config: {},
    model: options.model, world: 'main-world', observation_mode: 'ascii', tools_enabled: true, effective_prompt_sha256: digest('play') };
  const error = inspectRejectedMcpCall(rejectedEvents, options).failure_error;
  const metadata = { ...config, id: 'run-2026-11-06T11-00-00-000Z-aaaaaa', status: 'failed', error,
    completed_at: at, antigravity_session_id: options.conversationId, capability_policy: { name: policy.POLICY },
    integrity: await createRunIntegrity(root, directory, config) };
  const events = [init(), ...rejectedEvents]; events[0].init.cwd = path.join(directory, 'agent-cwd');
  const records = { 'run.json': JSON.stringify(metadata), 'integrity-violation.json': JSON.stringify({ error, at }),
    'prompt.md': 'play', 'game-state.json': '{}', 'summary.json': JSON.stringify({ action_count: 10, game_status: 'playing' }), 'display.json': '{}',
    'antigravity-events.jsonl': events.map(e => JSON.stringify(e)).join('\n') + '\n', 'agent-events.jsonl': '',
    'tool-activity.jsonl': JSON.stringify({ status: 'completed', completed_at: '2026-11-06T11:24:50Z', action_count_after: 10 }) + '\n' };
  for (const [name, contents] of Object.entries(records)) await writeFile(path.join(directory, name), contents);
  await signCheckpoint(directory);
  return { root, directory, metadata, records, assertInactive: async () => {} };
}
test('real signed repair preserves all evidence and session, and archives the false flag', async t => {
  const f = await signedFixture(t);
  const decoded = await recoveryFailure({ ...f.metadata, capability_boundary_verified: false }, { directory: f.directory });
  assert.equal(decoded.recovery_repair, REJECTED_MCP_REPAIR); assert.equal(decoded.capability_boundary_verified, false);
  const result = await recoverAntigravityRejectedCall({ ...f, apply: true });
  assert.equal(result.phase, 'applied');
  const repaired = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
  assert.equal(repaired.status, 'paused'); assert.equal(repaired.antigravity_session_id, options.conversationId);
  for (const [file, hash] of Object.entries(result.preserved_sha256)) assert.equal(digest(await readFile(path.join(f.directory, file))), hash);
  await assert.rejects(access(path.join(f.directory, 'integrity-violation.json')));
  assert.equal(await readFile(path.join(result.backup, 'run.before.json'), 'utf8'), f.records['run.json']);
});
test('missing-name rejection recovers with either original signed provider policy', async t => {
  for (const policy of [legacyPolicy, catalogPolicy]) {
    const f = await signedFixture(t, policy, missingTool());
    const decoded = await recoveryFailure({ ...f.metadata, capability_boundary_verified: false }, { directory: f.directory });
    assert.equal(decoded.recovery_repair, REJECTED_MCP_REPAIR);
    const result = await recoverAntigravityRejectedCall({ ...f, apply: true });
    assert.equal(result.phase, 'applied'); assert.equal(result.action_count, 10);
    const repaired = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
    assert.equal(repaired.antigravity_session_id, options.conversationId);
    assert.equal(repaired.capability_policy.name, policy.POLICY);
    for (const [file, hash] of Object.entries(result.preserved_sha256)) assert.equal(digest(await readFile(path.join(f.directory, file))), hash);
  }
});
test('direct observation rejection preserves the signed checkpoint and original conversation', async t => {
  const f = await signedFixture(t, catalogPolicy, directTool());
  const decoded = await recoveryFailure({ ...f.metadata, capability_boundary_verified: false }, { directory: f.directory });
  assert.equal(decoded.recovery_repair, REJECTED_MCP_REPAIR);
  const result = await recoverAntigravityRejectedCall({ ...f, apply: true });
  assert.equal(result.phase, 'applied'); assert.equal(result.action_count, 10);
  const repaired = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
  assert.equal(repaired.antigravity_session_id, options.conversationId);
  for (const [file, hash] of Object.entries(result.preserved_sha256)) assert.equal(digest(await readFile(path.join(f.directory, file))), hash);
});
test('changed checkpoint, prior forbidden activity and cancellation cannot clear a flag', async t => {
  for (const change of ['checkpoint', 'activity', 'cancel']) {
    const f = await signedFixture(t);
    if (change === 'checkpoint') await writeFile(path.join(f.directory, 'summary.json'), '{}');
    if (change === 'activity') {
      const events = f.records['antigravity-events.jsonl'].trim().split('\n').map(JSON.parse);
      events.splice(1, 0, { event: 'step_update', _turn_id: 'attempt', step_update: { tool_name: 'run_command' } });
      await writeFile(path.join(f.directory, 'antigravity-events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    }
    if (change === 'cancel') f.assertInactive = async () => { throw new Error('Operator paused'); };
    await assert.rejects(recoverAntigravityRejectedCall({ ...f, apply: true }));
    assert.equal(await readFile(path.join(f.directory, 'run.json'), 'utf8'), f.records['run.json']);
    assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), f.records['integrity-violation.json']);
  }
});
test('failed final provider admission rolls back the lifecycle and violation flag', async t => {
  const f = await signedFixture(t); let calls = 0;
  f.assertInactive = async () => { if (++calls === 3) await writeFile(path.join(f.root, 'agy'), 'changed'); };
  await assert.rejects(recoverAntigravityRejectedCall({ ...f, apply: true }), /executable changed/);
  assert.equal(await readFile(path.join(f.directory, 'run.json'), 'utf8'), f.records['run.json']);
  assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), f.records['integrity-violation.json']);
});
