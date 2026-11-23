import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../render/vendor/three.module.min.js";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { ThickEdges, OUTLINE_WIDTH_PX, OUTLINE_REFERENCE_DEPTH, OUTLINE_MAX_SCALE } from "../ui/thick-edges.mjs";

test("active and dimmed outlines share depth-scaled black strokes in a single pass", () => {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0], 3));
  for (const material of [edgeMaterial(), edgeMaterial(0x111820,.58)]) root.add(new THREE.LineSegments(geometry.clone(), material));
  const edges = new ThickEdges(); edges.apply(root);
  assert.equal(OUTLINE_WIDTH_PX, 3);
  for (const mesh of root.children) {
    assert(mesh.isMesh && mesh.userData.mazeWideOutline);
    assert.equal(mesh.material.color.getHex(), 0);
    assert.equal(mesh.material.opacity, 1);
    assert.equal(mesh.layers.mask, 1);
    assert.equal(mesh.geometry.attributes.position.count, 6);
    assert.equal(mesh.geometry.attributes.lineOther.count, 6);
    assert.deepEqual([...mesh.geometry.attributes.lineEnd.array], [0, 1, 0, 0, 1, 1]);
    assert.equal(mesh.material.forceSinglePass, true);
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.basic.vertexShader, fragmentShader: THREE.ShaderLib.basic.fragmentShader };
    mesh.material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.mazeLineWidth.value, 3);
    assert.equal(shader.uniforms.mazeLineMaxScale.value * OUTLINE_WIDTH_PX, 6);
    assert.equal(OUTLINE_MAX_SCALE, 2);
    assert.equal(shader.uniforms.mazeLineReferenceDepth.value, OUTLINE_REFERENCE_DEPTH);
    assert(shader.vertexShader.includes("mazeLineReferenceDepth / depth"));
    assert(shader.fragmentShader.includes("diffuseColor.a *= min(width, 1.0) * coverage"));
  }
  const before = [...root.children]; edges.apply(root);
  assert.deepEqual(root.children, before);
});
