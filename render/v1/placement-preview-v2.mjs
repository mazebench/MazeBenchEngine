// Translucent editor placement ghosts, built from the exact same v2 visual
// definitions and render helpers as committed scene objects.

import * as THREE from "../vendor/three.module.min.js";
import {
  addGemAsset,
  addTerrainAsset,
  assetReady
} from "./asset-renderers.mjs";
import {
  addOutlinedMesh,
  cachedGeometry,
  disposeGeneratedChildren
} from "./polycube-mesh.mjs";
import { addSpecialPiece } from "./special-piece-renderers.mjs";
import { addGenericNumberFaces, genericNumberLabel } from "./generic-labels.mjs";
import {
  voxelPieceDefinition,
  voxelRenderSource
} from "./voxel-scene-v2.mjs";

function recordFor(object, block) {
  const definition = voxelPieceDefinition(object, block);
  return {
    definition,
    localX: object.x,
    localZ: object.y,
    source: voxelRenderSource(object, block),
    x: object.x,
    z: object.y
  };
}

function addCuboid(group, record) {
  const height = Math.max(0.04, record.definition.top - record.definition.bottom);
  const geometry = cachedGeometry(`placement-preview-box:${height.toFixed(5)}`, () =>
    new THREE.BoxGeometry(1, height, 1));
  addOutlinedMesh(group, geometry, record.definition.color, {
    position: new THREE.Vector3(
      record.x - record.dimensions.totalWidth / 2 + 0.5,
      record.definition.bottom + height / 2,
      record.z - record.dimensions.totalHeight / 2 + 0.5
    )
  });
}

function makeTranslucent(group) {
  group.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const clones = materials.map((material) => {
      const clone = material.clone();
      clone.transparent = true;
      clone.opacity = object.isLineSegments ? 0.82 : 0.54;
      clone.depthWrite = false;
      clone.polygonOffset = !object.isLineSegments;
      clone.polygonOffsetFactor = -2;
      clone.polygonOffsetUnits = -2;
      return clone;
    });
    object.material = Array.isArray(object.material) ? clones : clones[0];
    object.userData.transientMaterial = true;
  });
}

export function clearPlacementPreview(group) {
  disposeGeneratedChildren(group);
}

export function renderPlacementPreview(group, object, block, dimensions) {
  clearPlacementPreview(group);
  if (!object || !block) return;
  const record = { ...recordFor(object, block), dimensions };
  const { definition } = record;

  if (definition.kind === "floor" || definition.kind === "cube") {
    addCuboid(group, record);
    if (definition.exitMarker) {
      addSpecialPiece(group, {
        ...record,
        definition: {
          kind: "exit_marker",
          bottom: definition.top + 0.02,
          top: definition.top + 0.36
        }
      }, dimensions);
    }
  } else if (definition.kind === "terrain_asset") {
    if (assetReady(record.source.modelUrl)) addTerrainAsset(group, record, dimensions);
    else addCuboid(group, record);
  } else if (definition.kind === "gem_asset") {
    addGemAsset(group, record, dimensions);
  } else {
    addSpecialPiece(group, record, dimensions);
  }
  const label = genericNumberLabel(object, block);
  if (label !== null) {
    addGenericNumberFaces(group, {
      block,
      bottom: definition.bottom,
      label,
      object,
      top: definition.top,
      x: object.x,
      z: object.y
    }, dimensions);
  }
  makeTranslucent(group);
}
