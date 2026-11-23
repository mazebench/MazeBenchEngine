// Geometry-only preparation can run in a worker using the same surface kernel
// as the ordinary renderer, including contacts across room boundaries.
import { floorFaces, voxelFaces, geometryFromFaces, edgeGeometryFromFaces } from "../render/v1/polycube-mesh.mjs";
import { joinedSceneGroups, joinedSurfaceFaces, joinedGeometry, joinedEdges } from "./joined-voxel-mesh.mjs";

export function buildWorldSurfaceBuffers(data, dimensions, onProgress = () => {}) {
  const { groups, occupants, cubeGroups } = joinedSceneGroups(data);
  const halfWidth = dimensions.totalWidth / 2, halfHeight = dimensions.totalHeight / 2;
  const total = [...data.floorGroups.values()].reduce((sum, group) => sum + group.cells.length, 0)
    + [...cubeGroups.values()].reduce((sum, group) => sum + group.voxels.length, 0)
    + groups.reduce((sum, group) => sum + group.shapes.length, 0);
  const buffers = [];
  let complete = 0;
  const add = (group, geometry, edges, joined = false, floor = false) => {
    buffers.push({ color: group.color, dimmed: group.dimmed, orangeWall: Boolean(group.orangeWall), joined, floor,
      positions: geometry.attributes.position.array,
      normals: geometry.attributes.normal.array,
      edges: edges?.attributes.position.array || null });
  };
  for (const group of data.floorGroups.values()) {
    add(group, geometryFromFaces(floorFaces(group.cells, halfWidth, halfHeight)), null, false, true);
    onProgress(complete += group.cells.length, total);
  }
  for (const group of cubeGroups.values()) {
    const faces = voxelFaces(group.voxels, data.occupied, halfWidth, halfHeight);
    if (faces.length) add(group, geometryFromFaces(faces), edgeGeometryFromFaces(faces));
    onProgress(complete += group.voxels.length, total);
  }
  for (const group of groups) {
    const faces = joinedSurfaceFaces(group.shapes, occupants);
    if (faces.length) add(group, joinedGeometry(faces, halfWidth, halfHeight), joinedEdges(faces, halfWidth, halfHeight), true);
    onProgress(complete += group.shapes.length, total);
  }
  return buffers;
}
