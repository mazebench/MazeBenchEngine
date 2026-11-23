/**
 * Index each voxel once instead of filtering the full scene for every floor tile.
 * Preserve stable same-height ordering (overlapping face fixtures) and inputs.
 * @template {{x: number, y: number, z: number}} T
 * @param {T[]} voxels
 * @param {number} width
 * @param {number} height
 * @returns {T[][]}
 */
export function voxelColumns(voxels, width, height) {
  const columns = Array.from({ length: width * height }, () => []);
  for (const voxel of voxels) {
    if (!Number.isInteger(voxel.x) || !Number.isInteger(voxel.y) ||
        voxel.x < 0 || voxel.x >= width || voxel.y < 0 || voxel.y >= height) continue;
    columns[voxel.y * width + voxel.x].push(voxel);
  }
  for (const column of columns) {
    if (column.length > 1) column.sort((a, b) => a.z - b.z);
  }
  return columns;
}
