// Read-only derivatives for both observation modes. ASCII reconstruction runs
// only in memory and verifies every saved state hash; vision uses saved frames.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VisionRuntime } from './vision/runtime.mjs';
import { verifyVisionIntegrity } from './vision/policy.mjs';
import { POLICY as PROVIDER_VISION_POLICY, verifyProviderVisionIntegrity } from './vision-providers/policy.mjs';
import { verifyRunIntegrity, verifyCheckpoint } from './v1/integrity.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { verifyJournal, isIncremental } from './storage/journal.mjs';
import { V2_WORLD_FORMAT } from '../render/v1/voxel-world-v2.mjs';
import { RecordedReplayBuilder } from './recorded-replay.mjs';
import { openAsciiReplay, readAsciiReplayHistory } from './ascii-replay-source.mjs';

export class PlaybackReplay {
  constructor(root) { this.root = root; this.cache = new Map(); this.loading = new Map(); }
  async movie(directory, {limit = Infinity} = {}) {
    if (this.loading.has(directory)) return this.loading.get(directory);
    const task = this.build(directory,limit); this.loading.set(directory,task);
    try { return await task; } finally { this.loading.delete(directory); }
  }
  async chunk(directory, cursor = {}) {
    const limit = Math.max(1,Math.min(256,Math.floor(Number(cursor.limit)||128)));
    const value = await this.movie(directory,{limit});
    const {sliceReplayChunk} = await import('./replay-chunks.mjs');
    return sliceReplayChunk(value,{...cursor,limit});
  }
  async build(directory, limit = Infinity) {
    const incremental = isIncremental(directory), head = incremental ? verifyJournal(directory) : (verifyCheckpoint(directory), null);
    const metadata = JSON.parse(await readFile(path.join(directory,'run.json'),'utf8'));
    const manifest = JSON.parse(await readFile(path.join(directory,'integrity.json'),'utf8'));
    const epoch = head ? `${head.generation}:${head.historyEpoch || head.generation}` : `legacy:${metadata.created_at || directory}`;
    const summary = head?.summary || await readCheckpointJson(directory,'summary.json');
    const count = summary.action_count;
    let entry = this.cache.get(directory);
    if (entry?.value.epoch === epoch && entry.value.action_count === count) return entry.value;
    const vision = metadata.observation_mode === 'vision';
    if (vision) await (metadata.capability_policy?.name===PROVIDER_VISION_POLICY?verifyProviderVisionIntegrity:verifyVisionIntegrity)(this.root,directory,metadata);
    else await verifyRunIntegrity(this.root,directory,metadata.integrity);
    if (!entry || entry.value.epoch !== epoch || entry.value.action_count > count) {
      const source = vision ? null : await openAsciiReplay(this.root,directory,metadata);
      const runtime = vision ? await VisionRuntime.open(this.root,directory) : source.runtime, assets = runtime.assets;
      const rooms = assets.rooms.map(room => assets.liveWorld?.room(room.fileName,0) || room);
      const world = {storageFormat:V2_WORLD_FORMAT,columns:[...new Set(rooms.map(room=>room.position[0]))].sort(),rows:[...new Set(rooms.map(room=>room.position[1]))].sort(),
        roomWidth:assets.roomWidth,roomHeight:assets.roomHeight,rooms,blocks:assets.blocks,
        asciiRenderer: manifest.files?.['engine/v1/ascii-v2.json'] ? 2 : 1,
        ...(manifest.configuration?.character_seed ? {characterSeed:manifest.configuration.character_seed} : {})};
      entry = {source,runtime,world,builder:new RecordedReplayBuilder(world),value:{epoch,action_count:-1}};
    } else if (vision && entry.runtime.internal.actionCount !== count) entry.runtime = await VisionRuntime.open(this.root,directory);
    else if (!vision && entry.source.saved.actionCount !== count) entry.source.saved = await readAsciiReplayHistory(directory);
    const {runtime,world,builder,source} = entry;
    const available = vision ? runtime.internal.actionCount : source.saved.actionCount;
    const end = Math.min(available,entry.value.action_count+limit);
    try {
      for (let move = entry.value.action_count+1; move <= end; move++) {
        let record;
        if (vision) {
          const set = runtime.frameSet(move), index = JSON.parse((await runtime.readRecord(set.animation.index_record)).content), frames = [];
          for (const item of index.frames) {
            const {frame} = await runtime.readRecord(item.record);
            frames.push({room:item.room,objects:frame.room.objects,camera:frame.camera});
          }
          record = {action:move ? set : {action:'initial',totalGems:0},frames,cycle:index.cycle};
        } else record = await source.readMove(move);
        const before = world.rooms.find(room=>room.position.join('x')===record.action.roomBefore);
        const authored = before && runtime.assets.liveWorld ? [runtime.assets.liveWorld.room(before.fileName,record.action.roomRevisionBefore ?? 0)] : world.rooms;
        builder.append(move,record,authored);
        if (move%32===0) await new Promise(resolve=>setTimeout(resolve,0));
      }
      if (head) {
        const after=verifyJournal(directory);
        if (`${after.generation}:${after.historyEpoch||after.generation}`!==epoch) throw new Error('Replay history changed. Reload the player.');
      }
      entry.value={epoch,action_count:end,total_action_count:available,observation_mode:vision?'vision':'ascii',world,movie:builder.movie()};
      entry.bytes=Buffer.byteLength(JSON.stringify(entry.value));
      this.cache.delete(directory);this.cache.set(directory,entry);
      while(this.cache.size>2||[...this.cache.values()].reduce((sum,item)=>sum+item.bytes,0)>128*1024*1024)this.cache.delete(this.cache.keys().next().value);
      return entry.value;
    } catch(error) {this.cache.delete(directory);throw error;}
  }
  async close() {await Promise.allSettled(this.loading.values());this.cache.clear();}
}
