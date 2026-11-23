// Adapts explicit v2 voxel objects into renderer-v1's connected mesh,
// authored-asset, and special-piece queues.

import { assetReady } from "./asset-renderers.mjs";
import {
  FLOOR_DROP,
  FLOOR_THICKNESS,
  voxelKey
} from "./polycube-mesh.mjs";
import {
  FLOATING_FLOOR_HEIGHT,
  ORANGE_BUTTON_HEIGHT,
  PLATE_OFFSET,
  PLATE_THICKNESS
} from "./piece-definitions.mjs";

function groupEntry(groups, key, settings) {
  if (!groups.has(key)) groups.set(key, { ...settings, voxels: [], voxelKeys: new Set() });
  return groups.get(key);
}

export function voxelRenderSource(object, block) {
  return {
    ...object,
    type: block.visual?.modelType || block.id,
    color: block.color,
    direction: object.orientation || "right",
    elevation: object.z,
    modelUrl: block.visual?.modelUrl || null,
    raised: object.stateId === 1
  };
}

export function voxelPieceDefinition(object, block) {
  const bottom = object.z;
  const color = block.color;
  const kind = block.visual?.kind || "cube";
  if ((kind === "floor" || kind === "exit") && bottom === 0) {
    return {
      kind: "floor",
      bottom: -FLOOR_DROP - FLOOR_THICKNESS,
      top: -FLOOR_DROP,
      color,
      editorGrid: true,
      exitMarker: kind === "exit"
    };
  }
  if (kind === "model") {
    return {
      kind: block.visual.modelType === "gem" ? "gem_asset" : "terrain_asset",
      bottom,
      top: bottom + (block.visual.height || 1),
      fallbackHeight: block.visual.height || 1,
      color
    };
  }
  if (kind === "slope") return { kind: "slope", bottom, top: bottom + 1, color };
  if (kind === "gate") {
    return object.stateId === 1
      ? { kind: "gate", bottom, top: bottom + 1, color, raised: true }
      : {
          kind: "gate",
          bottom: bottom + PLATE_OFFSET - PLATE_THICKNESS,
          top: bottom + PLATE_OFFSET,
          color,
          raised: false
        };
  }
  if (kind === "lift") {
    const orientation = object.orientation || "top";
    const raised = object.stateId === 1;
    if (orientation !== "top") {
      return { kind: "side_lift", bottom, top: bottom + 1, color, marker: raised ? "up" : "down", orientation, raised };
    }
    return raised
      ? { kind: "raised_lift", bottom, top: bottom + 1, color, marker: "up" }
      : {
          kind: "lowered_lift",
          bottom: bottom + PLATE_OFFSET - PLATE_THICKNESS,
          top: bottom + PLATE_OFFSET,
          color,
          marker: "down"
        };
  }
  if (kind === "button") {
    return { kind: "orange_button", bottom, top: bottom + 1, color, orientation: object.orientation || "top" };
  }
  if (kind === "puncher") {
    return { kind: "puncher", bottom, top: bottom + 0.88, color, sprung: object.stateId === 1 };
  }
  if (kind === "platform") {
    return { kind: "floating_floor", bottom, top: bottom + FLOATING_FLOOR_HEIGHT, color };
  }
  return { kind: "cube", bottom, top: bottom + 1, height: 1, color };
}

