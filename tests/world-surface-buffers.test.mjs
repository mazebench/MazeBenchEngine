import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { JoinedMazeRenderer } from "../ui/joined-maze-renderer.mjs";
import { prepareWorldSurfaces } from "../ui/prepared-world-surfaces.mjs";

function fixture() {
  const blocks = [
    { id: "floor", color: "#d6bd94", visual: { kind: "floor" } },
    { id: "ice-block", color: "#88bbcc", visual: { kind: "cube" } },
    { id: "ice-slope", color: "#88bbcc", visual: { kind: "slope" } },
    { id: "wall", color: "#222222", visual: { kind: "cube" } }
  ];
  const room = { fileName: "left", columnIndex: 0, rowIndex: 0, objects: [
    { blockId: "floor", x: 0, y: 0, z: 0 },
    { blockId: "ice-block", x: 1, y: 0, z: 0 },
    { blockId: "ice-slope", x: 1, y: 0, z: 1, orientation: "right" },
    { blockId: "wall", x: 0, y: 1, z: 0 }
  ] };
  return { storageFormat: V2_WORLD_FORMAT, columns: ["A", "B"], rows: ["A"], roomWidth: 2, roomHeight: 2,
    blocks, blockDefinitions: new Map(blocks.map(block => [block.id, block])), rooms: [room,
      { ...room, fileName: "right", columnIndex: 1, objects: [
        { blockId: "floor", x: 0, y: 0, z: 0 },
        { blockId: "ice-block", x: 0, y: 0, z: 0 },
        { blockId: "ice-block", x: 0, y: 0, z: 1 },
        { blockId: "ice-slope", x: 0, y: 0, z: 2, orientation: "right" },
        { blockId: "wall", x: 0, y: 1, z: 0 }
      ] }
    ] };
}

function render(world) {
  const renderer = Object.assign(Object.create(JoinedMazeRenderer.prototype), {
    world, mode: "world", pickVoxels: false, cutaway: { height: null, opacity: 0, followPlayer: false },
    content: new THREE.Group(), cutawayContent: new THREE.Group(), canvas: { dataset: {} },
    renderer: { shadowMap: { enabled: false } }, totalWidth: 4, totalHeight: 2, render() {}
  });
  renderer.rebuild();
  return renderer.content.children.map(object => ({
    type: object.type, positions: [...object.geometry.attributes.position.array],
    normals: object.geometry.attributes.normal ? [...object.geometry.attributes.normal.array] : null,
    color: object.material.color.getHex(), shadow: object.castShadow, receive: object.receiveShadow,
    depthOffset: [object.material.polygonOffset, object.material.polygonOffsetFactor, object.material.polygonOffsetUnits],
    order: object.renderOrder, joined: object.userData.joinedSlopes
  }));
}

test("prepared world buffers exactly match ordinary geometry, including slopes crossing a room seam", async () => {
  const world = fixture();
  const original = render(world), progress = [];
  await prepareWorldSurfaces(world, (complete, total) => progress.push([complete, total]));
  assert.deepEqual(render(world), original);
  assert(progress.length > 1);
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  assert(progress.every(([complete, total], index) => complete <= total && (!index || complete >= progress[index - 1][0])));
});

test("lowered orange surfaces stay joined and win floor depth ties in ordinary and prepared worlds", async () => {
  const world = fixture();
  const orange = { id: "orange-wall", roleId: "orange-wall", color: "#b85f16", visual: { kind: "cube" } };
  world.blocks.push(orange); world.blockDefinitions.set(orange.id, orange);
  for (const room of world.rooms) room.objects = [0, 1].flatMap(x => [
    { blockId: "floor", x, y: 0, z: 0 }, { blockId: "orange-wall", x, y: 0, z: -1 }
  ]);
  const original = render(world), meshes = original.filter(object => object.type === "Mesh");
  assert.equal(meshes.filter(object => object.color === 0xb85f16).length, 1, "one orange surface across the seam");
  assert.deepEqual(meshes.find(object => object.color === 0xb85f16).depthOffset, [true, -1, -1]);
  assert.deepEqual(meshes.find(object => object.color === 0xd6bd94).depthOffset, [false, 0, 0]);
  await prepareWorldSurfaces(world);
  assert.deepEqual(render(world), original, "worker-prepared surfaces keep the same geometry and depth priority");
});
