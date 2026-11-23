import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRunVersion } from '../benchmarking/run-version.mjs';
import { legacyRunVersion, versionPresentation } from '../benchmarking/run-version-label.mjs';
import { readLegacyRunVersion } from '../benchmarking/legacy-run-version.mjs';
const hash = v => createHash('sha256').update(v).digest('hex');
const known = '5d054099c25c6e2d2f55838405cd4647959070d9cf694aaa28989ba9bf1869f6';
async function fixture(t, {live = false, wasm = known} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(),'maze-version-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const files = {'engine/v1/voxel_physics.wasm':wasm, 'level-data/v2/main-world/world.json':'1'.repeat(64), 'level-data/v2/main-world/a.json':'2'.repeat(64)};
  const config = {world:'main-world'};
  if (live) {
    const key = randomBytes(32);
    await mkdir(path.join(root,'sandbox-state')); await writeFile(path.join(root,'sandbox-state/integrity-key'),key);
    await mkdir(path.join(root,'world-updates/revisions'),{recursive:true});
    const sign = o => ({...o,hmac:createHmac('sha256',key).update(JSON.stringify(o)).digest('hex')});
    const base = sign({policy:'next-entry-v1',revision:0,rooms:{'a.json':{revision:0,sha256:'2'.repeat(64)}}});
    const head = sign({policy:'next-entry-v1',revision:1,rooms:{'a.json':{revision:1,sha256:'3'.repeat(64)}}});
    const bytes = JSON.stringify(base)+'\n';
    await writeFile(path.join(root,'world-updates/revisions/0.json'),bytes);
    await writeFile(path.join(root,'world-updates/revisions/1.json'),JSON.stringify(head));
    await writeFile(path.join(root,'world-updates/head.json'),JSON.stringify(head));
    Object.assign(config,{world_updates:'next-entry-v1',world_base_sha256:hash(bytes)});
  }
  const bytes=JSON.stringify({configuration:config,files});
  await writeFile(path.join(root,'integrity.json'),bytes);
  return {root,metadata:{world:'main-world',integrity:{manifest_sha256:hash(bytes)}}};
}
test('engine fingerprints remain recorded while uncatalogued snapshots remain explicit',async t=>{
  const {root,metadata}=await fixture(t);
  assert.equal(readRunVersion(root,metadata).engine.version,'1.1');
  assert.equal(readRunVersion(root,metadata).label,'v1.1.?');
  const unknown=await fixture(t,{wasm:'4'.repeat(64)});
  assert.equal(readRunVersion(unknown.root,unknown.metadata).engine.version,null);
  assert.equal(readRunVersion(unknown.root,unknown.metadata).label,'v1.1.?');
  assert.equal(readRunVersion(root,{...metadata,world:'slotski'}).world.version,null);
});
test('edits published after the last recorded action do not relabel a paused world',async t=>{
  const {root,metadata}=await fixture(t,{live:true});
  const old=readRunVersion(root,metadata,{world_revision:0});
  const updated=readRunVersion(root,metadata,{world_revision:1});
  assert.equal(old.world.edited,false);
  assert.equal(updated.world.edited,true);
  assert.equal(old.world.sha256,updated.world.sha256);
  assert.notEqual(old.world.available_sha256,updated.world.available_sha256);
  assert.equal(readRunVersion(root,metadata,{world_revision:2}).evidence,'unavailable');
});
test('missing and altered evidence stays unknown without dropping the run',async t=>{
  const {root,metadata}=await fixture(t);
  await writeFile(path.join(root,'integrity.json'),(await readFile(path.join(root,'integrity.json'),'utf8'))+' ');
  assert.equal(readRunVersion(root,metadata).label,'v1.1.?');
  assert.equal(readRunVersion(root,{}).evidence,'unavailable');
});
test('in-run engine changes are disclosed and bounded to the snapshot action',async t=>{
  const {root,metadata}=await fixture(t);
  metadata.runtime_repairs=[{action_count:20,files:{'engine/v1/voxel_physics.wasm':{before:'7'.repeat(64),after:known}}}];
  assert.equal(readRunVersion(root,metadata,{action_count:19}).engine.history,undefined);
  const value=readRunVersion(root,metadata,{action_count:21});
  assert.equal(value.label,'v1.1.?'); assert.equal(value.engine.history[0].action,20);
});
test('prior imports retain an unknown patch version without exact evidence',async t=>{
  const {root}=await fixture(t);
  assert.equal(versionPresentation(legacyRunVersion()).label,'v1.0.?');
  assert.equal(readLegacyRunVersion(root).label,'v1.0.?');
  await writeFile(path.join(root,'run.json'),JSON.stringify({id:'prior-run',game_id:'maze',level_id:'level_HxI'}));
  assert.equal(readLegacyRunVersion(root).label,'v1.0.?');
});
