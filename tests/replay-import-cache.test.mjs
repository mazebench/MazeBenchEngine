import test from "node:test";
import assert from "node:assert/strict";
import { compilerFingerprint, replayCacheKey, readCachedReplay, writeCachedReplay } from "../replays/v1/import-cache.mjs";

test("compiler fingerprint follows transitive, dynamic, and cyclic local dependencies", async () => {
  let version="old";
  const source=url=>url.endsWith('/movie.mjs')?'import "./helper.mjs";':url.endsWith('/helper.mjs')?`import "./movie.mjs"; export const version="${version}";`:url.endsWith('/worker.mjs')?'import("./movie.mjs");':"";
  const before=await compilerFingerprint(source);assert.equal(await compilerFingerprint(source),before);
  version="new";assert.notEqual(await compilerFingerprint(source),before);
});

test("replay cache invalidates full definitions, room data, source, start, and compiler", async () => {
  const args={world:{blocks:[{id:'tree',visual:{height:3}}],rooms:[{objects:[{x:1,y:2,z:0}]}],columns:[0],rows:[0],roomWidth:16,roomHeight:16},text:'RL',start:'LxO',name:'test',compiler:'engine-and-code-hash'};
  const key=await replayCacheKey(args);assert.equal(await replayCacheKey(structuredClone(args)),key);
  for(const change of [a=>a.world.blocks[0].visual.height++,a=>a.world.rooms[0].objects[0].x++,a=>a.text+='U',a=>a.start='AxB',a=>a.compiler='new-engine',a=>a.world.roomWidth++]) {
    const next=structuredClone(args);change(next);assert.notEqual(await replayCacheKey(next),key);
  }
});

test("unavailable replay storage falls back without preventing compilation", async () => {
  assert.equal(await readCachedReplay('missing'),null);assert.equal(await writeCachedReplay('missing',{clips:[]}),false);
});
