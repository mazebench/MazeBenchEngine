import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { BackgroundTruncation, capFacesByHeight } from "../ui/background-truncation.mjs";
import { edgeGeometryFromFaces, renderMaterial } from "../render/v1/polycube-mesh.mjs";

test("cut caps close stacked columns, merge coplanar seams, and preserve material boundaries", () => {
  const data = {
    cubeGroups: new Map([
      ["ice", { color: "#88bbcc", voxels: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }] }],
      ["wall", { color: "#222222", voxels: [{ x: 2, y: 1, z: 0 }] }]
    ]),
    specialPieces: []
  };
  const layers = capFacesByHeight(data, { totalWidth: 16, totalHeight: 16 });
  assert.deepEqual([...layers.keys()], [1, 2]);
  assert.equal(layers.get(1).get("ice").faces.length, 1);
  const ice = layers.get(2).get("ice");
  assert.equal(ice.color, "#88bbcc");
  assert.equal(ice.faces.length, 2);
  assert(ice.faces.every(face => face.normal === "y+" && face.corners.every(point => point[1] === 1.999)));
  const edges = edgeGeometryFromFaces(ice.faces).attributes.position.array;
  for (let i = 0; i < edges.length; i += 6) {
    assert(!(edges[i] === -7 && edges[i + 3] === -7), "the shared edge must be removed");
  }
  assert.equal(layers.get(2).get("wall").faces.length, 1);
});

test("side-lift cut caps retain their mounted plate footprint", () => {
  const data = { cubeGroups: new Map(), specialPieces: [
    { x: 2, z: 3, source: { blockId: "lift" }, definition: {
      kind: "side_lift", color: "#8888cc", orientation: "north", raised: false, bottom: 0, top: 1
    } }
  ] };
  const caps = capFacesByHeight(data, { totalWidth: 16, totalHeight: 16 });
  const face = [...caps.get(1).values()][0].faces[0];
  assert.deepEqual(face.corners.map(point => point[0]), [-6, -6, -5, -5]);
  assert.deepEqual(face.corners.map(point => point[2]), [-4.0625, -4, -4, -4.0625]);
});

test("clipped backgrounds share ghost geometry, isolate materials, and dispose generated resources once", () => {
  const root = new THREE.Group(), content = new THREE.Group(), cutawayContent = new THREE.Group();
  root.add(content, cutawayContent);
  const source = renderMaterial("#88bbcc", true);
  const geometry = new THREE.BoxGeometry(1, 3, 1);
  const mesh = new THREE.Mesh(geometry, source);
  mesh.position.y = 1.5;
  content.add(mesh);
  const entry = { root, content, cutawayContent };
  const clip = new BackgroundTruncation();
  clip.set(1, 0);
  clip.prepare(entry, { rooms: [], blockDefinitions: new Map() }, { totalWidth: 16, totalHeight: 16 });
  clip.update(entry);
  assert.notEqual(mesh.material, source);
  assert.equal(source.clippingPlanes, null);
  assert.equal(entry.ghostObjects, undefined);
  clip.set(1, 0.2);
  clip.update(entry);
  const ghost = entry.ghostObjects[0];
  assert.equal(ghost.geometry, geometry);
  assert.equal(ghost.material.opacity, 0.2);
  assert.equal(ghost.material.depthWrite, false);
  assert.equal(source.opacity, 1);
  clip.set(2, 0.6);
  clip.update(entry);
  assert.equal(entry.ghostObjects[0], ghost);
  assert.equal(ghost.material.opacity, 0.6);
  clip.set(null, 0.6);
  clip.update(entry);
  assert.equal(cutawayContent.visible, false);
  assert.equal(mesh.visible, true);
  let geometryDisposals = 0, sourceDisposals = 0, copyDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  source.addEventListener("dispose", () => sourceDisposals++);
  mesh.material.addEventListener("dispose", () => copyDisposals++);
  ghost.material.addEventListener("dispose", () => copyDisposals++);
  clip.disposeEntry(entry);
  clip.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(sourceDisposals, 0);
  assert.equal(copyDisposals, 2);
});
