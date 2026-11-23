import * as THREE from "../vendor/three.module.min.js";
import { voxelPieceDefinition } from "./voxel-scene-v2.mjs";
import { cutGeometryAtPlane } from "./cutaway-geometry.mjs";

// Heights are exclusive voxel ceilings: 1 reveals row z=0, 2 reveals z=0..1.
// A null ceiling always reveals everything, including newly added/moved objects.
export function cutawayMaxHeight(world) {
  let height = 1;
  for (const room of world.rooms) {
    for (const object of room.objects || []) {
      const block = world.blockDefinitions?.get(object.blockId);
      if (block) height = Math.max(height, Math.ceil(voxelPieceDefinition(object, block).top));
    }
  }
  return height;
}

export function normalizeCutaway({ height = null, opacity = 0, followPlayer = false } = {}) {
  return {
    height: Number.isFinite(height) ? Math.max(1, Math.round(height)) : null,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0,
    followPlayer: Boolean(followPlayer)
  };
}

export function playerCutawayHeight(world) {
  const room = world.rooms.find(room => !room.renderDimmed &&
    (!world.contextActiveRoom || room.fileName === world.contextActiveRoom.fileName));
  const player = room?.objects.find(object => !object.engineHidden &&
    world.blockDefinitions?.get(object.blockId)?.roleId === "player");
  return Number.isFinite(player?.z) ? Math.max(1, Math.round(player.z) + 1) : null;
}

export function stepCutawayHeight(height, maxHeight, direction) {
  const current = Math.min(maxHeight, height ?? maxHeight);
  const value = Math.max(1, Math.min(maxHeight, current + direction));
  return value >= maxHeight ? null : value;
}

// Clone shared materials so a cutaway never changes another renderer or the
// cached active/context materials. Cut spanning assets in geometry so opaque
// faces, shadows and outlines agree on the exposed surface.
export function applyCutawayMaterials(root, { height, upper = false, opacity = 1, clip = true }) {
  if (!Number.isFinite(height)) return;
  const plane = new THREE.Plane(new THREE.Vector3(0, upper ? 1 : -1, 0), upper ? -height - 0.002 : height);
  const copies = new Map();
  const copy = (source) => {
    if (!copies.has(source)) {
      const material = source.clone();
      material.onBeforeCompile = source.onBeforeCompile;
      material.customProgramCacheKey = source.customProgramCacheKey;
      if (upper) {
        material.opacity *= opacity;
        material.transparent = material.transparent || opacity < 1;
        if (opacity < 1) material.depthWrite = false;
      }
      copies.set(source, material);
    }
    return copies.get(source);
  };
  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    if (!object.material || object.material.colorWrite === false) return;
    const clipped = clip || object.userData.cutawayClip === true;
    if (clipped) {
      if (object.isMesh && object.geometry?.attributes.position) {
        const localPlane = plane.clone().applyMatrix4(object.matrixWorld.clone().invert());
        const original = object.geometry;
        object.geometry = cutGeometryAtPlane(original, localPlane);
        if (!original.userData.persistentGeometry) original.dispose();
      }
      if (object.isLineSegments) object.visible = false;
    }
    if (!upper) return;
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    object.material = Array.isArray(object.material)
      ? object.material.map(copy)
      : copy(object.material);
    if (object.userData.transientMaterial) {
      originals.forEach(material => material.dispose());
      delete object.userData.transientMaterial;
    }
    if (upper && opacity < 1) {
      object.castShadow = false;
      object.receiveShadow = false;
      // Repeated thick outline passes would darken ghost edges and obscure the
      // interior. Keep translucent upper layers as quiet silhouettes.
      if (object.isLineSegments) object.visible = false;
    }
  });
  root.userData.cutawayMaterials = [...copies.values()];
}
