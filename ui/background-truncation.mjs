// Static context geometry is built once. Moving Truncate only changes clip
// planes, visibility and cached cross sections; active-room picking stays CPU-cut.
import { isEdge } from "./thick-edges.mjs";
import * as THREE from "../render/vendor/three.module.min.js";
import { collectVoxelSceneV2 } from "./voxel-scene.mjs";
import { edgeGeometryFromFaces, edgeMaterial, geometryFromFaces, renderMaterial, disposeGeneratedChildren } from "../render/v1/polycube-mesh.mjs";
import { ModelTruncateCaps } from "./model-truncate-caps.mjs";
import { batchStaticRoom } from "./static-room-batches.mjs";

const CUT_EPSILON = 0.0005;
const OPEN_HEIGHT = 1e6;

export class BackgroundTruncation {
  constructor() {
    this.lowerPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), OPEN_HEIGHT);
    this.edgePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), OPEN_HEIGHT);
    this.upperPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -OPEN_HEIGHT);
    this.materials = new Map();
  }

  material(source, upper, line) {
    let variants = this.materials.get(source);
    if (!variants) this.materials.set(source, variants = new Map());
    const key = upper ? "upper" : line ? "edge" : "lower";
    if (variants.has(key)) return variants.get(key);
    const material = source.clone();
    material.clippingPlanes = [upper ? this.upperPlane : line ? this.edgePlane : this.lowerPlane];
    material.onBeforeCompile = shader => {
      source.onBeforeCompile?.(shader);
      if (line) {
        // Outline depth bias must not move the clipping plane with the camera.
        shader.vertexShader = shader.vertexShader.replace("#include <clipping_planes_vertex>",
          "#if NUM_CLIPPING_PLANES > 0\n vClipPosition = -(modelViewMatrix * vec4(transformed, 1.0)).xyz;\n#endif");
      }
    };
    material.customProgramCacheKey = () => `${source.customProgramCacheKey?.() || source.type}:background-clip:${key}`;
    if (upper) {
      material.transparent = source.transparent || this.opacity < 1;
      material.depthWrite = source.depthWrite && this.opacity >= 1;
      material.opacity = source.opacity * (this.opacity || 0);
    }
    variants.set(key, material);
    return material;
  }

  prepare(entry, world, dimensions, renderer) {
    entry.capRoot = new THREE.Group();
    entry.root.add(entry.capRoot);
    entry.modelCaps = new ModelTruncateCaps(renderer, entry.content, entry.capRoot);
    entry.retiredModelSources = batchStaticRoom(entry.content, new Set(entry.modelCaps.entries.map(entry => entry.source)));
    entry.clipObjects = [];
    entry.content.updateWorldMatrix(true, true);
    entry.content.traverse(object => {
      if (!object.geometry || !object.material) return;
      if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
      const original = object.material;
      entry.clipObjects.push({ object, original, min: bounds.min.y, max: bounds.max.y, visible: object.visible, ownsMaterial: object.userData.transientMaterial === true });
      const convert = material => this.material(material, false, isEdge(object));
      object.material = Array.isArray(original) ? original.map(convert) : convert(original);
      // Cloned materials are owned by this controller, not by individual meshes.
      delete object.userData.transientMaterial;
    });
    entry.capFaces = capFacesByHeight(collectVoxelSceneV2({ world }), dimensions);
    entry.caps = new Map();
  }

  set(height, opacity) {
    opacity = height === null ? 0 : opacity;
    if (this.height === height && this.opacity === opacity) return false;
    this.height = height;
    this.opacity = height === null ? 0 : opacity;
    this.lowerPlane.constant = height === null ? OPEN_HEIGHT : height - CUT_EPSILON;
    this.edgePlane.constant = height === null ? OPEN_HEIGHT : height - 0.002;
    this.upperPlane.constant = height === null ? -OPEN_HEIGHT : -height - 0.002;
    for (const [source, variants] of this.materials) {
      const upper = variants.get("upper");
      if (upper) {
        upper.opacity = source.opacity * this.opacity;
        upper.transparent = source.transparent || this.opacity < 1;
        upper.depthWrite = source.depthWrite && this.opacity >= 1;
      }
    }
    return true;
  }

  update(entry, { prepareCaps = true } = {}) {
    const height = this.height;
    if (this.opacity > 0 && !entry.ghostObjects) {
      entry.ghostObjects = [];
      // Clone only the nodes; geometry and textures remain shared with the
      // cached opaque world. Ghosts are allocated lazily on first use.
      const ghost = entry.content.clone(true);
      let index = 0;
      ghost.traverse(object => {
        if (!object.geometry || !object.material) return;
        const source = entry.clipObjects[index++];
        const convert = material => this.material(material, true, false);
        object.material = Array.isArray(source.original) ? source.original.map(convert) : convert(source.original);
        object.castShadow = false;
        object.receiveShadow = false;
        entry.ghostObjects.push(object);
      });
      entry.cutawayContent.add(ghost);
    }
    entry.clipObjects.forEach((record, index) => {
      record.object.visible = record.visible && (height === null || record.min < height - CUT_EPSILON);
      const ghost = entry.ghostObjects?.[index];
      if (ghost) ghost.visible = record.visible && !isEdge(ghost) && this.opacity > 0 && record.max > height + 0.002;
    });
    entry.cutawayContent.visible = this.opacity > 0;
    entry.capRoot.visible = prepareCaps || entry.preparedCapHeight === height;
    if (prepareCaps) this.prepareCaps(entry);
  }

  prepareCaps(entry) {
    const height = this.height;
    entry.capRoot.visible = true;
    entry.preparedCapHeight = height;
    entry.modelCaps.update(height);
    if (entry.activeCaps) entry.activeCaps.visible = false;
    entry.activeCaps = null;
    if (height === null || !entry.capFaces.has(height)) return;
    let caps = entry.caps.get(height);
    if (!caps) {
      caps = new THREE.Group();
      for (const { color, faces } of entry.capFaces.get(height).values()) {
        const mesh = new THREE.Mesh(geometryFromFaces(faces), renderMaterial(color, false));
        const edges = new THREE.LineSegments(edgeGeometryFromFaces(faces), edgeMaterial());
        caps.add(mesh, edges);
      }
      entry.caps.set(height, caps);
      entry.capRoot.add(caps);
    }
    caps.visible = true;
    entry.activeCaps = caps;
  }

  disposeEntry(entry) {
    // Ghosts share geometry with content; dispose it only through content.
    entry.cutawayContent.clear();
    for (const record of entry.clipObjects) {
      if (!record.ownsMaterial) continue;
      for (const source of Array.isArray(record.original) ? record.original : [record.original]) {
        for (const material of this.materials.get(source)?.values() || []) material.dispose();
        this.materials.delete(source);
        source.dispose();
      }
    }
    for (const source of entry.retiredModelSources || []) {
      if (!source.geometry.userData.persistentGeometry) source.geometry.dispose();
      if (source.userData.transientMaterial) source.material.dispose();
    }
    disposeGeneratedChildren(entry.content);
    disposeGeneratedChildren(entry.capRoot);
    entry.root.removeFromParent();
  }

  dispose() {
    for (const variants of this.materials.values()) for (const material of variants.values()) material.dispose();
    this.materials.clear();
  }
}

