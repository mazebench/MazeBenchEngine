import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { applyCutawayMaterials, cutawayMaxHeight, normalizeCutaway, playerCutawayHeight, stepCutawayHeight } from "../render/v1/cutaway.mjs";
import { collectVoxelSceneV2 } from "../render/v1/voxel-scene-v2.mjs";
import { disposeGeneratedChildren, renderMaterial, voxelFaces } from "../render/v1/polycube-mesh.mjs";
import { ThreeMazeRendererV1 } from "../render/v1/three-renderer.mjs";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { cutGeometryAtPlane } from "../render/v1/cutaway-geometry.mjs";

function fixture() {
  const blocks = [
    { id: "floor", color: "#d6bd94", visual: { kind: "floor" } },
    { id: "wall", color: "#343434", visual: { kind: "cube" } },
    { id: "tower", color: "#bbaacc", visual: { kind: "model", height: 6 } }
  ];
  const room = {
    fileName: "mountain.json", columnIndex: 0, rowIndex: 0, width: 3, height: 3,
    objects: [
      { x: 0, y: 0, z: 0, blockId: "floor" },
      ...Array.from({ length: 5 }, (_, z) => ({ x: 0, y: 0, z, blockId: "wall" })),
      { x: 1, y: 0, z: 0, blockId: "tower" }
    ]
  };
  return {
    storageFormat: V2_WORLD_FORMAT, roomWidth: 3, roomHeight: 3, rooms: [room],
    blocks, blockDefinitions: new Map(blocks.map(block => [block.id, block]))
  };
}

test("cutaway exposes mountain interiors without changing authored objects", () => {
  const world = fixture();
  const before = structuredClone(world.rooms);
  const renderer = { world };
  const scene = collectVoxelSceneV2(renderer, { maxHeight: 2 });
  const wallGroup = [...scene.cubeGroups.values()].find(group => group.color === "#343434");
  assert.deepEqual(wallGroup.voxels.map(voxel => voxel.y), [0, 1]);
  assert.equal(scene.pickRecords.filter(record => record.block.id === "wall").length, 2);
  assert.equal(scene.pickRecords.every(record => record.top <= 2), true);
  assert.equal(scene.floorGroups.size, 1);
  assert.equal(renderer.cellTops.get("0,0"), 2);
  const faces = voxelFaces(wallGroup.voxels, scene.occupied, 1.5, 1.5);
  assert.equal(faces.some(face => face.normal === "y+" && face.corners.every(corner => corner[1] === 2)), true);
  assert.deepEqual(world.rooms, before);
  assert.equal(collectVoxelSceneV2({ world }).pickRecords.length, 7);
});

test("partially cut tall assets pick their exposed surface, not the hidden top", () => {
  const world = fixture();
  const scene = collectVoxelSceneV2({ world }, { maxHeight: 2 });
  const tower = scene.pickRecords.find(record => record.block.id === "tower");
  const hit = ThreeMazeRendererV1.prototype.voxelHit(tower, {
    face: { normal: new THREE.Vector3(0, 1, 0) }, point: new THREE.Vector3(0, 2, 0)
  });
  assert.equal(tower.height, 2);
  assert.equal(hit.sourceZ, 1);
  assert.equal(hit.paintZ, 2);
});

test("upper-layer geometry is separate from exposed solid layers and neighbors stay unpickable", () => {
  const world = fixture();
  world.rooms.push({ ...world.rooms[0], columnIndex: 1, renderDimmed: true });
  const solid = collectVoxelSceneV2({ world }, { maxHeight: 2 });
  const upper = collectVoxelSceneV2({ world }, { minHeight: 2 });
  assert.equal([...solid.cubeGroups.values()].every(group => group.voxels.every(voxel => voxel.y < 2)), true);
  assert.equal([...upper.cubeGroups.values()].every(group => group.voxels.every(voxel => voxel.y >= 2)), true);
  assert.equal(solid.pickRecords.every(record => !record.room.renderDimmed), true);
  assert.equal(solid.occupied.has("0,0,2"), false);
  assert.equal(upper.occupied.has("0,0,2"), true);
  assert.equal(upper.floorGroups.size, 0);
});

