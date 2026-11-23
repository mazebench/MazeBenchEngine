import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { createPlayWorldContext, createWorldContext, playRoomCenter } from "../ui/play-world-context.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";

function fixture() {
  const blocks = [
    { id: "floor", roleId: "floor", color: "#d6bd94", visual: { kind: "floor" } },
    { id: "player", roleId: "player", color: "#5aa95c", visual: { kind: "cube" } },
    { id: "wall", roleId: "solid", color: "#23262c", visual: { kind: "cube" } }
  ];
  const world = {
    storageFormat: V2_WORLD_FORMAT,
    columns: Array.from({ length: 16 }, (_, i) => String(i)),
    rows: Array.from({ length: 16 }, (_, i) => String(i)),
    roomWidth: 16, roomHeight: 16, blocks,
    blockDefinitions: new Map(blocks.map(block => [block.id, block])),
    rooms: Array.from({ length: 256 }, (_, i) => ({
      fileName: `${i}.json`, width: 16, height: 16,
      columnIndex: i % 16, rowIndex: Math.floor(i / 16),
      objects: [
        { blockId: "floor", x: 0, y: 0, z: 0 },
        { blockId: "player", x: 0, y: 0, z: 0 },
        { blockId: "wall", x: 1, y: 1, z: 3 }
      ]
    }))
  };
  return { world, context: createPlayWorldContext(world) };
}

// Exercise the real geometry/cache code without a WebGL context.
function rendererFixture(world) {
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, {
    canvas: { dataset: {} }, scene: new THREE.Scene(),
    content: new THREE.Group(), cutawayContent: new THREE.Group(),
    placementPreview: new THREE.Group(), target: new THREE.Vector3(),
    cameraMotion: {}, renderer: { shadowMap: { enabled: true } },
    mode: "play", pickVoxels: false,
    cutaway: { height: null, opacity: 0.2, followPlayer: false },
    render() {}, requestModels() {}
  });
  renderer.setWorld(world, { preserveCamera: true });
  return renderer;
}

test("Play includes every room and only the live player, without mutating authored data", () => {
  const { world, context } = fixture();
  const active = world.rooms[135];
  const frame = context(active, { ...active, objects: [{ blockId: "player", x: 7, y: 6, z: 2 }] });
  assert.equal(frame.rooms.length, 256);
  assert.equal(frame.columns.length, 16);
  assert.equal(frame.rows.length, 16);
  assert.equal(frame.rooms.filter(room => room.renderDimmed).length, 255);
  assert.equal(frame.rooms.flatMap(room => room.objects).filter(object => object.blockId === "player").length, 1);
  assert.equal(frame.rooms[135].objects[0].x, 7);
  assert.equal(world.rooms[135].objects[1].x, 0);
  assert.equal(world.rooms[0].objects.length, 3);
  assert.deepEqual(playRoomCenter(frame), { x: -8, z: 8 });
  assert.deepEqual(playRoomCenter(context(world.rooms[0])), { x: -120, z: -120 });
  assert.deepEqual(playRoomCenter(context(world.rooms[255])), { x: 120, z: 120 });
});

test("engine frames and room changes reuse all 256 background meshes", async () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  await renderer.backgroundReady;
  const original = [...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]);
  const oldActive = renderer.content.children[0].geometry;
  let disposed = false;
  oldActive.addEventListener("dispose", () => { disposed = true; });
  renderer.setWorld(context(world.rooms[135], {
    ...world.rooms[135], objects: [{ blockId: "player", x: 7, y: 6, z: 0 }]
  }), { preserveCamera: true });
  assert.equal(disposed, true);
  assert.deepEqual([...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]), original);
  assert.equal(renderer.roomBackgrounds.get("135.json").root.visible, false);
  assert.equal([...renderer.roomBackgrounds.values()].filter(entry => entry.root.visible).length, 255);

  renderer.target.set(-8, 1.2, 8);
  renderer.cameraMotion.centerAnimation = { startX: -10, targetX: -8, startZ: 6, targetZ: 8 };
  renderer.setWorld(context(world.rooms[255]), { preserveCamera: true });
  assert.deepEqual([...renderer.roomBackgrounds.values()].map(entry => entry.content.children[0]), original);
  assert.equal(renderer.roomBackgrounds.get("135.json").root.visible, true);
  assert.equal(renderer.roomBackgrounds.get("255.json").root.visible, false);
  assert.deepEqual(renderer.target.toArray(), [120, 1.2, 120]);
  assert.deepEqual(renderer.cameraMotion.centerAnimation, { startX: 118, targetX: 120, startZ: 118, targetZ: 120 });
  const distantBounds = new THREE.Box3().setFromObject(renderer.roomBackgrounds.get("0.json").root);
  assert.equal(distantBounds.min.x, -128);
  assert.equal(distantBounds.min.z, -128);
  assert.deepEqual(renderer.zoomLimits(), [7, 1000]);
});

