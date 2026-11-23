// Operator-published room revisions. These files are private to the harness;
// agents receive only rendered observations and immutable recorded frames.
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants, closeSync, fsyncSync, openSync, writeFileSync, renameSync, realpathSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {safeDirectory, safeReadFile} from '../v1/safe-files.mjs';
import {decodeVoxelRoom, encodeVoxelRoom} from '../../render/v1/voxel-world-v2.mjs';
import {engineRoleIdForObject} from '../../engine/v1/adapter.mjs';

export const LIVE_WORLD_POLICY = 'next-entry-v1';
const SOURCE = 'level-data/v2/main-world';
const STORE = 'world-updates';
const digest = value => createHash('sha256').update(value).digest('hex');
const key = directory => safeReadFile(directory, 'sandbox-state/integrity-key', null);
const signatures = (directory, value) => createHmac('sha256', key(directory)).update(JSON.stringify(value)).digest('hex');
function sign(directory, value) { return {...value, hmac: signatures(directory, value)}; }
function authenticate(directory, value) {
  const {hmac, ...body} = value;
  const actual = Buffer.from(String(hmac || ''), 'hex');
  const expected = Buffer.from(signatures(directory, body), 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Room update signature failed verification.');
  if (body.policy !== LIVE_WORLD_POLICY || !Number.isSafeInteger(body.revision) || body.revision < 0) throw new Error('Invalid room revision.');
  return value;
}
function filename(file) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(file) || file === 'world.json') throw new Error('Invalid room filename.');
  return file;
}
function atomic(directory, relative, value) {
  const folder = safeDirectory(directory, path.dirname(relative), {create: true});
  const temp = path.join(folder, `.world-${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path.join(directory, relative));
  const dir = openSync(folder, constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
async function immutable(directory, relative, value) {
  safeDirectory(directory, path.dirname(relative), {create: true});
  try { await writeFile(path.join(directory, relative), value, {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if (error.code !== 'EEXIST' || safeReadFile(directory, relative) !== value) throw error;
  }
  const fd = openSync(path.join(directory, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function readWorldRevision(directory, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid room revision.');
  const value = authenticate(directory, JSON.parse(safeReadFile(directory, `${STORE}/revisions/${revision}.json`)));
  if (value.revision !== revision) throw new Error('Room revision identity changed.');
  return value;
}
export function readLiveWorld(directory, baseHash) {
  const baseBytes = safeReadFile(directory, `${STORE}/revisions/0.json`);
  if (digest(baseBytes) !== baseHash) throw new Error('Original authored world snapshot changed.');
  const base = authenticate(directory, JSON.parse(baseBytes));
  const head = authenticate(directory, JSON.parse(safeReadFile(directory, `${STORE}/head.json`)));
  if (JSON.stringify(head) !== JSON.stringify(readWorldRevision(directory, head.revision))) throw new Error('Room update commit is incomplete.');
  if (JSON.stringify(Object.keys(head.rooms)) !== JSON.stringify(Object.keys(base.rooms))) throw new Error('Room updates cannot change world topology.');
  return {base, head};
}
function goals(file, room, blocks) {
  const definitions = new Map(blocks.map(b => [b.id, b]));
  return room.objects.filter(o => engineRoleIdForObject(o, definitions) === 'goal')
    .map(o => ({coordinate: `${file}:${o.x}:${o.y}:${o.z}`, position: [o.x,o.y,o.z]}))
    .sort((a,b) => a.coordinate.localeCompare(b.coordinate));
}
// Keep exact-coordinate identities first, then match moved gems to the nearest
// unused identity, including retired ones. Removing/re-adding a collected gem
// cannot award it again. Additional gems receive new identities.
function gemIdentities(file, room, blocks, previous = [], revision = 0) {
  const available = previous.map(slot => ({...slot}));
  const current = goals(file, room, blocks), assignments = new Map(), used = new Set();
  for (const goal of current) {
    const index = available.findIndex((s,i) => !used.has(i) && s.position.every((v,n) => v === goal.position[n]));
    if (index >= 0) { used.add(index); assignments.set(goal.coordinate,index); }
  }
  const pairs = current.filter(g => !assignments.has(g.coordinate)).flatMap(goal => available.map((slot,index) => ({goal,index,distance:slot.position.reduce((n,v,i) => n+Math.abs(v-goal.position[i]),0)})))
    .sort((a,b) => a.distance-b.distance || a.goal.coordinate.localeCompare(b.goal.coordinate) || a.index-b.index);
  for (const pair of pairs) if (!used.has(pair.index) && !assignments.has(pair.goal.coordinate)) {
    used.add(pair.index); assignments.set(pair.goal.coordinate,pair.index);
  }
  const keys = {};
  for (const goal of current) {
    let index = assignments.get(goal.coordinate);
    if (index === undefined) {
      index = available.length;
      available.push({id: revision ? `${file}:live:${revision}:${index}` : goal.coordinate, position:goal.position});
    }
    available[index].position = goal.position;
    keys[goal.coordinate] = available[index].id;
  }
  return {gem_slots:available, gem_keys:keys};
}
export function validateRoomSource(source, blocks) {
  const room = decodeVoxelRoom(typeof source === 'string' ? JSON.parse(source) : source);
  if (room.width !== 16 || room.height !== 16) throw new Error('Main-world rooms must remain exactly 16 by 16 cells.');
  const known = new Set(blocks.map(b => b.id));
  if (room.objects.some(o => !known.has(o.blockId))) throw new Error('Room contains an unknown block.');
  return {room, source:JSON.stringify(encodeVoxelRoom(room))+'\n'};
}
export async function createLiveWorld(projectRoot, directory) {
  const manifest = JSON.parse(safeReadFile(projectRoot, `${SOURCE}/world.json`));
  safeDirectory(directory, STORE, {create:true});
  const rooms = {};
  for (const file of Object.keys(manifest.rooms)) {
    filename(file);
    const source = safeReadFile(projectRoot, `${SOURCE}/${file}`), room = decodeVoxelRoom(JSON.parse(source));
    const sha256 = digest(source);
    await immutable(directory, `${STORE}/rooms/${sha256}.json`, source);
    rooms[file] = {sha256, revision:0, ...gemIdentities(file,room,manifest.blocks)};
  }
  const base = sign(directory, {policy:LIVE_WORLD_POLICY, project_root:realpathSync(projectRoot), revision:0, at:new Date().toISOString(), previous:null, rooms});
  const bytes = JSON.stringify(base)+'\n';
  await immutable(directory, `${STORE}/revisions/0.json`, bytes);
  atomic(directory, `${STORE}/head.json`, bytes);
  // Close the launch/publication race: head now exists, so future editor saves
  // see this run. Any edit made during the initial copy is caught here.
  for (const file of Object.keys(rooms)) {
    const source = safeReadFile(projectRoot, `${SOURCE}/${file}`);
    if (digest(source) !== rooms[file].sha256) await publishRoomRevision(directory,file,source,manifest.blocks,{source:'launch-sync'});
  }
  return digest(bytes);
}
async function withPublishLock(directory, action) {
  const lock = path.join(safeDirectory(directory, STORE), '.publish-lock');
  for (let attempt=0; ; attempt++) {
    try { await mkdir(lock, {mode:0o700}); break; }
    catch (error) { if (error.code !== 'EEXIST' || attempt >= 200) throw error; await new Promise(resolve => setTimeout(resolve,25)); }
  }
  try { return await action(); } finally { await rm(lock, {recursive:true,force:true}); }
}
export async function publishRoomRevision(directory, file, source, blocks, audit = {}) {
  filename(file);
  const {room,source:canonical} = validateRoomSource(source,blocks);
  return withPublishLock(directory, async () => {
    const head = authenticate(directory,JSON.parse(safeReadFile(directory,`${STORE}/head.json`)));
    const before = head.rooms[file];
    if (!before) throw new Error('Room is outside this run’s world.');
    // Formatting-only editor saves do not create a new room version.
    const oldRoom = decodeVoxelRoom(JSON.parse(safeReadFile(directory,`${STORE}/rooms/${before.sha256}.json`)));
    if (JSON.stringify(encodeVoxelRoom(oldRoom))+'\n' === canonical) return {revision:head.revision,changed:false};
    const sha256 = digest(canonical), revision = head.revision+1;
    await immutable(directory,`${STORE}/rooms/${sha256}.json`,canonical);
    const after = {sha256,revision,...gemIdentities(file,room,blocks,before.gem_slots,revision)};
    const next = sign(directory,{policy:LIVE_WORLD_POLICY,project_root:head.project_root,revision,at:new Date().toISOString(),previous:head.hmac,
      edit:{file,old_sha256:before.sha256,new_sha256:sha256,source:audit.source||'editor'},rooms:{...head.rooms,[file]:after}});
    const bytes = JSON.stringify(next)+'\n';
    // This index is beyond the committed head; replace any orphan from an
    // interrupted publication, then commit the head last.
    atomic(directory,`${STORE}/revisions/${revision}.json`,bytes);
    atomic(directory,`${STORE}/head.json`,bytes);
    return {revision,changed:true};
  });
}
export async function publishEditorRoom(projectRoot, roots, file, source) {
  const manifest = JSON.parse(safeReadFile(projectRoot,`${SOURCE}/world.json`));
  filename(file); if (!Object.hasOwn(manifest.rooms,file)) throw new Error('Unknown main-world room.');
  const results = [];
  for (const root of [...new Set(roots)]) {
    const entries = await readdir(root,{withFileTypes:true}).catch(error => {if(error.code==='ENOENT')return [];throw error;});
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9-]+$/.test(entry.name)) continue;
      const directory = safeDirectory(root,entry.name);
      try { if (JSON.parse(safeReadFile(directory,`${STORE}/head.json`)).project_root !== realpathSync(projectRoot)) continue; }
      catch (error) { if(error.code==='ENOENT'||error.message==='Workspace directories must not contain symbolic links.')continue;throw error; }
      results.push({id:entry.name,...await publishRoomRevision(directory,file,source,manifest.blocks)});
    }
  }
  return results;
}
export class LiveWorldRooms {
  constructor(directory,configuration,decorate) {
    this.directory=directory;this.configuration=configuration;this.decorate=decorate;this.cache=new Map();
    const {base,head}=readLiveWorld(directory,configuration.world_base_sha256);this.base=base;this.head=head;
  }
  refresh() { this.head=readLiveWorld(this.directory,this.configuration.world_base_sha256).head;return this.head; }
  room(file,revision=this.head.rooms[file]?.revision) {
    const cacheKey=file+':'+revision;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const manifest=revision===this.head.revision?this.head:revision===0?this.base:readWorldRevision(this.directory,revision);
    const descriptor=manifest.rooms[file];
    if (!descriptor || descriptor.revision!==revision) throw new Error('Unknown authored room version.');
    const bytes=safeReadFile(this.directory,`${STORE}/rooms/${descriptor.sha256}.json`);
    if(digest(bytes)!==descriptor.sha256)throw new Error('Authored room snapshot changed.');
    const room=this.decorate(file,decodeVoxelRoom(JSON.parse(bytes)));
    Object.assign(room,{liveRevision:revision,gemKeys:descriptor.gem_keys});this.cache.set(cacheKey,room);return room;
  }
  rooms(currentFile,currentRevision=0) {
    return Object.keys(this.head.rooms).map(file=>this.room(file,file===currentFile?currentRevision:this.head.rooms[file].revision));
  }
}
