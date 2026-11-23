import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectMissingImageReads, missingObservationRead, recoverGeminiImageRead } from '../benchmarking/recover-gemini-image-read.mjs';
import { createRunIntegrity } from '../benchmarking/v1/integrity.mjs';
import { VisionRuntime } from '../benchmarking/vision/runtime.mjs';
import { POLICY, providerVisionHashes, verifyProviderVisionIntegrity } from '../benchmarking/vision-providers/policy.mjs';
import { digest } from '../benchmarking/antigravity/policy.mjs';

const root = path.resolve(import.meta.dirname, '..'), id = 'run-2026-10-26T00-00-00-000Z-cccccc';
const at = '2026-10-26T01:00:00.000Z';
async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maze-image-recovery-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = path.join(temp, id), imageDirectory = path.join(directory, 'vision-images');
  await mkdir(imageDirectory, { recursive: true }); await mkdir(path.join(directory, 'agent-cwd'));
  const file = path.join(imageDirectory, 'a'.repeat(64) + '.png');
  const metadata = { id, provider: 'antigravity', observation_mode: 'vision', world: 'main-world', model: 'gemini-fixture',
    effort: 'high', tools_enabled: false, coding_mode: 'off', status: 'failed', antigravity_session_id: 'same-conversation',
    error: `ENOENT: no such file or directory, lstat '${file}'` };
  const make = state => ({ event: 'step_update', _turn_id: 'turn', _received_at: at,
    step_update: { conversation_id: metadata.antigravity_session_id, step_index: 2, state, tool_name: 'view_file', tool_info: {
      name: 'view_file', parameters: { AbsolutePath: file }, ...(state === 'ERROR' ? { error: { type: 'TOOL_ERROR',
        message: `declaring permissions: model output error: invalid tool call error (invalid_args) failed to read file: stat ${file}: no such file or directory` } } : {}) } } });
  const events = [{ event: 'init', _turn_id: 'turn', conversation_id: metadata.antigravity_session_id,
    init: { agent: 'mazebench', model: metadata.model, permission_mode: 'request-review', cwd: path.join(directory, 'agent-cwd') } }, make('ACTIVE'), make('ERROR')];
  const activity = [{ at: '2026-10-26T00:59:00.000Z', status: 'completed', tool: 'maze_observe', action_count_after: 1 }];
  return { directory, metadata, file, events, activity, frozen: { image_directory: imageDirectory }, summary: { action_count: 1 } };
}

test('only explicit missing observation paths are candidates', () => {
  assert(missingObservationRead("ENOENT: no such file or directory, lstat '/run/vision-images/abc.png'"));
  for (const error of ['Run invalidated by an integrity violation.', "ENOENT: no such file or directory, lstat '/run/private.json'", 'Observation PNG changed.']) assert.equal(missingObservationRead(error), null);
});

test('a confirmed nonexistent observation read preserves the last valid move', async t => {
  const f = await fixture(t), evidence = await inspectMissingImageReads(f);
  assert.equal(evidence.action_count, 1); assert.deepEqual(evidence.rejected_files, [f.file]);
});

test('successful, unconfirmed, redirected, issued, or state-changing reads are never cleared', async t => {
  for (const kind of ['success', 'unfinished', 'outside', 'issued', 'existing', 'late-action', 'prior-violation', 'result', 'missing-init']) {
    const f = await fixture(t), step = f.events.at(-1).step_update;
    if (kind === 'success') step.state = 'DONE';
    if (kind === 'unfinished') f.events.pop();
    if (kind === 'outside') step.tool_info.parameters.AbsolutePath = '/tmp/private.png';
    if (kind === 'issued') f.activity.unshift({ at: '2026-10-26T00:58:00Z', type: 'vision_image', sha256: 'a'.repeat(64) });
    if (kind === 'existing') await writeFile(f.file, 'changed bytes');
    if (kind === 'late-action') f.activity.push({ at, status: 'completed', action_count_after: 1 });
    if (kind === 'prior-violation') f.events.splice(1, 0, { event: 'step_update', _turn_id: 'turn', step_update: { tool_name: 'shell' } });
    if (kind === 'result') step.tool_info.result = 'file data';
    if (kind === 'missing-init') f.events.shift();
    await assert.rejects(inspectMissingImageReads(f), undefined, kind);
  }
});

test('audited recovery verifies the signed runtime and keeps checkpoint, conversation, and history intact', { timeout: 60000 }, async t => {
  const f = await fixture(t), prompt = 'Play the vision maze.';
  const configuration = { ...f.frozen, storage_format: 'incremental-v1', provider: 'antigravity', observation_mode: 'vision',
    world: 'main-world', model: f.metadata.model, effort: 'high', tools_enabled: false, coding_mode: 'off', action_limit: null, start_room: 'HxI',
    effective_prompt_sha256: digest(prompt), vision_provider_policy: POLICY, vision_provider_runtime: await providerVisionHashes(root),
    capability_policy: { name: POLICY }, immutable_config: {}, antigravity_version: '1.3.5',
    antigravity_executable: process.execPath, antigravity_sha256: digest(await readFile(process.execPath)) };
  const integrity = await createRunIntegrity(root, f.directory, configuration);
  const runtime = await VisionRuntime.create(root, f.directory, { incremental: true, startRoom: 'HxI' }); await runtime.apply('up');
  const metadata = { ...configuration, ...f.metadata, integrity };
  const json = (file, value) => writeFile(path.join(f.directory, file), JSON.stringify(value));
  await json('run.json', metadata); await json('integrity-violation.json', { error: metadata.error, at });
  await writeFile(path.join(f.directory, 'prompt.md'), prompt);
  await writeFile(path.join(f.directory, 'antigravity-events.jsonl'), f.events.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(path.join(f.directory, 'tool-activity.jsonl'), f.activity.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(path.join(f.directory, 'agent-events.jsonl'), '{}\n');
  const files = ['integrity.json', 'checkpoint.json', 'summary.json', 'game-state.json', 'display.json', 'prompt.md', 'antigravity-events.jsonl', 'tool-activity.jsonl'];
  const before = await Promise.all(files.map(file => readFile(path.join(f.directory, file))));
  const args = { root, directory: f.directory, assertInactive: async () => {} };
  assert.equal((await recoverGeminiImageRead(args)).applied, false);
  await assert.rejects(recoverGeminiImageRead({ ...args, assertInactive: async () => { throw new Error('active'); }, apply: true }), /active/);
  const result = await recoverGeminiImageRead({ ...args, apply: true });
  assert.equal(result.applied, true); assert.equal(result.action_count, 1);
  assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(f.directory, file)))), before);
  const repaired = JSON.parse(await readFile(path.join(f.directory, 'run.json')));
  assert.equal(repaired.antigravity_session_id, metadata.antigravity_session_id); assert.equal(repaired.status, 'paused');
  await verifyProviderVisionIntegrity(root, f.directory, repaired);
  assert.equal(JSON.parse(await readFile(path.join(result.backup, 'audit.json'))).phase, 'applied');
});
