import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../render/vendor/three.module.min.js";
import { V2_BLOCK_CATALOG, V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { sampleTrack } from "../animations/v1/timeline.mjs";
import { parseReplay } from "../replays/v1/import.mjs";
import { compileReplay, unpackTimeline } from "../replays/v1/movie.mjs";
import { TimelinePool } from "../replays/v1/timeline-pool.mjs";
import { ReplaySceneCache } from "../replays/v1/scene-cache.mjs";
import { ReplayGemState } from "../replays/v1/gem-state.mjs";
import { ReplayRenderer, ReplayView } from "../replays/v1/view.mjs";

const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));
const cell = (blockId, x, y = 1, z = 0) => ({ blockId, x, y, z });
const floors = Array.from({ length: 32 }, (_, i) => cell("floor", i % 8, Math.floor(i / 8)));
const makeWorld = () => ({ storageFormat: V2_WORLD_FORMAT, columns: ["H", "I"], rows: ["I"],
  roomWidth: 8, roomHeight: 4, blockDefinitions: blocks, blocks: V2_BLOCK_CATALOG,
  rooms: [0, 1].map(columnIndex => ({ fileName: `${columnIndex}.json`, position: [columnIndex ? "I" : "H", "I"],
    columnIndex, rowIndex: 0, width: 8, height: 4, objects: [...floors, cell("player", 1),
      { ...cell("lift", 2), stateId: 0, orientation: "top" }, cell("crate", 4), cell("gem", 6)] })) });

async function makeRenderer(world) {
  const renderer = Object.assign(Object.create(ReplayRenderer.prototype), {
    canvas: { dataset: {} }, mode: "play", pickVoxels: false, scene: new THREE.Scene(), content: new THREE.Group(),
    cutawayContent: new THREE.Group(), placementPreview: new THREE.Group(), target: new THREE.Vector3(), cameraMotion: {},
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: 1, opacity: 0, followPlayer: true },
    render() { if (!this.renderSuspended) this.commandAnimation?.beforeRender(); }, requestModels() {},
    cancelCameraMotion() {}, yaw: 0
  });
  renderer.setWorld(createPlayWorldContext(world)(world.rooms[0]), { preserveCamera: true });
  await renderer.backgroundReady;
  return renderer;
}

test("stationary interning retains every object variant and shares repeated motion curves", () => {
  const pool = new TimelinePool();
  const original = { key: "0:1", index: 1, object: { ...cell("crate", 1), metadata: { label: "one" } }, block: blocks.get("crate"),
    positions: [[1, 1, 0]], initialOpacity: 1, initialPhase: 0, motion: [], fades: [], phases: [], changed: false };
  const timeline = track => ({ tracks: [track], rooms: [{ fileName: "0.json" }], duration: 100, camera: [], lighting: [] });
  const first = pool.pack(timeline(original));
  const copy = { ...original, object: structuredClone(original.object) };
  assert.equal(pool.pack(timeline(copy)).layout, first.layout);
  for (const change of [
    { object: { ...original.object, metadata: { label: "two" } } },
    { object: { ...original.object, groupId: 9 } },
    { object: { ...original.object, orientation: "left" } },
    { initialOpacity: 0 }, { initialPhase: 1 }, { positions: [[1, 1, 2]] }, { block: blocks.get("wall") }
  ]) assert.notEqual(pool.pack(timeline({ ...original, ...change })).layout, first.layout);
  assert.notEqual(pool.pack(timeline({ ...original, object: { ...original.object, metadata: {} } })).layout,
    pool.pack(timeline({ ...original, object: { ...original.object, metadata: [] } })).layout);
  assert.equal(pool.pack(timeline(copy)).layout, first.layout, "resets recover an older interned version");
  const moving = { ...original, changed: true, motion: [{ from: [1,1,0], to: [2,1,0], start: 0, end: 100 }] };
  const a = pool.pack(timeline(moving)), b = pool.pack(timeline({ ...moving, object: structuredClone(moving.object) }));
  assert.equal(a.scene, b.scene);
  assert.equal(a.moving, b.moving, "repeated curves share their storage");
  assert.notEqual(pool.pack(timeline({ ...moving, fades: [{ from: [1], to: [0], start: 0, end: 100 }] })).scene, a.scene);
});

test("gem seeks touch only affected rooms, reverse exactly, and reset for a new movie", () => {
  const source = makeWorld(), world = { ...source, rooms: source.rooms.map(room => ({ ...room })) };
  const gems = [{ id: "0.json:35", at: 100 }, { id: "1.json:35", at: 300 }];
  const ledger = new ReplayGemState(source, world, gems), otherObjects = world.rooms[1].objects;
  assert.equal(ledger.update(50), false);
  assert(ledger.update(100));
  assert.equal(world.rooms[0].objects.length, source.rooms[0].objects.length - 1);
  assert.equal(world.rooms[1].objects, otherObjects);
  const unchanged = world.rooms[0].objects;
  assert.equal(ledger.update(200), false);
  assert.equal(world.rooms[0].objects, unchanged);
  ledger.update(400); ledger.update(200);
  assert.equal(world.rooms[1].objects, otherObjects);
  assert.equal(world.rooms[0].objects, unchanged);
  assert(ledger.reset());
  assert.equal(world.rooms[0].objects, source.rooms[0].objects);
  assert.equal(ledger.update(0), false);
});

