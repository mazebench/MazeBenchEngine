import * as THREE from "../render/vendor/three.module.min.js";
import { edgeMaterial, persistentGeometry } from "../render/v1/polycube-mesh.mjs";
import { ThickEdges } from "./thick-edges.mjs";
import { modelSection } from "./model-sections.mjs";

const emptyGeometry = new THREE.BufferGeometry();
emptyGeometry.userData.persistentGeometry = true;
const fixedSections = new WeakMap();

function geometry(capacity, outline = false) {
  const result = new THREE.BufferGeometry();
  for (const name of outline ? ["position", "lineOther"] : ["position", "normal"]) {
    result.setAttribute(name, new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  if (outline) {
    const sides = new Float32Array(capacity), ends = new Float32Array(capacity);
    for (let i = 0; i < capacity; i += 6) { sides.set([-1,1,1,1,1,-1], i); ends.set([0,1,0,0,1,1], i); }
    result.setAttribute("lineSide", new THREE.BufferAttribute(sides, 1));
    result.setAttribute("lineEnd", new THREE.BufferAttribute(ends, 1));
  } else for (let i = 1; i < capacity * 3; i += 3) result.attributes.normal.array[i] = 1;
  result.setDrawRange(0, 0);
  return result;
}

function fill(surface, outline, section) {
  surface.attributes.position.array.set(section.positions);
  surface.setDrawRange(0, section.positions.length / 3);
  let index = 0;
  for (let i = 0; i < section.edges.length; i += 6) for (const end of [0,1,0,0,1,1]) {
    outline.attributes.position.array.set(section.edges.subarray(i + end * 3, i + end * 3 + 3), index * 3);
    outline.attributes.lineOther.array.set(section.edges.subarray(i + (1-end) * 3, i + (1-end) * 3 + 3), index++ * 3);
  }
  outline.setDrawRange(0, index);
  for (const buffer of [surface, outline]) {
    for (const name of ["position", "lineOther"]) {
      const attribute = buffer.attributes[name];
      if (!attribute) continue;
      attribute.clearUpdateRanges();
      if (buffer.drawRange.count) attribute.addUpdateRange(0, buffer.drawRange.count * 3);
      attribute.needsUpdate = true;
    }
    buffer.computeBoundingSphere();
  }
}

function fixedSection(source, height) {
  let cache = fixedSections.get(source);
  if (!cache) fixedSections.set(source, cache = new Map());
  const key = height.toFixed(6);
  if (!cache.has(key)) {
    const section = modelSection(source, height);
    const surface = persistentGeometry(geometry(section.positions.length / 3));
    const outline = persistentGeometry(geometry(section.edges.length, true));
    fill(surface, outline, section);
    cache.set(key, { surface, outline });
  }
  return cache.get(key);
}

export class ModelTruncateCaps {
  constructor(renderer, sourceRoot, target = sourceRoot, { dynamic = false } = {}) {
    this.target = target;
    this.inverse = new THREE.Matrix4();
    const sources = [];
    sourceRoot.traverse(object => { if (object.userData.truncateModel) sources.push(object); });
    this.entries = sources.map(source => {
      const original = source.geometry, count = original.index?.count ?? original.attributes.position.count;
      if (!original.boundingBox) original.computeBoundingBox();
      renderer.thickEdges ||= new ThickEdges();
      const material = source.material.clone();
      material.onBeforeCompile = source.material.onBeforeCompile;
      material.customProgramCacheKey = source.material.customProgramCacheKey;
      material.clippingPlanes = [];
      const surface = new THREE.Mesh(emptyGeometry, material);
      surface.receiveShadow = true;
      const outline = new THREE.Mesh(emptyGeometry, renderer.thickEdges.material(edgeMaterial()));
      outline.userData.mazeWideOutline = true;
      outline.renderOrder = 10;
      for (const mesh of [surface, outline]) {
        mesh.userData.truncateCap = mesh.userData.modelTruncateCap = mesh.userData.transientMaterial = true;
        mesh.visible = false;
        mesh.matrixAutoUpdate = false;
        target.add(mesh);
      }
      let moving = dynamic;
      for (let parent = source; parent; parent = parent.parent) moving ||= Boolean(parent.userData.gemMotion);
      return { source, original, surface, outline, capacity: count, moving };
    });
  }

  update(height) {
    if (!this.entries.length) return;
    this.target.updateWorldMatrix(true, false);
    this.inverse.copy(this.target.matrixWorld).invert();
    for (const entry of this.entries) {
      const { source, original, surface, outline } = entry;
      source.updateWorldMatrix(true, false);
      const matrix = source.matrixWorld.elements;
      const local = height === null ? Infinity : (height - .001 - matrix[13]) / matrix[5];
      const bounds = original.boundingBox;
      const visible = height !== null && source.visible && local > bounds.min.y && local < bounds.max.y;
      surface.visible = outline.visible = visible;
      if (!visible) continue;
      surface.matrix.multiplyMatrices(this.inverse, source.matrixWorld);
      outline.matrix.copy(surface.matrix);
      surface.matrixWorldNeedsUpdate = outline.matrixWorldNeedsUpdate = true;
      if (entry.height === local) continue;
      entry.height = local;
      if (!entry.moving && !entry.buffers && Number.isInteger(height)) {
        const shared = fixedSection(original, local);
        surface.geometry = shared.surface;
        outline.geometry = shared.outline;
      } else {
        if (!entry.buffers) entry.buffers = { surface: geometry(entry.capacity), outline: geometry(entry.capacity * 2, true) };
        surface.geometry = entry.buffers.surface;
        outline.geometry = entry.buffers.outline;
        fill(surface.geometry, outline.geometry, modelSection(original, local));
      }
    }
  }
}
