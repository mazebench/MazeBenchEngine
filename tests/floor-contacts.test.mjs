import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { collectVoxelSceneV2, voxelPieceDefinition } from "../ui/voxel-scene.mjs";
import { voxelPieceDefinition as historicalDefinition } from "../render/v1/voxel-scene-v2.mjs";
import { floorFaces, geometryFromFaces } from "../render/v1/polycube-mesh.mjs";
import { contactShape } from "../ui/orange-wall-contacts.mjs";

const floorBlocks = ["floor", "ice-floor", "exit"].map(id => ({
  id, color: "#88bbcc", visual: { kind: id === "exit" ? "exit" : "floor" }
}));
const object = (blockId, x = 0, z = 0) => ({ blockId, x, y: 0, z });
const world = {
  roomWidth: 4, roomHeight: 4,
  blockDefinitions: new Map(floorBlocks.map(block => [block.id, block])),
  rooms: [{ columnIndex: 0, rowIndex: 0, objects: floorBlocks.map((block, x) => object(block.id, x)) }]
};

test("ground floors close the gap below resting blocks without moving elevated solids or frozen observations", () => {
  for (const block of floorBlocks) {
    const definition = voxelPieceDefinition(object(block.id), block);
    assert.equal(definition.top, 0);
    assert.equal(definition.top - definition.bottom, .34375, "slab thickness is preserved");
    assert.equal(historicalDefinition(object(block.id), block).top, -.0625, "signed renderer remains unchanged");
    assert.deepEqual(voxelPieceDefinition(object(block.id, 0, 2), block), historicalDefinition(object(block.id, 0, 2), block));
    const shape = contactShape(object(block.id), block);
    assert.equal(shape.position[1] + shape.size[1], 0, "mechanism contact uses the visible floor");
  }
});

test("floor geometry, editor grid, picking and exit markers share the supporting surface", () => {
  const renderer = { world }, data = collectVoxelSceneV2(renderer);
  for (const group of data.floorGroups.values()) {
    const geometry = geometryFromFaces(floorFaces(group.cells, 0, 0));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld();
    const { x } = group.cells[0];
    const ray = new THREE.Raycaster(new THREE.Vector3(x + .5, 1, .5), new THREE.Vector3(0, -1, 0));
    assert.equal(ray.intersectObject(mesh)[0].point.y, 0, "rendered slab actually touches a resting cube's base");
    assert.equal(data.pickRecords.find(record => record.globalX === x).top, 0);
    assert.equal(data.editorGridCells.find(cell => cell.x === x).top, 0);
    assert.equal(renderer.cellTops.get(`${x},0`), 0);
    geometry.dispose(); mesh.material.dispose();
  }
  const marker = data.specialPieces.find(record => record.definition.kind === "exit_marker");
  assert(Math.abs(marker.definition.bottom - .02) < 1e-10);
  assert(Math.abs(marker.definition.top - .36) < 1e-10);
  const upper = collectVoxelSceneV2({ world }, { minHeight: 0 });
  assert.equal(upper.floorGroups.size, 0, "Truncate's upper copy never duplicates the supporting slab");
});