// Integer-height cut surfaces fill columns whose original top is above the
// cut. Replacing the full cross section also avoids seams at former steps.
export function capFacesByHeight(data, dimensions) {
  const layers = new Map();
  const add = (height, key, color, left, right, north, south) => {
    if (!Number.isInteger(height) || height < 1) return;
    if (!layers.has(height)) layers.set(height, new Map());
    const layer = layers.get(height);
    if (!layer.has(key)) layer.set(key, { color, faces: [] });
    const y = height - CUT_EPSILON * 2;
    const x0 = left - dimensions.totalWidth / 2, x1 = right - dimensions.totalWidth / 2;
    const z0 = north - dimensions.totalHeight / 2, z1 = south - dimensions.totalHeight / 2;
    layer.get(key).faces.push({ normal: "y+", corners: [[x0,y,z0],[x0,y,z1],[x1,y,z1],[x1,y,z0]] });
  };
  for (const [key, group] of data.cubeGroups) for (const voxel of group.voxels) {
    add(voxel.y + 1, key, group.color, voxel.x, voxel.x + 1, voxel.z, voxel.z + 1);
  }
  for (const record of data.specialPieces) {
    const { definition: d, source, x, z } = record;
    if (!["gate", "raised_lift", "lowered_lift", "side_lift", "floating_floor"].includes(d.kind)) continue;
    let left = x, right = x + 1, north = z, south = z + 1;
    if (d.kind === "side_lift" && !d.raised) {
      const width = 4 / 64;
      if (d.orientation === "north") north = south - width;
      if (d.orientation === "south") south = north + width;
      if (d.orientation === "east") right = left + width;
      if (d.orientation === "west") left = right - width;
    }
    const key = `${source.blockId}:${source.groupId ?? source.genericId ?? ""}:${d.color}`;
    for (let height = Math.floor(d.bottom) + 1; height <= d.top; height++) add(height, key, d.color, left, right, north, south);
  }
  return layers;
}
