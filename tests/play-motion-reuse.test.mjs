import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";
import { V2_BLOCK_CATALOG, V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { createCommandTimeline } from "../animations/v1/timeline.mjs";
import { PlayerMotionScene } from "../animations/v1/player-scene.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { cutSectionFaces } from "../animations/v1/truncate-caps.mjs";
import { joinedEdgePositions } from "../ui/joined-voxel-surface.mjs";
import { worldContactShapes } from "../ui/orange-wall-contacts.mjs";

test("walking, reverse seeking and undo retain scenery; changed mechanisms rebuild", async () => {
  const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
  const objects = [{ blockId: "player", x: 1, y: 1, z: 0 }, { blockId: "wall", x: 3, y: 1, z: 0 },
    { blockId: "lift", x: 5, y: 1, z: 0, stateId: 0 }];
  const room = { fileName: "A.json", columnIndex: 0, rowIndex: 0, width: 8, height: 4, objects };
  const context = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A"], rows: ["A"],
    roomWidth: 8, roomHeight: 4, blockDefinitions: blocks, rooms: [room] });
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { canvas: { dataset: {} }, mode: "play", pickVoxels: false,
    scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(), placementPreview: new THREE.Group(),
    target: new THREE.Vector3(), cameraMotion: {}, renderer: { shadowMap: { enabled: false } },
    cutaway: { height: 1, opacity: 0, followPlayer: true }, render() {}, requestModels() {}, yaw: 0 });
  renderer.setWorld(context(room), { preserveCamera: true });
  await renderer.backgroundReady;
  const scenery = renderer.content.children.slice(), player = renderer.playPlayerRoot;
  const end = objects.map(object => object.blockId === "player" ? { ...object, x: 2 } : object);
  const state = objects => ({ width: 8, height: 4, objects });
  const timeline = createCommandTimeline({ state: state(objects), room, definitions: blocks,
    simulation: { frames: [state(end)], final: state(end) } });
  assert(PlayerMotionScene.supports(renderer, timeline));
  const animation = new PlayerMotionScene(renderer, timeline);
  animation.update(50);
  assert.equal(player.position.x, .5);
  animation.update(0);
  assert.equal(player.position.x, 0);
  animation.update(100); animation.dispose();
  renderer.setWorld(context(room, { ...room, objects: end }), { preserveCamera: true });
  assert.deepEqual(renderer.content.children, scenery);
  assert.equal(player.position.x, 1);
  assert.equal(renderer.cellTops.get("2,1"), 1);
  renderer.setWorld(context(room), { preserveCamera: true });
  assert.equal(renderer.playPlayerRoot, player);
  assert.equal(player.position.x, 0);
  const abort = new PlayerMotionScene(renderer, timeline);
  abort.update(50); abort.dispose({ restoreCamera: true });
  assert.equal(player.position.x, 0, "interrupting the first move restores the current pose");
  const interrupted = new PlayerMotionScene(renderer, timeline);
  interrupted.update(50);
  renderer.setCutaway({ height: 2, followPlayer: false });
  interrupted.beforeRender();
  assert.notEqual(renderer.playPlayerRoot, player);
  assert.equal(renderer.playPlayerRoot.position.x, .5, "changing Truncate during a move preserves its pose");
  interrupted.dispose({ restoreCamera: true });
  assert.equal(renderer.playPlayerRoot.position.x, 0);
  const raised = objects.map(object => object.blockId === "lift" ? { ...object, stateId: 1 } : object);
  renderer.setWorld(context(room, { ...room, objects: raised }), { preserveCamera: true });
  assert.notEqual(renderer.playPlayerRoot, interrupted.root, "mechanism changes take the full rendering path");
  const scene = new CommandAnimationScene(renderer, timeline);
  const retained = []; scene.root.traverse(object => { if (object.geometry) retained.push(object.geometry); });
  const further = end.map(object => object.blockId === "player" ? { ...object, x: 4 } : object);
  const later = createCommandTimeline({ state: state(end), room, definitions: blocks,
    simulation: { frames: [state(further)], final: state(further) } });
  assert(scene.retargetPlayer(later));
  scene.update(later.duration); scene.beforeRender();
  assert.equal(scene.actors[0].root.position.x, 3, "a reused replay actor keeps its original geometry origin");
  assert(scene.retargetPlayer(timeline));
  scene.update(50); scene.beforeRender();
  assert.equal(scene.actors[0].root.position.x, .5, "backward seeking samples the replacement curve");
  const after = []; scene.root.traverse(object => { if (object.geometry) after.push(object.geometry); });
  assert.deepEqual(after, retained, "replay seeks retain geometry and GPU buffers");
  scene.dispose();
});