test("human room selection tweens from the displayed camera and retargets an unfinished switch", async () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  await renderer.backgroundReady;
  let scheduled = 0;
  renderer.scheduleCameraFrame = () => scheduled++;
  renderer.target.set(-8, 1.2, 8);
  renderer.setWorld(context(world.rooms[255]), { preserveCamera: true, animateCamera: true });
  assert.deepEqual(renderer.target.toArray(), [-8, 1.2, 8]);
  assert.equal(renderer.cameraMotion.centerAnimation.targetX, 120);
  assert.equal(renderer.cameraMotion.centerAnimation.targetZ, 120);
  renderer.setWorld(context(world.rooms[0]), { preserveCamera: true, animateCamera: true });
  assert.deepEqual(renderer.target.toArray(), [-8, 1.2, 8]);
  assert.equal(renderer.cameraMotion.centerAnimation.targetX, -120);
  assert.equal(renderer.cameraMotion.centerAnimation.targetZ, -120);
  assert.equal(scheduled, 2);
});

test("Truncate and follow-player reuse all background geometry and only update clipping", async () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  await renderer.backgroundReady;
  const before = renderer.roomBackgrounds.get("0.json");
  const geometries = before.content.children.map(child => child.geometry);
  let disposed = false;
  geometries.forEach(geometry => geometry.addEventListener("dispose", () => { disposed = true; }));
  renderer.setCutaway({ followPlayer: true });
  assert.equal(disposed, false);
  assert.equal(renderer.cutawayHeight, 1);
  assert.equal(renderer.roomBackgrounds.get("0.json"), before);
  assert.deepEqual(before.content.children.map(child => child.geometry), geometries);
  assert.equal(renderer.backgroundTruncation.lowerPlane.constant, 0.9995);
  assert(before.ghostObjects.some(object => object.visible));
  renderer.setCutaway({ opacity: 0.5 });
  assert.equal(renderer.roomBackgrounds.get("0.json"), before);
  assert.equal(disposed, false);
  renderer.setWorld(context(world.rooms[135], {
    ...world.rooms[135], objects: [{ blockId: "player", x: 0, y: 0, z: 3 }]
  }), { preserveCamera: true });
  assert.equal(renderer.cutawayHeight, 4);
  assert.equal(renderer.roomBackgrounds.get("0.json"), before);
  assert(!before.ghostObjects.some(object => object.visible));
  assert(before.activeCaps.children.length > 0);
  const cap = before.activeCaps;
  renderer.setCutaway({ height: null, followPlayer: false, opacity: 0 });
  assert.equal(before.activeCaps, null);
  assert.equal(before.cutawayContent.visible, false);
  renderer.setCutaway({ height: 4 });
  assert.equal(before.activeCaps, cap, "revisiting a height reuses its cap geometry");
});

test("editor world changes invalidate only the edited background, without widening picking", async () => {
  const { world } = fixture();
  const context = createWorldContext(world);
  const renderer = rendererFixture(context(world.rooms[135]));
  await renderer.backgroundReady;
  renderer.mode = "editor";
  renderer.pickVoxels = true;
  const original = new Map(renderer.roomBackgrounds);
  world.rooms[135].objects = [...world.rooms[135].objects, { blockId: "wall", x: 3, y: 3, z: 8 }];
  renderer.setWorld(context(world.rooms[135]), { preserveCamera: true });
  assert.equal(renderer.roomBackgrounds.get("135.json"), original.get("135.json"), "hidden background refresh is deferred");
  const records = renderer.pickMeshes.flatMap(mesh => mesh.userData.voxelInstances || []);
  assert(records.length > 0);
  assert(records.every(record => record.room.fileName === "135.json"));
  assert.equal(renderer.cutawayMaxHeight, 9);
  renderer.setWorld(context(world.rooms[255]), { preserveCamera: true });
  assert.notEqual(renderer.roomBackgrounds.get("135.json"), original.get("135.json"));
  for (const [id, entry] of original) {
    const nearEdit = Math.abs(entry.room.columnIndex - 7) + Math.abs(entry.room.rowIndex - 8) <= 1;
    if (!nearEdit) assert.equal(renderer.roomBackgrounds.get(id), entry);
    else assert.notEqual(renderer.roomBackgrounds.get(id), entry, "only the edited room and its shared borders refresh");
  }
  assert.equal(renderer.world.rooms.length, 256);
  assert.equal(renderer.world.rooms[135].objects.length, 4);
});

