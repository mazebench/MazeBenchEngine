import * as THREE from "../../render/vendor/three.module.min.js";
import { edgeMaterial } from "../../render/v1/polycube-mesh.mjs";
import { joinedSurfaceMaterial } from "../../ui/joined-voxel-mesh.mjs";
import { joinedEdgePositions, slopeMeshFamily } from "../../ui/joined-voxel-surface.mjs";

// Horizontal sections of cubes and ramps. Keep the outer contour of joined
// surfaces, including fractional heights during lifts and room transitions.
export function cutSectionFaces(shapes, height) {
  const faces = [], seen = new Set(), y = height - .001;
  for (const shape of shapes) {
    const [x, bottom, z] = shape.position, [width, tall, depth] = shape.size || [1, 1, 1];
    if (bottom >= height - .0005 || bottom + tall < height - .0005) continue;
    let left = x, right = x + width, north = z, south = z + depth;
    const fraction = Math.max(0, Math.min(1, (y - bottom) / tall));
    if (shape.direction === "right") left += width * fraction;
    if (shape.direction === "left") right -= width * fraction;
    if (shape.direction === "up") south -= depth * fraction;
    if (shape.direction === "down") north += depth * fraction;
    const key = `${left}:${right}:${north}:${south}`;
    if (seen.has(key) || right - left < 1e-7 || south - north < 1e-7) continue;
    seen.add(key);
    faces.push({ normal: "0,1,0", corners: [[left,y,north],[left,y,south],[right,y,south],[right,y,north]] });
  }
  return faces;
}

function buffer(capacity, outline = false) {
  const geometry = new THREE.BufferGeometry();
  for (const name of outline ? ["position", "lineOther"] : ["position", "normal"]) {
    geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  if (outline) {
    const sides = new Float32Array(capacity), ends = new Float32Array(capacity);
    for (let i = 0; i < capacity; i += 6) { sides.set([-1,1,1,1,1,-1], i); ends.set([0,1,0,0,1,1], i); }
    geometry.setAttribute("lineSide", new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute("lineEnd", new THREE.BufferAttribute(ends, 1));
  } else for (let i = 1; i < capacity * 3; i += 3) geometry.attributes.normal.array[i] = 1;
  geometry.setDrawRange(0, 0);
  return geometry;
}

export class TruncateCaps {
  constructor(renderer, root, records) {
    this.renderer = renderer; this.root = root; this.groups = new Map();
    for (const record of records) {
      const { block, object } = record.track;
      const key = `${slopeMeshFamily(block.id)}:${object.groupId ?? object.genericId ?? ""}:${block.color}`;
      if (!this.groups.has(key)) this.groups.set(key, { records: [], block });
      this.groups.get(key).records.push(record);
    }
    let first = true;
    for (const group of this.groups.values()) {
      const material = joinedSurfaceMaterial({ color: group.block.color, orangeWall: group.block.roleId === "orange-wall" }).clone();
      group.surface = new THREE.Mesh(buffer(group.records.length * 6), material);
      group.surface.castShadow = group.surface.receiveShadow = true;
      // The first group also carries shared room-border contours, which may
      // belong to any material in this scene.
      const outlineCapacity = (group.records.length + (first ? records.length : 0)) * 48;
      first = false;
      group.outline = new THREE.Mesh(buffer(outlineCapacity, true), renderer.thickEdges.material(edgeMaterial()));
      group.outline.userData.mazeWideOutline = true;
      group.outline.renderOrder = 10;
      for (const mesh of [group.surface, group.outline]) {
        mesh.userData.truncateCap = mesh.userData.transientMaterial = true;
        mesh.frustumCulled = false; mesh.visible = false;
        root.add(mesh);
      }
    }
  }

  update(height) {
    if (this.borderHeight !== height) {
      this.borderHeight = height;
      this.borders = Number.isInteger(height) ? this.root.cutawayBorders?.(height) || [] : [];
    }
    let first = true;
    for (const group of this.groups.values()) {
      group.surface.visible = group.outline.visible = height !== null;
      if (height === null) continue;
      const signature = `${height}:` + group.records.map(record => `${record.visible}:${record.shape.position}:${record.shape.size}`).join(";");
      const addBorder = first; first = false;
      if (signature === group.signature) continue;
      group.signature = signature;
      const faces = cutSectionFaces(group.records.filter(record => record.visible).map(record => record.shape), height);
      const surface = group.surface.geometry, outline = group.outline.geometry;
      const point = (attribute, index, p) => attribute.setXYZ(index,
        p[0] - this.renderer.totalWidth / 2 - this.root.position.x, p[1] - this.root.position.y,
        p[2] - this.renderer.totalHeight / 2 - this.root.position.z);
      let index = 0;
      for (const { corners } of faces) for (const vertex of [0,1,2,0,2,3]) point(surface.attributes.position, index++, corners[vertex]);
      surface.setDrawRange(0, index);
      let segments = joinedEdgePositions(faces);
      if (this.borders.length) {
        const half = [this.renderer.totalWidth / 2, 0, this.renderer.totalHeight / 2], filtered = [];
        for (let i = 0; i < segments.length; i += 6) {
          if (!this.borders.some(({ axis, plane, acrossAxis, min, max }) =>
            Math.abs(segments[i + axis] - half[axis] - plane) < 1e-5 &&
            Math.abs(segments[i + 3 + axis] - half[axis] - plane) < 1e-5 &&
            [segments[i + acrossAxis], segments[i + 3 + acrossAxis]].every(value => value - half[acrossAxis] >= min - 1e-5 && value - half[acrossAxis] <= max + 1e-5))) {
            filtered.push(...segments.slice(i, i + 6));
          }
        }
        if (addBorder) for (const { positions } of this.borders) for (let i = 0; i < positions.length; i += 6) {
          if (Math.abs(positions[i + 1] - height) < 1e-5 && Math.abs(positions[i + 4] - height) < 1e-5) {
            filtered.push(positions[i] + half[0], height - .001, positions[i + 2] + half[2],
              positions[i + 3] + half[0], height - .001, positions[i + 5] + half[2]);
          }
        }
        segments = filtered;
      }
      index = 0;
      for (let i = 0; i < segments.length; i += 6) for (const end of [0,1,0,0,1,1]) {
        point(outline.attributes.position, index, segments.slice(i + end * 3, i + end * 3 + 3));
        point(outline.attributes.lineOther, index++, segments.slice(i + (1-end) * 3, i + (1-end) * 3 + 3));
      }
      outline.setDrawRange(0, index);
      for (const geometry of [surface, outline]) for (const name of ["position", "lineOther"]) {
        const attribute = geometry.attributes[name];
        if (!attribute) continue;
        attribute.clearUpdateRanges();
        if (geometry.drawRange.count) attribute.addUpdateRange(0, geometry.drawRange.count * 3);
        attribute.needsUpdate = true;
      }
    }
  }
}
