import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pinRunWorld } from '../benchmarking/world-pinning.mjs';
import { createLiveWorld, publishEditorRoom, readLiveWorld } from '../benchmarking/storage/live-world.mjs';
import { V2_BLOCK_CATALOG, encodeVoxelRoom } from '../render/v1/voxel-world-v2.mjs';

for (const status of ['paused', 'continuing']) test(`world pin preserves history and excludes editor publication (${status})`, async () => {
  const root = await realpath(await mkdtemp('/tmp/world-pin-'));
  try {
    const records = path.join(root, 'runs'), run = path.join(records, 'run-test'), level = path.join(root, 'level-data/v2/main-world');
    await mkdir(path.join(run, 'sandbox-state'), { recursive: true }); await mkdir(level, { recursive: true });
    const room = { width: 16, height: 16, objects: [{ blockId: 'floor', x: 0, y: 0, z: 0 }] };
    const source = () => JSON.stringify(encodeVoxelRoom(room));
    await writeFile(path.join(level, 'world.json'), JSON.stringify({ rooms: { 'a.json': ['A', 'A'] }, blocks: V2_BLOCK_CATALOG }));
    await writeFile(path.join(level, 'a.json'), source());
    await writeFile(path.join(run, 'sandbox-state/integrity-key'), randomBytes(32));
    const baseHash = await createLiveWorld(root, run);
    await writeFile(path.join(run, 'integrity.json'), JSON.stringify({ configuration: { world_base_sha256: baseHash } }));
    await writeFile(path.join(run, 'run.json'), JSON.stringify({ status }));
    await writeFile(path.join(run, 'summary.json'), JSON.stringify({ world_revision: 0 }));
    await writeFile(path.join(run, 'checkpoint.json'), 'untouched checkpoint');
    room.objects.push({ blockId: 'wall', x: 1, y: 1, z: 0 });
    await publishEditorRoom(root, [records], 'a.json', source());
    const before = await readFile(path.join(run, 'world-updates/revisions/1.json'));
    const pinned = await pinRunWorld(run, root);
    assert.equal(pinned.selectedRevision, status === 'paused' ? 0 : 1);
    assert.equal(await readFile(path.join(run, 'checkpoint.json'), 'utf8'), 'untouched checkpoint');
    assert.deepEqual(await readFile(path.join(run, 'world-updates/revisions/1.json')), before);
    const head = readLiveWorld(run, baseHash).head;
    room.objects.push({ blockId: 'wall', x: 2, y: 2, z: 0 });
    assert.deepEqual(await publishEditorRoom(root, [records], 'a.json', source()), []);
    assert.deepEqual(readLiveWorld(run, baseHash).head, head);
    assert.equal((await pinRunWorld(run, root)).changed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