test("ghost opacity and clipping do not mutate cached materials or cast opaque shadows", () => {
  const root = new THREE.Group();
  const original = renderMaterial("#bbaacc");
  const first = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), original);
  const second = new THREE.Mesh(new THREE.BoxGeometry(1, 6, 1), original);
  first.position.y = second.position.y = 3;
  first.castShadow = second.castShadow = true;
  root.add(first, second);
  applyCutawayMaterials(root, { height: 2, upper: true, opacity: 0.2 });
  assert.notEqual(first.material, original);
  assert.equal(first.material, second.material);
  assert.equal(first.material.opacity, 0.2);
  assert.equal(first.material.depthWrite, false);
  assert.equal(first.castShadow, false);
  assert.equal(first.material.clippingPlanes, null);
  assert.ok(Math.abs(first.geometry.boundingBox.min.y + first.position.y - 2.002) < 1e-6);
  assert.equal(original.opacity, 1);
  assert.equal(original.clippingPlanes, null);
  let disposals = 0;
  first.material.addEventListener("dispose", () => { disposals += 1; });
  disposeGeneratedChildren(root);
  assert.equal(disposals, 1);
  assert.equal(root.children.length, 0);
  assert.equal(root.userData.cutawayMaterials, undefined);
});

test("cutaway bounds include tall assets and full view follows newly raised objects", () => {
  const world = fixture();
  assert.equal(cutawayMaxHeight(world), 6);
  const full = normalizeCutaway();
  world.rooms[0].objects.push({ x: 0, y: 0, z: 9, blockId: "wall" });
  assert.equal(cutawayMaxHeight(world), 10);
  assert.equal(full.height, null);
  assert.deepEqual(normalizeCutaway({ height: 2.3, opacity: 2 }), { height: 2, opacity: 1, followPlayer: false });
});

test("automatic cutaway follows the active player and ignores clones and neighboring players", () => {
  const world = fixture();
  world.blockDefinitions.set("player", { id: "player", roleId: "player", visual: { kind: "cube" } });
  world.blockDefinitions.set("clone", { id: "clone", roleId: "clone", visual: { kind: "cube" } });
  const room = world.rooms[0];
  const player = { x: 2, y: 1, z: 2, blockId: "player" };
  room.objects.push({ x: 1, y: 1, z: 9, blockId: "clone" }, player);
  world.rooms.unshift({ ...room, fileName: "neighbor.json", renderDimmed: true,
    objects: [{ x: 1, y: 1, z: 8, blockId: "player" }] });
  world.contextActiveRoom = { fileName: room.fileName };
  const before = structuredClone(world.rooms);
  assert.equal(playerCutawayHeight(world), 3);
  assert.deepEqual(world.rooms, before);
  player.z = 0;
  assert.equal(playerCutawayHeight(world), 1);
  player.z = 5;
  assert.equal(playerCutawayHeight(world), 6);
  room.objects = room.objects.filter(object => object !== player);
  assert.equal(playerCutawayHeight(world), null);
});

test("automatic height tracks rendered frames and preserves the manual ceiling when disabled", () => {
  const world = fixture();
  world.blockDefinitions.set("player", { roleId: "player" });
  world.rooms[0].objects.push({ x: 2, y: 1, z: 1, blockId: "player" });
  const renderer = Object.create(ThreeMazeRendererV1.prototype);
  renderer.world = world;
  renderer.cutaway = normalizeCutaway({ height: 4, followPlayer: true });
  assert.equal(renderer.cutawayHeight, 2);
  const nextFrame = structuredClone(world);
  nextFrame.rooms[0].objects.at(-1).z = 3;
  renderer.world = nextFrame;
  assert.equal(renderer.cutawayHeight, 4);
  renderer.world = world;
  assert.equal(renderer.cutawayHeight, 2);
  renderer.cutaway.followPlayer = false;
  assert.equal(renderer.cutawayHeight, 4);
  renderer.cutaway.height = null;
  assert.equal(renderer.cutawayHeight, null);
});

