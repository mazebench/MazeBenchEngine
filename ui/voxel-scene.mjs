// Live presentation corrections around the immutable benchmark scene adapter.
import {
  collectVoxelSceneV2 as collectHistoricalScene,
  voxelPieceDefinition as historicalPieceDefinition
} from "../render/v1/voxel-scene-v2.mjs";
import { FLOOR_THICKNESS } from "../render/v1/polycube-mesh.mjs";
import { floorSlabBounds } from "./joined-voxel-surface.mjs";

export function voxelPieceDefinition(object, block) {
  const definition = historicalPieceDefinition(object, block);
  return definition.kind === "floor"
    ? { ...definition, ...floorSlabBounds(FLOOR_THICKNESS) }
    : definition;
}

export function collectVoxelSceneV2(renderer, options) {
  const data = collectHistoricalScene(renderer, options);
  const bounds = floorSlabBounds(FLOOR_THICKNESS);
  let floorShift = 0;
  for (const group of data.floorGroups.values()) for (const cell of group.cells) {
    floorShift = bounds.top - cell.top;
    Object.assign(cell, bounds);
    // Editor grid cells share these records. Picking and camera surface
    // heights must agree with the visible floor as well.
    const key = `${cell.x},${cell.z}`;
    renderer.cellTops.set(key, Math.max(renderer.cellTops.get(key) ?? -Infinity, bounds.top));
  }
  for (const record of data.pickRecords) {
    if (record.surfaceFloor) Object.assign(record, bounds);
  }
  for (const record of data.specialPieces) {
    if (record.definition.kind !== "exit_marker") continue;
    record.definition.bottom += floorShift;
    record.definition.top += floorShift;
  }
  return data;
}
