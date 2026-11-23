import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../render/vendor/three.module.min.js";
import { GLTFLoader } from "../render/vendor/examples/jsm/loaders/GLTFLoader.js";
import { modelSection } from "../ui/model-sections.mjs";
import { ModelTruncateCaps } from "../ui/model-truncate-caps.mjs";
import { BackgroundTruncation } from "../ui/background-truncation.mjs";
import { renderMaterial } from "../render/v1/polycube-mesh.mjs";

function area(section) {
  const p = section.positions;
  let sum = 0;
  for (let i = 0; i < p.length; i += 9) {
    const triangle = ((p[i+5]-p[i+2])*(p[i+6]-p[i])-(p[i+3]-p[i])*(p[i+8]-p[i+2])) / 2;
    assert(triangle >= -1e-8, "every top face points upward");
    sum += triangle;
  }
  return sum;
}

test("model sections fill concave silhouettes and preserve real holes", () => {
  const shape = new THREE.Shape([[0,0],[3,0],[3,1],[1,1],[1,3],[0,3]].map(p => new THREE.Vector2(...p)));
  const hole = new THREE.Path([[.2,.2],[.2,.8],[.8,.8],[.8,.2]].map(p => new THREE.Vector2(...p)));
  shape.holes.push(hole);
  const source = new THREE.ExtrudeGeometry(shape, { depth: 3, bevelEnabled: false }).rotateX(Math.PI / 2);
  const original = source.attributes.position.array.slice(), section = modelSection(source, -1.234);
  assert(Math.abs(area(section) - 4.64) < 1e-5);
  assert.equal(modelSection(source, -1.234), section, "identical model cuts share the computed section");
  assert.deepEqual(source.attributes.position.array, original);
});

test("model instances share fixed caps and moving cuts retain buffers and surface color", () => {
  const root = new THREE.Group(), source = new THREE.BoxGeometry(2, 6, 2), material = renderMaterial("#673487");
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(source, material);
    mesh.userData.truncateModel = true;
    mesh.position.set(i * 10, 3, 0); mesh.rotation.y = i;
    root.add(mesh);
  }
  const caps = new ModelTruncateCaps({}, root);
  caps.update(1);
  const [a, b] = caps.entries;
  assert.equal(a.surface.geometry, b.surface.geometry);
  assert.equal(a.outline.geometry, b.outline.geometry);
  assert(a.surface.geometry.userData.persistentGeometry);
  assert.notEqual(a.surface.material, material);
  assert(a.surface.material.color.equals(material.color));
  assert.equal(a.surface.material.clippingPlanes.length, 0);
  caps.update(1.5);
  const geometry = a.surface.geometry;
  caps.update(2.5);
  assert.equal(a.surface.geometry, geometry, "fractional cuts update a retained buffer");
  assert.equal(a.surface.geometry.drawRange.count, 18);
  assert.equal(a.surface.matrix.elements[13], 3);
  caps.update(null);
  assert(caps.entries.every(entry => !entry.surface.visible && !entry.outline.visible));
  assert.equal(material.clippingPlanes, null);
});

test("background model caps survive clipping without entering the ghost copy", () => {
  const entry = { root: new THREE.Group(), content: new THREE.Group(), cutawayContent: new THREE.Group() };
  entry.root.add(entry.content, entry.cutawayContent);
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), renderMaterial("#765432"));
  model.position.y = 2; model.userData.truncateModel = true; entry.content.add(model);
  const clip = new BackgroundTruncation(); clip.set(1, .2);
  clip.prepare(entry, { rooms: [], blockDefinitions: new Map() }, { totalWidth: 16, totalHeight: 16 }, {});
  clip.update(entry);
  assert.equal(entry.ghostObjects.length, 1);
  assert.equal(entry.modelCaps.entries[0].surface.geometry.drawRange.count, 18);
  assert(entry.modelCaps.entries[0].surface.visible);
  clip.set(2, .2); clip.update(entry, { prepareCaps: false });
  assert.equal(entry.capRoot.visible, false, "stale offscreen caps stay hidden until prepared");
  assert.equal(entry.preparedCapHeight, 1);
  clip.prepareCaps(entry);
  assert.equal(entry.preparedCapHeight, 2);
  assert.equal(entry.capRoot.visible, true);
  clip.set(2, .4); clip.update(entry, { prepareCaps: false });
  assert.equal(entry.capRoot.visible, true, "opacity changes preserve already prepared caps");
  clip.set(null, 0); clip.update(entry);
  assert.equal(entry.modelCaps.entries[0].surface.visible, false);
  clip.disposeEntry(entry); clip.dispose();
});

test("authored trees, shrubs, blocks and gems have valid nonempty sections", async () => {
  const loader = new GLTFLoader();
  for (const name of ["t1", "t2", "t3", "t4", "st1", "st3", "st4", "sh", "b1", "b2", "b3", "b4", "gem"]) {
    const bytes = await readFile(new URL(`../render/v1/assets_3d/${name}.glb`, import.meta.url));
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    gltf.scene.updateMatrixWorld(true);
    let filled = 0;
    gltf.scene.traverse(mesh => {
      if (!mesh.isMesh) return;
      const source = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      source.computeBoundingBox();
      for (const fraction of [.13, .37, .63, .87]) {
        const height = THREE.MathUtils.lerp(source.boundingBox.min.y, source.boundingBox.max.y, fraction);
        const section = modelSection(source, height);
        assert(section.positions.every(Number.isFinite));
        if (area(section) > 0) filled++;
        assert(section.positions.length / 3 <= (source.index?.count ?? source.attributes.position.count));
      }
    });
    assert(filled > 0, `${name} has closed sections`);
  }
});
