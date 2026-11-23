import * as THREE from "../render/vendor/three.module.min.js";
import { voxelPieceDefinition } from "./voxel-scene.mjs";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { surfaceContactEdges } from "./joined-voxel-surface.mjs";

export function contactShape(object, block) {
  if (!block || object.engineHidden || block.visual?.orangeForm === "hidden") return null;
  const definition = voxelPieceDefinition(object, block);
  if (definition.kind === "side_lift") {
    const shape = { position: [object.x, definition.bottom, object.y], size: [1, 1, 1] };
    if (!definition.raised) {
      const axis = ["east", "west"].includes(definition.orientation) ? 0 : 2;
      shape.size[axis] = 4 / 64;
      if (["north", "west"].includes(definition.orientation)) shape.position[axis] += 1 - 4 / 64;
    }
    return shape;
  }
  if (!["cube", "floor", "slope", "gate", "raised_lift", "lowered_lift", "floating_floor"].includes(definition.kind)) return null;
  return {
    position: [object.x, definition.bottom, object.y],
    size: [1, definition.top - definition.bottom, 1],
    ...(definition.kind === "slope" ? { direction: object.orientation || "right" } : {})
  };
}

export function worldContactShapes(world, ceiling = Infinity) {
  const walls = [], supports = [];
  for (const room of world.rooms) for (const object of room.objects) {
    const block = world.blockDefinitions.get(object.blockId);
    const shape = contactShape(object, block);
    if (!shape || shape.position[1] >= ceiling - .0005) continue;
    shape.position[0] += room.columnIndex * world.roomWidth;
    shape.position[2] += room.rowIndex * world.roomHeight;
    (block.roleId === "orange-wall" ? walls : supports).push(shape);
  }
  return { walls, supports };
}

export function addOrangeWallContacts(content, world, dimensions, ceiling = null) {
  const { walls, supports } = worldContactShapes(world, ceiling ?? Infinity);
  const positions = surfaceContactEdges(walls, supports, dimensions.totalWidth / 2, dimensions.totalHeight / 2);
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const lines = new THREE.LineSegments(geometry, edgeMaterial());
  if (ceiling !== null) {
    lines.material = lines.material.clone();
    lines.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), ceiling - .002)];
    lines.userData.transientMaterial = true;
  }
  lines.renderOrder = 10;
  lines.userData.orangeWallContacts = true;
  content.add(lines);
}

// One small retained outline buffer per moving wall group. The shader/clip/
// fade materials are inherited from its actor; no scene or geometry rebuilds.
export class AnimatedWallContacts {
  constructor(renderer, root, walls, supports) {
    this.renderer = renderer;
    this.root = root;
    this.walls = walls;
    // Only bodies whose swept horizontal bounds meet a wall can touch it.
    const bounds = track => [0, 1].map(axis => [Math.min(...track.positions.map(p => p[axis])), Math.max(...track.positions.map(p => p[axis])) + 1]);
    const wallBounds = walls.map(({ track }) => bounds(track));
    this.supports = supports.filter(({ track }) => {
      // Ordinary replay steps retarget the same player mesh across the room.
      // Keep that single support eligible even beyond its original swept bounds.
      if (track.block?.roleId === "player") return true;
      const box = bounds(track);
      return wallBounds.some(wall => box.every(([min, max], axis) => max >= wall[axis][0] && min <= wall[axis][1]));
    });
    const geometry = new THREE.BufferGeometry();
    this.capacity = 0;
    for (const name of ["position", "lineOther"]) geometry.setAttribute(name,
      new THREE.BufferAttribute(new Float32Array(0), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("lineSide", new THREE.BufferAttribute(new Float32Array(0), 1));
    geometry.setAttribute("lineEnd", new THREE.BufferAttribute(new Float32Array(0), 1));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geometry, renderer.thickEdges.material(edgeMaterial()));
    this.mesh.userData.mazeWideOutline = this.mesh.userData.orangeWallContacts = this.mesh.userData.transientMaterial = true;
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    root.add(this.mesh);
  }

  reserve(vertices) {
    if (vertices <= this.capacity) return;
    const geometry = this.mesh.geometry;
    // Retain the geometry shared by the solid/ghost copies. Release old GPU
    // attributes before replacing them; doubling prevents per-frame resizing.
    if (this.capacity) geometry.dispose();
    this.capacity = 6 * 2 ** Math.ceil(Math.log2(Math.max(16, vertices / 6)));
    for (const name of ["position", "lineOther"]) geometry.setAttribute(name,
      new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const sides = new Float32Array(this.capacity), ends = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i += 6) {
      sides.set([-1, 1, 1, 1, 1, -1], i);
      ends.set([0, 1, 0, 0, 1, 1], i);
    }
    geometry.setAttribute("lineSide", new THREE.BufferAttribute(sides, 1));
    geometry.setAttribute("lineEnd", new THREE.BufferAttribute(ends, 1));
  }

  update(height = null) {
    const visible = record => record.visible && (height === null || record.shape.position[1] < height - .0005);
    const walls = this.walls.filter(visible).map(record => record.shape);
    // A moving actor outside the walls' actual volume cannot change a contact
    // contour or occlude one. Exclude it from both the work and the dirty key;
    // otherwise every footstep rebuilds all orange/floor intersections.
    const overlaps = (a, b) => [0, 1, 2].every(axis =>
      a.position[axis] <= b.position[axis] + (b.size?.[axis] ?? 1) + 1e-6 &&
      b.position[axis] <= a.position[axis] + (a.size?.[axis] ?? 1) + 1e-6);
    const supports = this.supports.filter(record => visible(record) && walls.some(wall => overlaps(wall, record.shape))).map(record => record.shape);
    const signature = `${height}:${walls.length}:${this.root.position.toArray()}:` + [...walls, ...supports].map(shape =>
      `${shape.position}:${shape.size}:${shape.direction || ""}`).join(";");
    if (signature === this.signature) return;
    this.signature = signature;
    const positions = surfaceContactEdges(walls, supports, this.renderer.totalWidth / 2, this.renderer.totalHeight / 2);
    this.reserve(positions.length); // six floats and six expanded vertices per segment
    const geometry = this.mesh.geometry, position = geometry.attributes.position, other = geometry.attributes.lineOther;
    let index = 0;
    for (let i = 0; i < positions.length; i += 6) {
      for (const end of [0, 1, 0, 0, 1, 1]) {
        for (const [attribute, offset] of [[position, end * 3], [other, (1 - end) * 3]]) {
          attribute.setXYZ(index, positions[i + offset] - this.root.position.x,
            positions[i + offset + 1] - this.root.position.y, positions[i + offset + 2] - this.root.position.z);
        }
        index++;
      }
    }
    for (const attribute of [position, other]) {
      attribute.clearUpdateRanges();
      if (index) attribute.addUpdateRange(0, index * 3);
      attribute.needsUpdate = true;
    }
    geometry.setDrawRange(0, index);
  }
}
