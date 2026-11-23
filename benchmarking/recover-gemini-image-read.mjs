// Recover a rejected read of a nonexistent observation, never an actual read
// outside the benchmark or a changed image. Signed assets stay untouched.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, VERIFIED_VERSIONS } from './antigravity/policy.mjs';
import { POLICY, providerVisionHashes, visionBoundaryValidator } from './vision-providers/policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from './v1/integrity.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { safeReadFile } from './v1/safe-files.mjs';
import { atomicJson } from './providers/claude-runner.mjs';

export function missingObservationRead(error) {
  return /^ENOENT: no such file or directory, lstat '([^'\n]+\/vision-images\/[a-f0-9]{1,64}\.png)'$/.exec(String(error || ''))?.[1] || null;
}

// Validate the complete final turn. Every rejected request must have an explicit
// missing-file error and no data result; no maze action may follow it.
export async function inspectMissingImageReads({ directory, metadata, frozen, events, activity, summary }) {
  const missing = missingObservationRead(metadata.error);
  assert(missing, 'Not a missing observation read.');
  const turn = events.at(-1)?._turn_id;
  assert(turn && events.at(-1)?.event === 'step_update', 'Missing final tool event.');
  const first = events.findIndex(event => event._turn_id === turn);
  const tail = events.slice(first);
  assert.equal(tail[0]?.event, 'init', 'The final turn has no verified initialization.');
  assert(tail.every(event => event._turn_id === turn), 'Interleaved agent turns.');
  const validate = visionBoundaryValidator({ imageDirectory: frozen.image_directory, model: metadata.model,
    cwd: path.join(directory, 'agent-cwd'), conversationId: metadata.antigravity_session_id, toolsEnabled: false });
  let rejectedAt = null;
  const calls = new Map();
  for (const event of tail) {
    const step = event.step_update;
    if (!rejectedAt && step?.tool_name === 'view_file' && step.tool_info?.parameters?.AbsolutePath === missing) {
      assert.equal(step.state, 'ACTIVE');
      assert(Number.isFinite(Date.parse(event._received_at)), 'Missing rejection time.');
      rejectedAt = event._received_at;
    }
    if (!rejectedAt) { assert.equal(validate(event), null, 'An earlier capability violation requires review.'); continue; }
    assert.equal(event.event, 'step_update');
    assert.equal(step?.conversation_id, metadata.antigravity_session_id);
    assert.equal(step?.tool_name, 'view_file', 'Only failed image reads may follow the rejection.');
    assert(['ACTIVE', 'ERROR'].includes(step.state), 'A completed read cannot be recovered.');
    const info = step.tool_info, file = info?.parameters?.AbsolutePath;
    assert.deepEqual(Object.keys(info?.parameters || {}), ['AbsolutePath']);
    assert(Object.keys(info).every(key => ['name', 'parameters', 'error'].includes(key)), 'Unexpected tool result data.');
    assert.equal(path.dirname(file), frozen.image_directory, 'Read was outside the observation directory.');
    assert(/^[a-f0-9]{1,64}\.png$/.test(path.basename(file)), 'Not an observation filename.');
    await assert.rejects(lstat(file), { code: 'ENOENT' }, 'An existing or changed image cannot be recovered.');
    assert(!activity.some(entry => entry.type === 'vision_image' && entry.sha256 === path.basename(file, '.png')),
      'A previously issued image is missing; its provenance requires review.');
    if (step.state === 'ACTIVE') {
      assert(!calls.has(step.step_index), 'Duplicate image request.');
      assert(!info.error);
      calls.set(step.step_index, { file, failed: false });
    } else {
      const call = calls.get(step.step_index);
      assert(call && call.file === file && !call.failed, 'Unmatched image-read result.');
      assert.equal(info.error?.type, 'TOOL_ERROR');
      assert(String(info.error.message).includes('invalid tool call error (invalid_args) failed to read file: stat ' + file + ': no such file or directory'),
        'The read was not explicitly rejected before returning data.');
      call.failed = true;
    }
  }
  assert(rejectedAt && calls.size && [...calls.values()].every(call => call.failed), 'An image request has no confirmed rejection.');
  const completed = activity.filter(entry => entry.status === 'completed').at(-1);
  assert.equal(completed?.action_count_after, summary.action_count, 'Last valid checkpoint differs from the tool record.');
  assert(activity.every(entry => Date.parse(entry.completed_at || entry.at) < Date.parse(rejectedAt)),
    'Tool activity continued after the rejected read.');
  return { turn_id: turn, rejected_at: rejectedAt, rejected_files: [...calls.values()].map(call => call.file),
    action_count: summary.action_count, events_sha256: digest(JSON.stringify(tail)) };
}

