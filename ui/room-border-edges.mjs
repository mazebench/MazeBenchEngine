import * as THREE from "../render/vendor/three.module.min.js";
import { collectVoxelSceneV2 } from "./voxel-scene.mjs";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { joinedSceneGroups, joinedSurfaceFaces } from "./joined-voxel-mesh.mjs";
import { joinedEdgePositions } from "./joined-voxel-surface.mjs";

const near = (a, b) => Math.abs(a - b) < 1e-5;
const cache = new WeakMap();

// Only a one-cell strip on either side of a seam is needed. Use the shared
// cube/slope kernel to cancel coplanar edges and retain real ridges, partial
// slope contacts, different materials, and numbered-body boundaries.
export function roomBorderEdges(world, room, { maxHeight, minHeight = -Infinity, excludePlayer = false } = {}) {
  if (!room?.fileName || !world.contextRooms) return [];
  const borders = [];
  const halfWidth = world.columns.length * world.roomWidth / 2;
  const halfHeight = world.rows.length * world.roomHeight / 2;
  for (const [axis, step] of [[0, -1], [0, 1], [2, -1], [2, 1]]) {
    const dx = axis === 0 ? step : 0, dy = axis === 2 ? step : 0;
    const neighbor = world.contextRooms.find(candidate => candidate.columnIndex === room.columnIndex + dx && candidate.rowIndex === room.rowIndex + dy);
    if (!neighbor) continue;
    const size = axis === 0 ? world.roomWidth : world.roomHeight;
    const coordinate = axis === 0 ? "x" : "y";
    const boundary = ((axis === 0 ? room.columnIndex : room.rowIndex) + Number(step > 0)) * size;
    if (!cache.has(room.objects)) cache.set(room.objects, new WeakMap());
    const neighbors = cache.get(room.objects);
    if (!neighbors.has(neighbor.objects)) neighbors.set(neighbor.objects, new Map());
    const variants = neighbors.get(neighbor.objects);
    const key = `${axis}:${boundary}:${step}:${maxHeight}:${minHeight}:${halfWidth}:${halfHeight}:${excludePlayer}`;
    let positions = variants.get(key);
    if (!positions) {
      const strip = (source, edge) => ({ ...source, renderDimmed: false,
        objects: source.objects.filter(object => object[coordinate] === edge &&
          (!excludePlayer || world.blockDefinitions.get(object.blockId)?.roleId !== "player")).map(object => {
          const block = world.blockDefinitions.get(object.blockId);
          // Dynamic bodies in distinct rooms never become one numbered body.
          return ["weightless-pushable", "clone", "player", "orange-wall"].includes(block?.roleId)
            ? { ...object, groupId: `${source.fileName}/${object.groupId ?? object.genericId ?? ""}` } : object;
        }) });
      const data = collectVoxelSceneV2({ world: { ...world, rooms: [strip(room, step > 0 ? size - 1 : 0), strip(neighbor, step > 0 ? 0 : size - 1)] } }, { maxHeight, minHeight });
      const { groups, occupants } = joinedSceneGroups(data, { all: true });
      positions = [];
      const plane = boundary - (axis === 0 ? halfWidth : halfHeight);
      for (const group of groups) {
        const edges = joinedEdgePositions(joinedSurfaceFaces(group.shapes, occupants, { minHeight }), halfWidth, halfHeight);
        for (let i = 0; i < edges.length; i += 6) {
          if (near(edges[i + axis], plane) && near(edges[i + 3 + axis], plane)) positions.push(...edges.slice(i, i + 6));
        }
      }
      variants.set(key, positions);
    }
    const acrossAxis = axis === 0 ? 2 : 0;
    const min = axis === 0 ? room.rowIndex * world.roomHeight - halfHeight : room.columnIndex * world.roomWidth - halfWidth;
    const max = min + (axis === 0 ? world.roomHeight : world.roomWidth);
    borders.push({ axis, plane: boundary - (axis === 0 ? halfWidth : halfHeight), acrossAxis, min, max, positions });
  }
  return borders;
}

export function joinRoomBorderEdges(objects, borders, content) {
  if (!borders.length) return;
  for (const object of objects) {
    if (!object.isLineSegments || object.userData.roomBorderEdges) continue;
    const points = object.geometry.attributes.position;
    if (!points) continue;
    const positions = [];
    for (let i = 0; i < points.count; i += 2) {
      const a = [points.getX(i), points.getY(i), points.getZ(i)];
      const b = [points.getX(i + 1), points.getY(i + 1), points.getZ(i + 1)];
      if (!borders.some(({ axis, plane, acrossAxis, min, max }) => near(a[axis], plane) && near(b[axis], plane) &&
          [a[acrossAxis], b[acrossAxis]].every(value => value >= min - 1e-5 && value <= max + 1e-5))) positions.push(...a, ...b);
    }
    if (positions.length === points.count * 3) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    if (!object.geometry.userData.persistentGeometry) object.geometry.dispose();
    object.geometry = geometry;
  }
  const positions = borders.flatMap(border => border.positions);
  if (!positions.length) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  const edges = new THREE.LineSegments(geometry, edgeMaterial());
  edges.renderOrder = 10;
  edges.userData.roomBorderEdges = true;
  content.add(edges);
}