test("cut sections fill stacks, join adjacent tiles, exclude the next layer and follow ramps", () => {
  const shapes = [{ position: [0,0,0] }, { position: [1,0,0] }, { position: [0,1,0] }];
  const faces = cutSectionFaces(shapes, 1);
  assert.equal(faces.length, 2, "only the visible layer contributes a cap");
  const edges = joinedEdgePositions(faces);
  for (let i = 0; i < edges.length; i += 6) {
    assert(!(edges[i] === 1 && edges[i + 3] === 1), "no internal tile line");
  }
  const halfway = cutSectionFaces(shapes, 1.5);
  assert.equal(halfway.length, 1);
  assert(halfway[0].corners.every(point => point[1] === 1.499));
  for (const direction of ["left", "right", "up", "down"]) {
    const [face] = cutSectionFaces([{ position: [0,0,0], direction }], .5);
    const xs = face.corners.map(p => p[0]), zs = face.corners.map(p => p[2]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
    assert(Math.abs(area - .501) < 1e-8, `${direction} ramp has the actual partial cross section`);
  }
});

test("hidden upper-layer bodies cannot contribute orange-wall contact outlines", () => {
  const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
  const world = { roomWidth: 8, roomHeight: 8, blockDefinitions: blocks, rooms: [{ columnIndex: 0, rowIndex: 0, objects: [
    { blockId: "orange-wall", x: 0, y: 0, z: 0 }, { blockId: "orange-wall", x: 0, y: 0, z: 1 },
    { blockId: "weightless-box", x: 0, y: 0, z: 1 }, { blockId: "floor", x: 0, y: 0, z: 0 }
  ] }] };
  const clipped = worldContactShapes(world, 1);
  assert.equal(clipped.walls.length, 1);
  assert.equal(clipped.supports.length, 1);
  assert.equal(clipped.supports[0].position[1], -22 / 64, "the supporting floor remains");
});

test("room crossings reuse cached scenery and restore camera and lighting when interrupted", async () => {
  const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
  const floors = Array.from({ length: 16 }, (_, i) => ({ blockId: "floor", x: i % 4, y: Math.floor(i / 4), z: 0 }));
  const player = { blockId: "player", x: 3, y: 1, z: 0 };
  const rooms = [0,1].map(columnIndex => ({ fileName: `${columnIndex}.json`, columnIndex, rowIndex: 0,
    width: 4, height: 4, objects: columnIndex ? floors : [...floors, player] }));
  const context = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: [0,1], rows: [0],
    roomWidth: 4, roomHeight: 4, blockDefinitions: blocks, rooms });
  const renderer = Object.assign(Object.create(PlayWorldRenderer.prototype), {
    canvas: { dataset: {} }, mode: "play", pickVoxels: false, scene: new THREE.Scene(), content: new THREE.Group(),
    cutawayContent: new THREE.Group(), placementPreview: new THREE.Group(), target: new THREE.Vector3(), cameraMotion: {},
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: 1, opacity: 0, followPlayer: true },
    render() {}, requestModels() {}, yaw: 0
  });
  renderer.setWorld(context(rooms[0]), { preserveCamera: true }); await renderer.backgroundReady;
  const initial = { width: 8, height: 4, objects: rooms.flatMap(room => room.objects.map(o => ({ ...o, x: o.x + room.columnIndex * 4 }))) };
  const final = { ...initial, objects: initial.objects.map(o => o.blockId === "player" ? { ...o, x: 4 } : o) };
  const timeline = createCommandTimeline({ state: { ...initial, width: 4 }, room: rooms[0], definitions: blocks,
    simulation: { frames: [final], final, room: rooms[1], animationFrames: [{ state: final, room: rooms[1] }],
      presentation: { initial, frames: [final], rooms, originX: 0, originY: 0 } } });
  assert(PlayerMotionScene.supports(renderer, timeline));
  const scenery = renderer.content.children.slice(), neighbor = renderer.roomBackgrounds.get(rooms[1].fileName).root;
  const start = renderer.target.clone();
  const animation = new PlayerMotionScene(renderer, timeline);
  animation.update(125);
  assert.equal(renderer.target.x, start.x + 2);
  assert.deepEqual([...renderer.roomLighting.values], [.5,.5]);
  assert.deepEqual(renderer.content.children, scenery);
  assert(neighbor.visible);
  animation.dispose({ restoreCamera: true });
  assert.equal(renderer.target.x, start.x);
  assert.deepEqual([...renderer.roomLighting.values], [1,0]);
  assert.equal(renderer.playPlayerRoot.position.x, 0);
  const full = new CommandAnimationScene(renderer, timeline, { reuseBackgrounds: true });
  full.update(125); full.beforeRender();
  assert.deepEqual([...full.roomIds], [rooms[0].fileName], "an unchanged destination keeps its cached meshes even on the full animation path");
  assert(neighbor.visible);
  full.dispose({ restoreCamera: true });
  // The origin's static seam may contain floor edges, but never the player's top/sides.
  const borders = renderer.content.children.filter(object => object.userData.roomBorderEdges);
  for (const border of borders) {
    const p = border.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) assert(p.getY(i) <= 0);
  }
});