async function verifyPreserved(root, directory, metadata) {
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity), frozen = manifest.configuration;
  assertRunConfiguration(metadata, manifest);
  for (const [key, value] of Object.entries({ provider: 'antigravity', observation_mode: 'vision', world: 'main-world', tools_enabled: false, coding_mode: 'off' })) {
    assert.equal(metadata[key], value); assert.equal(frozen[key], value);
  }
  assert.equal(frozen.vision_provider_policy, POLICY);
  assert.deepEqual(metadata.capability_policy, frozen.capability_policy);
  assert.deepEqual(await providerVisionHashes(root), frozen.vision_provider_runtime, 'Signed provider runtime changed.');
  assert(VERIFIED_VERSIONS.has(frozen.antigravity_version));
  assert.equal(digest(await readFile(frozen.antigravity_executable)), frozen.antigravity_sha256);
  for (const [file, hash] of Object.entries(frozen.immutable_config)) assert.equal(digest(await readFile(file)), hash, 'Provider configuration changed.');
  assert.equal(frozen.image_directory, path.join(realpathSync(directory), 'vision-images'));
  assert.equal(realpathSync(frozen.image_directory), frozen.image_directory, 'Image directory was redirected.');
  assert.equal(digest(safeReadFile(directory, 'prompt.md')), frozen.effective_prompt_sha256);
  verifyCheckpoint(directory);
  return frozen;
}

export async function recoverGeminiImageRead({ root, directory, assertInactive, apply = false }) {
  assert.equal(typeof assertInactive, 'function');
  const repairs = path.join(directory, 'repairs'); await mkdir(repairs, { recursive: true, mode: 0o700 });
  const lock = path.join(repairs, '.gemini-image-read.lock'), handle = await open(lock, 'wx', 0o600);
  try {
    const original = safeReadFile(directory, 'run.json', null), metadata = JSON.parse(original);
    assert.equal(metadata.id, path.basename(directory)); assert.equal(metadata.status, 'failed');
    assert(metadata.antigravity_session_id); await assertInactive(metadata);
    const violationBytes = safeReadFile(directory, 'integrity-violation.json', null), violation = JSON.parse(violationBytes);
    assert.equal(violation.error, metadata.error); assert(missingObservationRead(violation.error));
    const frozen = await verifyPreserved(root, directory, metadata);
    const summary = await readCheckpointJson(directory, 'summary.json');
    assert(!['won', 'action-limit'].includes(summary.game_status));
    const jsonl = file => safeReadFile(directory, file).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const evidence = await inspectMissingImageReads({ directory, metadata, frozen, summary,
      events: jsonl('antigravity-events.jsonl'), activity: jsonl('tool-activity.jsonl') });
    const files = ['integrity.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'prompt.md',
      'antigravity-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl'];
    const preserved = Object.fromEntries(files.map(file => [file, digest(safeReadFile(directory, file, null))]));
    const unchanged = async () => {
      await assertInactive(metadata);
      assert(safeReadFile(directory, 'run.json', null).equals(original), 'Run changed during recovery.');
      assert(safeReadFile(directory, 'integrity-violation.json', null).equals(violationBytes));
      for (const [file, hash] of Object.entries(preserved)) assert.equal(digest(safeReadFile(directory, file, null)), hash, `${file} changed.`);
      verifyCheckpoint(directory);
    };
    await unchanged();
    const audit = { version: 1, phase: 'prepared', kind: 'rejected-observation-read', at: new Date().toISOString(),
      run_id: metadata.id, conversation_id: metadata.antigravity_session_id, ...evidence, preserved_sha256: preserved,
      reason: 'User authorized automatic recovery of rejected, result-free tool actions. The failed image reads changed no game state; resume at the last valid checkpoint.' };
    if (!apply) return { ...audit, applied: false };
    const backup = path.join(repairs, 'gemini-image-read-' + evidence.events_sha256);
    await mkdir(backup, { mode: 0o700 });
    await writeFile(path.join(backup, 'run.before.json'), original, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(backup, 'integrity-violation.before.json'), violationBytes, { flag: 'wx', mode: 0o600 });
    await atomicJson(path.join(backup, 'audit.json'), audit); await unchanged();
    try {
      // Conversation, prompt, valid moves, images and event history are untouched.
      await atomicJson(path.join(directory, 'run.json'), { ...metadata, status: 'paused', error: null, completed_at: null,
        paused_at: audit.at, updated_at: audit.at, image_read_recoveries: [...(metadata.image_read_recoveries || []),
          { at: audit.at, action_count: summary.action_count, events_sha256: evidence.events_sha256, rejected_count: evidence.rejected_files.length }] });
      audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit);
      // Clear admission last; the owner validates the unchanged runtime again.
      await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-integrity-violation.json'));
      return { ...audit, applied: true, backup };
    } catch (error) {
      await writeFile(path.join(directory, 'run.json'), original);
      await writeFile(path.join(directory, 'integrity-violation.json'), violationBytes, { mode: 0o600 });
      audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}
