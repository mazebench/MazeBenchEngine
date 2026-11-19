import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRunIntegrity, signCheckpoint } from '../benchmarking/v1/integrity.mjs';
import { digest, runtimeHashes } from '../benchmarking/antigravity/policy.mjs';
import { runtimeHashes as catalogRuntimeHashes } from '../benchmarking/antigravity-v2/policy.mjs';
import { STARTUP_ERROR, STARTUP_REPAIR, inspectStartupFailure, auditStartupFailure, recoverAntigravityStartup } from '../benchmarking/recover-antigravity-startup.mjs';
import { recoveryFailure } from '../benchmarking/auto-resume-failure.mjs';
const at = '2026-11-13T04:33:14.242Z';
const startup = () => ({ event: 'result', _turn_id: 'failed-start', _received_at: at, result: {
  conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
} });
test('only a zero-work network/auth startup failure can be recovered', async () => {
  assert.equal(inspectStartupFailure(startup()).removed_actions, 0);
  const network = startup(); network.result.error = 'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": dial tcp 172.217.116.4:443: connect: connection refused';
  assert.equal((await auditStartupFailure([network])).turn_id, 'failed-start');
  for (const mutate of [e => e.result.conversation_id = 'other', e => e.result.num_turns = 1,
    e => e.result.duration_seconds = 1, e => e.result.usage.output_tokens = 1, e => e.result.response = 'model response',
    e => e.result.status = 'SUCCESS', e => e.result.error = 'Forbidden tool', e => e.step_update = { tool_name: 'run_command' }]) {
    const event = startup(); mutate(event); assert.throws(() => inspectStartupFailure(event));
  }
  await assert.rejects(auditStartupFailure([{ ...startup(), event: 'init' }, startup()]), /other activity/);
  await assert.rejects(auditStartupFailure([startup(), { ...startup(), _turn_id: 'other' }, startup()]), /Noncontiguous/);
});
async function fixture(t, policy = 'antigravity-mcp-only-v1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'maze-startup-repair-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'record');
  for (const folder of ['benchmarking/v1', 'benchmarking/storage', 'engine/v1', 'play/v1', 'render/v1', 'render-ascii/v1', 'level-data/v2/main-world', 'benchmarking/antigravity', 'benchmarking/antigravity-v2', 'record/agent-cwd']) await mkdir(path.join(root, folder), { recursive: true });
  const executable = path.join(root, 'agy'); await writeFile(executable, 'fixture-executable');
  const config = { provider: 'antigravity', antigravity_policy: policy, antigravity_version: '1.3.5', antigravity_executable: executable,
    antigravity_sha256: digest('fixture-executable'), antigravity_runtime: await (policy === 'antigravity-catalog-mcp-v2' ? catalogRuntimeHashes : runtimeHashes)(root), antigravity_config: {},
    model: 'gemini-4-carbon-high', world: 'main-world', observation_mode: 'ascii', tools_enabled: false, effective_prompt_sha256: digest('play') };
  const metadata = { ...config, id: 'run-2026-11-06T11-00-00-000Z-aaaaaa', status: 'failed', error: STARTUP_ERROR,
    completed_at: at, antigravity_session_id: 'original-session', capability_policy: { name: policy },
    integrity: await createRunIntegrity(root, directory, config) };
  const records = { 'run.json': JSON.stringify(metadata), 'integrity-violation.json': JSON.stringify({ error: STARTUP_ERROR, at }),
    'prompt.md': 'play', 'game-state.json': '{}', 'summary.json': JSON.stringify({ action_count: 100, gems_collected: 15, game_status: 'playing' }), 'display.json': '{}',
    'antigravity-events.jsonl': JSON.stringify(startup()) + '\n', 'agent-events.jsonl': '',
    'tool-activity.jsonl': JSON.stringify({ status: 'completed', completed_at: '2026-11-13T04:30:00Z', action_count_after: 100 }) + '\n' };
  for (const [file, bytes] of Object.entries(records)) await writeFile(path.join(directory, file), bytes);
  await signCheckpoint(directory);
  return { root, directory, metadata, records, assertInactive: async () => {} };
}
test('signed startup recovery preserves score, session and all game/log bytes', async t => {
  for (const policy of ['antigravity-mcp-only-v1', 'antigravity-catalog-mcp-v2']) {
  const f = await fixture(t, policy);
  assert.equal((await recoveryFailure(f.metadata, { directory: f.directory })).recovery_repair, STARTUP_REPAIR);
  const result = await recoverAntigravityStartup({ ...f, apply: true });
  assert.equal(result.phase, 'applied'); assert.equal(result.action_count, 100); assert.equal(result.gems_collected, 15);
  const repaired = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
  assert.equal(repaired.antigravity_session_id, 'original-session'); assert.equal(repaired.status, 'paused');
  for (const [file, hash] of Object.entries(result.preserved_sha256)) assert.equal(digest(await readFile(path.join(f.directory, file))), hash);
  await assert.rejects(access(path.join(f.directory, 'integrity-violation.json')));
  assert.equal(await readFile(path.join(result.backup, 'run.before.json'), 'utf8'), f.records['run.json']);
  }
});
test('changed checkpoint, extra execution or active runner cannot clear the flag', async t => {
  for (const kind of ['checkpoint', 'execution', 'active', 'activity']) {
    const f = await fixture(t);
    if (kind === 'checkpoint') await writeFile(path.join(f.directory, 'summary.json'), '{}');
    if (kind === 'execution') await writeFile(path.join(f.directory, 'antigravity-events.jsonl'), JSON.stringify({ ...startup(), event: 'init' }) + '\n' + f.records['antigravity-events.jsonl']);
    if (kind === 'active') f.assertInactive = async () => { throw new Error('Already active'); };
    if (kind === 'activity') await writeFile(path.join(f.directory, 'tool-activity.jsonl'), JSON.stringify({ status: 'running', at }) + '\n');
    await assert.rejects(recoverAntigravityStartup({ ...f, apply: true }));
    assert.equal(await readFile(path.join(f.directory, 'run.json'), 'utf8'), f.records['run.json']);
    assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), f.records['integrity-violation.json']);
  }
});
test('final executable verification failure restores the admission flag', async t => {
  const f = await fixture(t); let checks = 0;
  f.assertInactive = async () => { if (++checks === 3) await writeFile(path.join(f.root, 'agy'), 'changed'); };
  await assert.rejects(recoverAntigravityStartup({ ...f, apply: true }), /executable changed/);
  assert.equal(await readFile(path.join(f.directory, 'run.json'), 'utf8'), f.records['run.json']);
  assert.equal(await readFile(path.join(f.directory, 'integrity-violation.json'), 'utf8'), f.records['integrity-violation.json']);
});
