import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { createCommandTimeline } from "../animations/v1/timeline.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";
import { voxelPieceDefinition } from "../ui/voxel-scene.mjs";
import { V2_BLOCK_CATALOG, V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { addSpecialPiece } from "../render/v1/special-piece-renderers.mjs";
import { disposeGeneratedChildren } from "../render/v1/polycube-mesh.mjs";

test("mechanism tweens and cleanup never invalidate geometry owned by cached rooms", () => {
  const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
  const objects = [
    { blockId: "player", x: 0, y: 0, z: 0 },
    { blockId: "gate", x: 2, y: 0, z: 0, stateId: 0 },
    { blockId: "lift", x: 3, y: 0, z: 0, stateId: 0 },
    { blockId: "lift", x: 5, y: 0, z: 0, stateId: 0, orientation: "east" },
    { blockId: "puncher", x: 7, y: 0, z: 0, stateId: 0, orientation: "right" }
  ];
  const room = { fileName: "A.json", columnIndex: 0, rowIndex: 0, width: 12, height: 4, objects };
  const world = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A"], rows: ["A"],
    roomWidth: 12, roomHeight: 4, blockDefinitions: blocks, rooms: [room] })(room);
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { world, totalWidth: 12, totalHeight: 4, mode: "play", canvas: { dataset: {} },
    target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: null, opacity: 0, followPlayer: false }, yaw: 0 });

  // Populate the same shared assets a background room keeps, in both states.
  const background = new THREE.Group();
  for (const stateId of [0, 1]) for (const source of objects.slice(1)) {
    const object = { ...source, stateId };
    addSpecialPiece(background, { x: object.x, z: object.y, source: { ...object, direction: object.orientation },
      definition: voxelPieceDefinition(object, blocks.get(object.blockId)) }, { totalWidth: 12, totalHeight: 4 });
  }
  const cached = new Map(), disposed = new Set();
  background.traverse(object => {
    const geometry = object.geometry;
    if (!geometry?.userData.persistentGeometry || cached.has(geometry)) return;
    cached.set(geometry, { metadata: { ...geometry.userData }, positions: geometry.attributes.position.array.slice() });
    geometry.addEventListener("dispose", () => disposed.add(geometry));
  });
  assert(cached.size >= 8, "exercise plates, cubes, side lifts, markers and punchers");

  for (const raised of [true, false, true, false]) {
    const start = objects.map(object => ({ ...object, stateId: raised ? 0 : 1 }));
    const end = objects.map(object => ({ ...object, stateId: raised ? 1 : 0 }));
    const state = objects => ({ width: 12, height: 4, objects });
    const timeline = createCommandTimeline({ state: state(start), room, definitions: blocks,
      simulation: { frames: [state(end)], final: state(end) } });
    const animation = new CommandAnimationScene(renderer, timeline);
    for (const time of [0, timeline.duration / 2, timeline.duration, 0]) {
      animation.update(time); animation.beforeRender();
      for (const [geometry, original] of cached) {
        assert.deepEqual(geometry.userData, original.metadata, "a morph clone must own its disposal metadata");
        assert.deepEqual(geometry.attributes.position.array, original.positions, "shared source vertices stay unchanged");
      }
    }
    const owned = new Set();
    animation.root.traverse(object => { if (object.geometry && !object.geometry.userData.persistentGeometry) owned.add(object.geometry); });
    let freed = 0;
    for (const geometry of owned) geometry.addEventListener("dispose", () => freed++);
    animation.dispose();
    assert.equal(disposed.size, 0, "finishing a tween must not delete background room GPU buffers");
    assert.equal(freed, owned.size, "transient tween geometry must still be released");
  }
  disposeGeneratedChildren(background);
  assert.equal(disposed.size, 0);
});
