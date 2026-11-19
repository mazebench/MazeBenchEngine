// Explicit operator correction of the excessive November 13 rollback.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseOwner } from '../benchmarking/runtime-release-store.mjs';
import { findClaudeSession } from '../benchmarking/recovery/claude-prefix.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { atomicJson } from '../benchmarking/providers/claude-runner.mjs';
const id = 'run-2026-11-09T20-38-05-844Z-dd6a6a', { root, directory } = releaseOwner(id);
const source = path.join(directory, 'repairs/claude-tail-xjAviG');
const policy = await import(pathToFileURL(path.join(root, 'benchmarking/providers-v3/claude-policy.mjs')).href);
const hash = async file => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); };
async function clone(a, b) { await mkdir(path.dirname(b), { recursive: true, mode: 0o700 }); await cp(a, b, { recursive: true, mode: constants.COPYFILE_FICLONE, force: false, errorOnExist: true }); }
async function replace(a, b) { await mkdir(path.dirname(b), { recursive: true, mode: 0o700 }); const temp = b + '.restore-tmp'; await copyFile(a, temp, constants.COPYFILE_FICLONE); await rename(temp, b); }
async function inactive() { const x = await (await fetch('http://127.0.0.1:8090/api/benchmark/v1/runs/' + id + '?view=overview')).json(); assert.equal(x.runner_active, false); assert.equal(x.status, 'paused'); }
await inactive();
const currentBytes = await readFile(path.join(directory, 'run.json')), current = JSON.parse(currentBytes), original = JSON.parse(await readFile(path.join(source, 'run.json')));
const priorAudit = JSON.parse(await readFile(path.join(source, 'audit.json')));
assert.equal(priorAudit.phase, 'applied'); assert.equal(priorAudit.action_count_before, 10088); assert.equal(priorAudit.gems_before, 15);
await policy.verifyClaudeIntegrity(root, directory, current); await policy.verifyClaudeIntegrity(root, source, original);
for (const [file, expected] of Object.entries(priorAudit.source_sha256)) assert.equal(await hash(path.join(source, file)), expected);
assert.equal(await hash(path.join(source, 'session.before.jsonl')), priorAudit.session_before_sha256);
const saved = await readCheckpointJson(source, 'summary.json'), present = await readCheckpointJson(directory, 'summary.json');
assert.equal(saved.action_count, 10088); assert.equal(saved.gems_collected, 15);
assert.deepEqual(present.actions.slice(0, 6849), saved.actions.slice(0, 6849));
const session = await findClaudeSession(current), sessionHash = await hash(session);
const backup = await mkdtemp(path.join(directory, 'repairs/restore-fable-15-'));
const files = ['run.json', 'checkpoint.json', 'game-state.json', 'summary.json', 'display.json', 'claude-events.jsonl', 'agent-events.jsonl', 'tool-activity.jsonl', 'claude-runtime-settings.jsonl', 'last-message.txt'];
const hashes = Object.fromEntries(await Promise.all(files.map(async f => [f, await hash(path.join(directory, f))])));
for (const file of files) await clone(path.join(directory, file), path.join(backup, file));
for (const file of ['integrity.json', 'prompt.md', 'sandbox-state', 'world-updates']) await clone(path.join(directory, file), path.join(backup, file));
const head = JSON.parse(await readFile(path.join(directory, 'checkpoint.json')));
await clone(path.join(directory, 'journal', head.generation), path.join(backup, 'journal', head.generation));
await clone(session, path.join(backup, 'session.before.jsonl'));
const overwritten = [], restored = [];
for (const folder of ['records/move_history', 'display-history']) {
  for (const name of await readdir(path.join(directory, folder))) { const match = /^move_(\d+)(?:\.(?:json|txt))?$/.exec(name); if (match && Number(match[1]) > 6849) { const relative = path.join(folder, name); overwritten.push(relative); await clone(path.join(directory, relative), path.join(backup, relative)); } }
  for (const name of await readdir(path.join(source, folder))) restored.push(path.join(folder, name));
}
const originalHead = JSON.parse(await readFile(path.join(source, 'checkpoint.json')));
for (const name of ['base-state.json', 'base-summary.json', 'entries.jsonl']) assert.equal(await hash(path.join(directory, 'journal', originalHead.generation, name)), await hash(path.join(source, 'journal', originalHead.generation, name)));
const audit = { kind: 'restore-fable-15-progress-v1', phase: 'prepared', at: new Date().toISOString(), run_id: id, source, backup,
  actions_before: present.action_count, actions_after: saved.action_count, gems_after: 15, source_manifest_unchanged: true,
  reason: 'User corrected the excessive accounting-based rollback. Restore all original gameplay and original conversation, then separately remove only the terminal synthetic provider error. Preserve this superseded continuation in the archive.' };
await atomicJson(path.join(backup, 'audit.json'), audit); await inactive();
for (const [file, expected] of Object.entries(hashes)) assert.equal(await hash(path.join(directory, file)), expected);
assert.equal(await hash(session), sessionHash);
try {
  // The original flag prevents ordinary resume throughout publication.
  await replace(path.join(source, 'integrity-violation.json'), path.join(directory, 'integrity-violation.json'));
  for (const relative of overwritten) await rm(path.join(directory, relative), { recursive: true });
  for (const relative of restored) await clone(path.join(source, relative), path.join(directory, relative));
  await replace(path.join(source, 'session.before.jsonl'), session);
  for (const file of files.filter(f => f !== 'run.json' && f !== 'checkpoint.json')) await replace(path.join(source, file), path.join(directory, file));
  await replace(path.join(source, 'checkpoint.json'), path.join(directory, 'checkpoint.json'));
  const metadata = { ...original, recoveries: [...current.recoveries, { at: audit.at, reason: audit.kind, action_count: 10088, archive: backup }], updated_at: audit.at };
  await atomicJson(path.join(directory, 'run.json'), metadata);
  await policy.verifyClaudeIntegrity(root, directory, metadata);
  assert.deepEqual(await readCheckpointJson(directory, 'summary.json'), saved);
  assert.equal(await hash(path.join(directory, 'checkpoint.json')), priorAudit.source_sha256['checkpoint.json']);
  audit.phase = 'applied'; await atomicJson(path.join(backup, 'audit.json'), audit);
  console.log(JSON.stringify({ restored: true, actions: 10088, gems: 15, backup }));
} catch (error) {
  for (const relative of restored) await rm(path.join(directory, relative), { recursive: true, force: true });
  for (const relative of overwritten) await clone(path.join(backup, relative), path.join(directory, relative));
  for (const file of files) await replace(path.join(backup, file), path.join(directory, file));
  await replace(path.join(backup, 'session.before.jsonl'), session);
  await rm(path.join(directory, 'integrity-violation.json'), { force: true });
  audit.phase = 'rolled-back'; audit.error = error.message; await atomicJson(path.join(backup, 'audit.json'), audit); throw error;
}
