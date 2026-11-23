import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { RoomLighting } from "../ui/room-lighting.mjs";

const rooms = [0, 1, 2].map(columnIndex => ({ columnIndex, rowIndex: 0 }));
const world = { columns: [0, 1, 2], rows: [0], roomWidth: 16, roomHeight: 16, contextActiveRoom: rooms[0] };

test("room brightness crossfades and retargets in 250 ms without reallocating materials or geometry", () => {
  const lighting = new RoomLighting(world);
  const root = new THREE.Group();
  const source = new THREE.MeshLambertMaterial({ color: "red" });
  const geometry = new THREE.BoxGeometry();
  root.add(new THREE.Mesh(geometry, source), new THREE.Mesh(geometry, source));
  lighting.apply(root);
  const material = root.children[0].material;
  assert.equal(root.children[1].material, material);
  assert.notEqual(material, source);
  lighting.select(rooms[1], 250, 0);
  lighting.update(125);
  assert.deepEqual([...lighting.values], [.5, .5, 0]);
  lighting.select(rooms[2], 250, 125);
  lighting.update(250);
  assert.deepEqual([...lighting.values], [.25, .25, .5]);
  lighting.update(375);
  assert.deepEqual([...lighting.values], [0, 0, 1]);
  lighting.apply(root);
  assert.equal(root.children[0].material, material);
  assert.equal(root.children[0].geometry, geometry);
  assert.equal(material.opacity, 1);
  assert.equal(source.userData.mazeRoomLighting, undefined);

  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  material.onBeforeCompile(shader);
  assert(shader.vertexShader.includes("mazeRoomPosition = (modelMatrix * mazePosition).xz"));
  assert(shader.fragmentShader.includes("outgoingLight *= mix(0.38, 1.0"));
  assert.equal(shader.uniforms.mazeRoomLight.value, lighting.texture);
  lighting.dispose();
  geometry.dispose(); source.dispose();
});