test("cutaway keyboard steps raise and lower one layer and respect full/minimum bounds", () => {
  assert.equal(stepCutawayHeight(null, 6, -1), 5);
  assert.equal(stepCutawayHeight(null, 6, 1), null);
  assert.equal(stepCutawayHeight(5, 6, 1), null);
  assert.equal(stepCutawayHeight(3, 6, 1), 4);
  assert.equal(stepCutawayHeight(3, 6, -1), 2);
  assert.equal(stepCutawayHeight(1, 6, -1), 1);
  assert.equal(stepCutawayHeight(null, 1, -1), null);
  assert.equal(stepCutawayHeight(8, 3, -1), 2);
});

test("Solutions can pick exposed voxels while keeping Play's translucent upper layers", () => {
  const renderer = Object.assign(Object.create(ThreeMazeRendererV1.prototype), {
    world: fixture(), mode: "play", pickVoxels: true,
    cutaway: normalizeCutaway({ height: 2, opacity: 0.2 }),
    content: new THREE.Group(), cutawayContent: new THREE.Group(),
    canvas: { dataset: {} }, renderer: { shadowMap: { enabled: false } },
    totalWidth: 3, totalHeight: 3, render() {}
  });
  renderer.rebuild();
  assert.equal(renderer.mode, "play");
  assert.equal(renderer.pickMeshes.length, 1);
  assert(renderer.pickMeshes[0].userData.voxelInstances.every(record => record.top <= 2));
  const upperMesh = renderer.cutawayContent.children.find(child => child.isMesh);
  assert(upperMesh);
  assert.equal(upperMesh.material.opacity, 0.2);
  assert.equal(renderer.cutawayContent.children.some(child => child.userData.voxelInstances), false);
  disposeGeneratedChildren(renderer.content);
  disposeGeneratedChildren(renderer.cutawayContent);
});

test("generated cut surfaces keep their ordinary materials; spanning assets are cut geometrically", () => {
  const root = new THREE.Group();
  const original = renderMaterial("#343434");
  const surface = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const asset = new THREE.Mesh(new THREE.BoxGeometry(), original);
  asset.userData.cutawayClip = true;
  root.add(surface, asset);
  applyCutawayMaterials(root, { height: 2, clip: false });
  assert.equal(surface.material, original);
  assert.equal(asset.material, original);
  assert.notEqual(asset.geometry, surface.geometry);
  assert.equal(asset.material.clippingPlanes, null);
  disposeGeneratedChildren(root);
});

test("cut triangles retain UVs, normals and material groups without altering the source", () => {
  const source = new THREE.BoxGeometry(2, 6, 2);
  const originalPositions = source.attributes.position.array.slice();
  const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1);
  const clipped = cutGeometryAtPlane(source, plane);
  assert.equal(clipped.boundingBox.min.y, -3);
  assert.equal(clipped.boundingBox.max.y, 1);
  assert.equal(clipped.attributes.uv.count, clipped.attributes.position.count);
  assert.equal(clipped.attributes.normal.count, clipped.attributes.position.count);
  assert.equal(clipped.groups.length, source.groups.length);
  assert.deepEqual(source.attributes.position.array, originalPositions);
  assert.equal(cutGeometryAtPlane(source, plane), clipped);
  assert.equal(clipped.userData.persistentGeometry, true);
});

test("cutting a transformed model uses the world's ceiling, including scaled geometry", () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), renderMaterial("#bbaacc"));
  mesh.position.y = 2;
  mesh.scale.y = 2;
  root.add(mesh);
  applyCutawayMaterials(root, { height: 3 });
  assert.equal(mesh.geometry.boundingBox.max.y * mesh.scale.y + mesh.position.y, 3);
  assert.equal(mesh.material.clippingPlanes, null);
  disposeGeneratedChildren(root);
});

test("cutaway releases replaced temporary materials and keeps ghost outlines quiet", () => {
  const root = new THREE.Group();
  const original = new THREE.LineBasicMaterial();
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), original);
  line.userData.transientMaterial = true;
  let originalDisposals = 0;
  original.addEventListener("dispose", () => { originalDisposals += 1; });
  root.add(line);
  applyCutawayMaterials(root, { height: 2, upper: true, opacity: 0.2, clip: false });
  assert.equal(line.visible, false);
  assert.equal(originalDisposals, 1);
  let copyDisposals = 0;
  line.material.addEventListener("dispose", () => { copyDisposals += 1; });
  disposeGeneratedChildren(root);
  assert.equal(copyDisposals, 1);
});