test("walking and blocked replay inputs retain the same scenery and player actor", async () => {
  const source = makeWorld();
  source.rooms[0].objects = [...floors, cell("player", 1), cell("wall", 3)];
  const movie = await compileReplay(engine, source, parseReplay("RRRL"));
  assert.equal(new Set(movie.clips.map(clip => clip.layout)).size, 1);
  const renderer = await makeRenderer(source);
  const view = Object.assign(Object.create(ReplayView.prototype), { source, world: source, renderer,
    rooms: new Map(source.rooms.map(room => [room.fileName, room])), context: createPlayWorldContext(source) });
  view.setMovie(movie);
  const scene = view.scene;
  for (const time of [150, 250, 350, 50]) {
    view.show(time);
    assert.equal(view.scene, scene);
    const track = scene.actors[0].tracks[0], pose = sampleTrack(track, time % 100);
    assert.equal(scene.actors[0].root.position.x + scene.actors[0].origin[0], pose.x);
  }
  scene.dispose(); view.sceneCache.clear();
});

test("cached mechanism scenes seek backward without changing geometry, camera pan or Truncate", async () => {
  const source = makeWorld(), world = { ...source, rooms: source.rooms.map(room => ({ ...room })) };
  const movie = await compileReplay(engine, source, parseReplay("R room IxI R room HxI R"));
  const renderer = await makeRenderer(world);
  const view = Object.assign(Object.create(ReplayView.prototype), { source, world, renderer,
    rooms: new Map(world.rooms.map(room => [room.fileName, room])), context: createPlayWorldContext(world) });
  view.setMovie(movie);
  const first = view.scene;
  assert.equal(renderer.content.children.length, 0, "the command scene is the only foreground");
  renderer.target.x += 3;
  const geometry = first.actors.find(actor => actor.morph).root.children.find(part => part.geometry).geometry;
  view.sceneCache.maxEntries = 1;
  view.show(movie.clips[2].start + movie.clips[2].duration / 2);
  view.show(movie.clips[0].duration / 2);
  assert.equal(view.scene, first, "a full cache takes the requested scene before evicting anything");
  view.sceneCache.maxEntries = 32;
  for (const index of [2, 4, 1, 0, 3, 0]) {
    const clip = movie.clips[index];
    view.show(clip.start + clip.duration / 2);
    assert.equal(renderer.target.x - view.lastCamera[0], 3, "pan survives both directions");
    assert.equal(renderer.content.visible, false);
    assert.equal(view.scene.upper.visible, false, "zero-opacity Truncate has no ghost pass");
    for (const actor of view.scene.actors) {
      const pose = sampleTrack(actor.tracks[0], clip.duration / 2);
      assert(Math.abs(actor.root.position.y + actor.origin[2] - pose.z) < 1e-8);
    }
    if (index === 0) {
      assert.equal(view.scene, first);
      assert.equal(first.actors.find(actor => actor.morph).root.children.find(part => part.geometry).geometry, geometry);
    }
  }
  renderer.cutaway.opacity = .25;
  first.beforeRender();
  assert(first.upper.visible, "enabling ghosts synchronizes their current transforms");
  first.rootNodes.forEach((node, index) => assert.deepEqual(first.upperNodes[index].position, node.position));
  const activeChildren = first.root.children.slice();
  view.sceneCache.clear();
  assert.equal(renderer.content.visible, false, "eviction never reveals the active scene's foreground");
  assert.deepEqual(first.root.children, activeChildren);
  view.setMovie(movie);
  assert.equal(first.root.children.length, 0, "replacing a movie frees the active scene too");
  view.scene.dispose(); view.sceneCache.clear();
});

test("scene cache limits retained vertex memory and disposes evicted buffers once", async () => {
  const source = makeWorld(), renderer = await makeRenderer(source);
  const movie = await compileReplay(engine, source, parseReplay("R room HxI"));
  const timeline = unpackTimeline(movie, movie.clips[0], source);
  const cache = new ReplaySceneCache({ maxEntries: 1, maxBytes: Infinity });
  const first = new CommandAnimationScene(renderer, timeline);
  const owned = first.actors.find(actor => actor.morph).root.children.find(part => part.geometry && !part.geometry.userData.persistentGeometry).geometry;
  let disposed = 0; owned.addEventListener("dispose", () => disposed++);
  cache.park(0, first);
  assert.equal(first.root.parent, null);
  assert(cache.bytes > 0);
  const second = new CommandAnimationScene(renderer, timeline);
  cache.park(1, second);
  assert.equal(disposed, 1);
  assert.equal(cache.take(0), null);
  assert.equal(cache.take(1), second);
  assert.equal(cache.bytes, 0);
  second.attach(); second.beforeRender();
  assert.equal(renderer.content.visible, false);
  cache.maxBytes = 1;
  cache.park(1, second);
  assert.equal(cache.entries.size, 0, "oversized scenes are released instead of cached");
  assert.equal(cache.bytes, 0);
  cache.clear();
  assert.equal(disposed, 1);
});
