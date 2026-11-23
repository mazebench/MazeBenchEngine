import * as THREE from "../render/vendor/three.module.min.js";
import { renderMaterial } from "../render/v1/polycube-mesh.mjs";
import { slopeMeshFamily, joinedTrianglePositions, joinedEdgePositions, slopeContactGroups } from "./joined-voxel-surface.mjs";
export { slopeMeshFamily, joinedSurfaceFaces } from "./joined-voxel-surface.mjs";

const orangeMaterials = new WeakMap();
export function joinedSurfaceMaterial(group) {
  const base = renderMaterial(group.color, group.dimmed);
  if (!group.orangeWall) return base;
  if (!orangeMaterials.has(base)) {
    const material = base.clone();
    // Match the lab's lowered orange surface: win coplanar depth tests against
    // the support, without moving geometry or obscuring actor contact outlines.
    material.polygonOffset = true;
    material.polygonOffsetFactor = material.polygonOffsetUnits = -1;
    orangeMaterials.set(base, material);
  }
  return orangeMaterials.get(base);
}

export function joinedGeometry(faces, halfWidth = 0, halfHeight = 0) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(joinedTrianglePositions(faces, halfWidth, halfHeight), 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function joinedEdges(faces, halfWidth = 0, halfHeight = 0) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(joinedEdgePositions(faces, halfWidth, halfHeight), 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function joinedSceneGroups(data, { all = false } = {}) {
  const groups = new Map(), occupants = [];
  const get = (key, settings) => {
    if (!groups.has(key)) groups.set(key, { ...settings, shapes: [], cubeKeys: [] });
    return groups.get(key);
  };
  for (const [key, group] of data.cubeGroups) {
    const parts = key.split(":");
    if (parts[0] === "v2-cube") parts[2] = slopeMeshFamily(parts[2]);
    const joined = get(parts.join(":"), { ...group, orangeWall: parts[2] === "orange-wall" });
    joined.cubeKeys.push(key);
    for (const voxel of group.voxels) {
      const shape = { position: [voxel.x, voxel.y, voxel.z] };
      joined.shapes.push(shape); occupants.push(shape);
    }
  }
  for (const record of data.specialPieces) {
    if (record.definition.kind !== "slope") continue;
    const source = record.source;
    const family = slopeMeshFamily(source.blockId);
    const identity = source.groupId ?? source.genericId ?? "";
    const key = `v2-cube:${record.dimmed ? "context" : "active"}:${family}:${identity}:${record.definition.color}`;
    const joined = get(key, { color: record.definition.color, dimmed: record.dimmed, orangeWall: family === "orange-wall" });
    const shape = { position: [record.x, record.definition.bottom, record.z], direction: source.direction || "right" };
    joined.shapes.push(shape); occupants.push(shape);
  }
  const contacts = slopeContactGroups([...groups.values()]);
  const joined = [...groups.values()].filter(group => all || group.orangeWall || contacts.has(group));
  const cubeGroups = new Map(data.cubeGroups);
  for (const group of joined) for (const key of group.cubeKeys) cubeGroups.delete(key);
  return { groups: joined, occupants, cubeGroups };
}