test("startup presents the active room before backgrounds and preserves live state while they load", async () => {
  const { world } = fixture();
  const context = createWorldContext(world);
  const renderer = rendererFixture(context(world.rooms[135]));
  assert.equal(renderer.roomBackgrounds.size, 0);
  assert(renderer.content.children.length > 0);
  assert.equal(renderer.backgroundJob.rooms[0].fileName, "135.json");
  assert(renderer.backgroundJob.rooms.slice(0, 9).every(room =>
    Math.abs(room.columnIndex - 7) <= 1 && Math.abs(room.rowIndex - 8) <= 1));

  renderer.mode = "editor";
  renderer.pickVoxels = true;
  world.rooms[255].objects = [...world.rooms[255].objects, { blockId: "wall", x: 2, y: 2, z: 5 }];
  renderer.setWorld(context(world.rooms[255]), { preserveCamera: true });
  assert.equal(renderer.backgroundJob.rooms[0].fileName, "255.json");
  renderer.setCutaway({ height: 2, opacity: 0 });
  const foreground = renderer.content.children[0], picks = renderer.pickMeshes, tops = renderer.cellTops;
  await renderer.backgroundReady;
  assert.equal(renderer.roomBackgrounds.size, 256);
  assert.equal(renderer.content.children[0], foreground);
  assert.equal(renderer.pickMeshes, picks);
  assert.equal(renderer.cellTops, tops);
  assert.equal(renderer.canvas.dataset.cutawayHeight, "2");
  assert.equal(renderer.roomBackgrounds.get("255.json").root.visible, false);
  assert.equal(renderer.roomBackgrounds.get("255.json").room.objects.length, 4);
  assert([...renderer.roomBackgrounds.values()].every(entry => entry.cutawayContent.visible === false));
  assert(renderer.pickMeshes.flatMap(mesh => mesh.userData.voxelInstances || []).every(record => record.room.fileName === "255.json"));
});

test("replacing the world cancels unfinished background work", async () => {
  const first = fixture(), second = fixture();
  second.world.rooms = second.world.rooms.slice(0, 2).map(room => ({ ...room, fileName: `new-${room.fileName}` }));
  const renderer = rendererFixture(first.context(first.world.rooms[135]));
  const cancelled = renderer.backgroundReady;
  renderer.setWorld(createWorldContext(second.world)(second.world.rooms[0]), { preserveCamera: true });
  assert.equal(await cancelled, false);
  assert.equal(await renderer.backgroundReady, true);
  assert.deepEqual([...renderer.roomBackgrounds.keys()], ["new-0.json", "new-1.json"]);
});

test("foreground, background and Truncate caps share opaque black outlines in the world pass", async () => {
  const { world, context } = fixture();
  const renderer = rendererFixture(context(world.rooms[135]));
  await renderer.backgroundReady;
  renderer.setCutaway({ height: 4 });
  let count = 0;
  const check = root => root.traverse(object => {
    if (!object.visible || !object.userData.mazeWideOutline || !object.material.userData.mazeOutline) return;
    count++;
    assert.equal(object.material.color.getHex(), 0);
    assert.equal(object.material.opacity, 1);
    assert.equal(object.layers.mask, 1);
  });
  check(renderer.content);
  check(renderer.backgroundRoot);
  assert(count > 256);
  renderer.roomLighting.select(world.rooms[255], 250, 0);
  renderer.roomLighting.update(125);
  check(renderer.content);
  check(renderer.backgroundRoot);
});