export function collectVoxelSceneV2(renderer, { minHeight = -Infinity, maxHeight = Infinity } = {}) {
  const floorGroups = new Map();
  const cubeGroups = new Map();
  const occupied = new Set();
  const specialPieces = [];
  const terrainAssets = [];
  const gems = [];
  const genericLabels = [];
  const modelUrls = new Set();
  const editorGridCells = [];
  const pickRecords = [];
  renderer.cellTops = new Map();

  const recordTop = (x, y, top) => {
    const key = `${x},${y}`;
    renderer.cellTops.set(key, Math.max(renderer.cellTops.get(key) ?? -Infinity, top));
  };
  const addVoxelColumn = (groupKey, settings, x, y, bottom, height) => {
    const group = groupEntry(cubeGroups, groupKey, settings);
    for (let offset = 0; offset < height; offset += 1) {
      const voxel = { x, z: y, y: bottom + offset };
      if (voxel.y < minHeight || voxel.y >= maxHeight) continue;
      const key = voxelKey(voxel.x, voxel.z, voxel.y);
      if (!group.voxelKeys.has(key)) {
        group.voxels.push(voxel);
        group.voxelKeys.add(key);
      }
      occupied.add(key);
    }
    recordTop(x, y, Math.min(bottom + height, maxHeight));
  };

  renderer.world.rooms.forEach((room) => {
    const dimmed = room.renderDimmed === true;
    room.objects.forEach((object) => {
      const block = renderer.world.blockDefinitions.get(object.blockId);
      if (!block) return;
      const x = room.columnIndex * renderer.world.roomWidth + object.x;
      const y = room.rowIndex * renderer.world.roomHeight + object.y;
      const source = voxelRenderSource(object, block);
      const definition = voxelPieceDefinition(object, block);
      if (definition.bottom >= maxHeight || definition.top <= minHeight) return;
      recordTop(x, y, Math.min(definition.top, maxHeight));
      if (!dimmed) {
        pickRecords.push({
          room,
          object,
          block,
          globalX: x,
          globalY: y,
          bottom: definition.bottom,
          top: Math.min(maxHeight, definition.kind === "terrain_asset" ? definition.top : Math.max(definition.top, definition.bottom + 0.04)),
          height: Math.min(block.visual?.height || 1, maxHeight - object.z),
          surfaceFloor: definition.kind === "floor"
        });
      }
      if (!dimmed && (block.roleId === "weightless-pushable" || block.roleId === "clone") &&
          Number.isInteger(object.groupId ?? object.genericId)) {
        genericLabels.push({
          block,
          bottom: definition.bottom,
          label: String(object.groupId ?? object.genericId),
          object,
          top: definition.top,
          x,
          z: y
        });
      }

      if (definition.kind === "floor") {
        const key = `v2-floor:${dimmed ? "context" : "active"}:${block.id}:${definition.color}`;
        if (!floorGroups.has(key)) floorGroups.set(key, { color: definition.color, dimmed, cells: [] });
        const floor = { x, z: y, bottom: definition.bottom, top: definition.top };
        floorGroups.get(key).cells.push(floor);
        if (!dimmed) editorGridCells.push(floor);
        if (definition.exitMarker) {
          specialPieces.push({
            dimmed,
            x,
            z: y,
            source,
            definition: { kind: "exit_marker", bottom: definition.top + 0.02, top: definition.top + 0.36 }
          });
        }
        return;
      }
      if (definition.kind === "terrain_asset") {
        modelUrls.add(source.modelUrl);
        if (assetReady(source.modelUrl)) {
          terrainAssets.push({ dimmed, x, z: y, localX: object.x, localZ: object.y, source, definition });
        } else {
          addVoxelColumn(
            `v2-asset-fallback:${dimmed ? "context" : "active"}:${block.id}:${definition.color}`,
            { color: definition.color, dimmed },
            x,
            y,
            definition.bottom,
            definition.fallbackHeight
          );
        }
        return;
      }
      if (definition.kind === "gem_asset") {
        modelUrls.add(source.modelUrl);
        gems.push({ dimmed, x, z: y, source, definition });
        return;
      }
      if (definition.kind === "cube") {
        const identity = object.groupId ?? object.genericId ?? "";
        addVoxelColumn(
          `v2-cube:${dimmed ? "context" : "active"}:${block.id}:${identity}:${definition.color}`,
          { color: definition.color, dimmed },
          x,
          y,
          definition.bottom,
          definition.height
        );
        return;
      }
      specialPieces.push({ dimmed, x, z: y, source, definition });
    });
  });

  return {
    cubeGroups,
    editorGridCells,
    floorGroups,
    gems,
    genericLabels,
    modelUrls,
    occupied,
    pickRecords,
    specialPieces,
    terrainAssets
  };
}
