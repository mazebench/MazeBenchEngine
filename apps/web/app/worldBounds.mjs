import { rotateVoxelVisualMetadata } from "./visualVariants.mjs";

/** @typedef {{ width: number, height: number }} HorizontalWorld */
/** @typedef {{ x: number, y: number }} HorizontalVoxel */

/**
 * The room is bounded only on its horizontal axes. Vertical coordinates remain
 * intentionally unbounded so voxels above and below floor layer 0 survive.
 *
 * @param {HorizontalVoxel} voxel
 * @param {HorizontalWorld} world
 */
export function isVoxelInsideWorld(voxel, world) {
  return voxel.x >= 0 && voxel.x < world.width && voxel.y >= 0 && voxel.y < world.height;
}

/**
 * @template {HorizontalVoxel} T
 * @param {T[]} voxels
 * @param {HorizontalWorld} world
 * @returns {T[]}
 */
export function cropVoxelsToWorld(voxels, world) {
  return voxels
    .filter((voxel) => isVoxelInsideWorld(voxel, world))
    .map((voxel) => ({ ...voxel }));
}

/**
 * A test owns one horizontal world shared by its Start and Expected frames.
 * Applying a new world always bounds both frames together.
 *
 * @template {{ start: { voxels: HorizontalVoxel[] }, expected: { voxels: HorizontalVoxel[] } }} T
 * @param {T} test
 * @param {HorizontalWorld & { floorLayer?: number }} world
 * @returns {T & { world: { width: number, height: number, floorLayer: 0 } }}
 */
export function applyWorldToTest(test, world) {
  return {
    ...test,
    world: { width: world.width, height: world.height, floorLayer: 0 },
    start: { ...test.start, voxels: cropVoxelsToWorld(test.start.voxels, world) },
    expected: { ...test.expected, voxels: cropVoxelsToWorld(test.expected.voxels, world) },
    intermediate: (test.intermediate ?? []).map((frame) => ({
      ...frame,
      voxels: cropVoxelsToWorld(frame.voxels, world),
    })),
  };
}

/**
 * Parses a dimension only when the user explicitly saves the draft. Keeping
 * this separate from input events lets the text field accept any temporary
 * value without mutating the authored test.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseWorldDimensionDraft(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const dimension = Number(text);
  return Number.isSafeInteger(dimension) && dimension >= 3 && dimension <= 32
    ? dimension
    : null;
}

/**
 * @param {HorizontalWorld} world
 * @param {number} quarterTurns Number of clockwise quarter turns.
 * @returns {HorizontalWorld}
 */
export function rotateWorldClockwise(world, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  return turns % 2
    ? { width: world.height, height: world.width }
    : { width: world.width, height: world.height };
}

/**
 * Rotates coordinates inside the room instead of around the global origin, so
 * every rotated voxel remains in a zero-based room of the rotated dimensions.
 *
 * @template {HorizontalVoxel} T
 * @param {T[]} voxels
 * @param {HorizontalWorld} world
 * @param {number} quarterTurns Number of clockwise quarter turns.
 * @returns {T[]}
 */
export function rotateVoxelsClockwise(voxels, world, quarterTurns) {
  const turns = ((quarterTurns % 4) + 4) % 4;
  return cropVoxelsToWorld(voxels, world).map((voxel) => {
    const rotated = rotateVoxelVisualMetadata(voxel, turns);
    if (turns === 1) return { ...rotated, x: world.height - 1 - voxel.y, y: voxel.x };
    if (turns === 2) return { ...rotated, x: world.width - 1 - voxel.x, y: world.height - 1 - voxel.y };
    if (turns === 3) return { ...rotated, x: voxel.y, y: world.width - 1 - voxel.x };
    return rotated;
  });
}
