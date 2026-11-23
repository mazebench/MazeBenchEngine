// Operator-only: disconnect a run from editor publication without changing its
// engine, checkpoint, moves, or any previously signed world revision.
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, rename, mkdir, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { readLiveWorld, readWorldRevision } from './storage/live-world.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';

async function atomic(file, bytes) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temp, { force: true }); }
}

export async function pinRunWorld(directory, sourceRoot) {
  const store = path.join(directory, 'world-updates'), lock = path.join(store, '.publish-lock');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST' || attempt >= 200) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'integrity.json'), 'utf8'));
    const { head } = readLiveWorld(directory, manifest.configuration.world_base_sha256);
    if (head.project_root !== sourceRoot) return { changed: false, revision: head.revision };
    const metadata = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8'));
    // An in-flight action may already have read the head; do not roll its world
    // back underneath it. Inactive runs retain their last observed revision.
    const active = !['paused', 'failed', 'stopped', 'completed'].includes(metadata.status);
    const summary = active ? null : await readCheckpointJson(directory, 'summary.json');
    const observed = summary?.world_revision;
    const selected = !active && Number.isSafeInteger(observed) && observed >= 0 && observed <= head.revision
      ? readWorldRevision(directory, observed) : head;
    const revision = head.revision + 1;
    const body = { policy: head.policy, project_root: store, revision, at: new Date().toISOString(), previous: head.hmac,
      edit: { source: 'operator-pin-world', previous_project_root: sourceRoot, selected_revision: selected.revision,
        reason: 'Keep existing runs on their recorded world; future editor changes belong to new releases.' }, rooms: selected.rooms };
    const key = await readFile(path.join(directory, 'sandbox-state/integrity-key'));
    const bytes = JSON.stringify({ ...body, hmac: createHmac('sha256', key).update(JSON.stringify(body)).digest('hex') }) + '\n';
    await atomic(path.join(store, 'revisions', `${revision}.json`), bytes);
    await atomic(path.join(store, 'head.json'), bytes);
    readLiveWorld(directory, manifest.configuration.world_base_sha256);
    return { changed: true, revision, selectedRevision: selected.revision, active };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
