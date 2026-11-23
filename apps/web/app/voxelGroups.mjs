import { cellObjectSelectionKey, objectCanShareCell } from "./cellObjects.mjs";

/** @typedef {{ x: number, y: number, z: number, blockId: string, genericId?: number, groupId?: number, instanceId?: string, stateId?: number, variantId?: number, orientation?: string }} Voxel */
/** @typedef {Map<string, { roleId: string, occupancy?: string, visual?: { kind?: string } }>} BlockDefinitions */
/** @typedef {{ width: number, height: number }} HorizontalWorld */

const FACE_NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * @param {{ x: number, y: number, z: number }} voxel
 */
export function voxelCoordinateKey(voxel) {
  return `${voxel.x},${voxel.y},${voxel.z}`;
}

function voxelCanShareCell(voxel, shareableBlockIds, definitions) {
  return definitions instanceof Map
    ? objectCanShareCell(definitions.get(voxel.blockId), voxel)
    : shareableBlockIds.has(voxel.blockId);
}

function genericObjectGroupId(voxel) {
  return Number.isInteger(voxel.groupId)
    ? voxel.groupId
    : Number.isInteger(voxel.genericId) ? voxel.genericId : -1;
}

function connectedFamilyIdentity(voxel, definitions) {
  if (!(definitions instanceof Map)) return null;
  const definition = definitions.get(voxel.blockId);
  if (!definition || (definition.visual?.kind !== "cube" && definition.visual?.kind !== "slope")) {
    return null;
  }
  if (definition.roleId === "ice") return "ice";
  if (definition.roleId !== "weightless-pushable" && definition.roleId !== "clone") {
    return null;
  }
  const groupId = genericObjectGroupId(voxel);
  return groupId >= 0 ? `${definition.roleId}:${groupId}` : null;
}

/**
 * Selects the complete six-neighbor component containing `origin`. Numbered
 * rigid box/clone families use role + object ID as their identity, allowing a
 * cube and any directional slopes to form one selectable polycube. Static Ice
 * cubes and slopes likewise form one connected terrain family. Other authored
 * objects retain exact block, variant, state, and orientation identity.
 *
 * @param {Voxel[]} voxels
 * @param {{ x: number, y: number, z: number, selectionKey?: string }} origin
 * @param {Set<string>} [shareableBlockIds]
 * @param {BlockDefinitions | null} [definitions]
 * @returns {string[]}
 */
export function selectConnectedVoxelGroup(
  voxels,
  origin,
  shareableBlockIds = new Set(),
  definitions = null,
) {
  const voxelsByCoordinate = new Map();
  for (const voxel of voxels) {
    const key = voxelCoordinateKey(voxel);
    const occupants = voxelsByCoordinate.get(key) ?? [];
    occupants.push(voxel);
    voxelsByCoordinate.set(key, occupants);
  }
  const originOccupants = voxelsByCoordinate.get(voxelCoordinateKey(origin)) ?? [];
  const first = origin.selectionKey
    ? voxels.find((voxel) => cellObjectSelectionKey(voxel) === origin.selectionKey)
    : originOccupants.find((voxel) =>
      !voxelCanShareCell(voxel, shareableBlockIds, definitions)) ??
      originOccupants.at(-1);
  if (!first) return [];

  const groupId = genericObjectGroupId(first);
  const firstDefinition = definitions instanceof Map
    ? definitions.get(first.blockId)
    : null;
  if (firstDefinition?.roleId === "player-lift") {
    return [cellObjectSelectionKey(first)];
  }
  const connectedFamily = connectedFamilyIdentity(first, definitions);
  const variantId = Number.isInteger(first.variantId) ? first.variantId : 0;
  const stateId = Number.isInteger(first.stateId) ? first.stateId : 0;
  const orientation = String(first.orientation ?? "none");
  const selected = new Set([cellObjectSelectionKey(first)]);
  const pending = [first];

  while (pending.length) {
    const voxel = pending.pop();
    if (!voxel) break;
    for (const [dx, dy, dz] of FACE_NEIGHBORS) {
      const candidates = voxelsByCoordinate.get(
        `${voxel.x + dx},${voxel.y + dy},${voxel.z + dz}`,
      ) ?? [];
      const neighbor = candidates.find((candidate) => {
        const candidateGroupId = genericObjectGroupId(candidate);
        const sameConnectedFamily = connectedFamily !== null &&
          connectedFamilyIdentity(candidate, definitions) === connectedFamily;
        const sameExactType = candidate.blockId === first.blockId && candidateGroupId === groupId &&
          (Number.isInteger(candidate.variantId) ? candidate.variantId : 0) === variantId &&
          (Number.isInteger(candidate.stateId) ? candidate.stateId : 0) === stateId &&
          String(candidate.orientation ?? "none") === orientation;
        return (sameConnectedFamily || sameExactType) &&
          !selected.has(cellObjectSelectionKey(candidate));
      });
      if (!neighbor) continue;
      selected.add(cellObjectSelectionKey(neighbor));
      pending.push(neighbor);
    }
  }

  return [...selected];
}

/**
 * Select a group, or remove the complete group when it is already selected.
 * Additive selection preserves other groups; a normal new selection replaces
 * them.
 *
 * @param {Iterable<string>} currentCoordinateKeys
 * @param {Iterable<string>} groupCoordinateKeys
 * @param {boolean} additive
 * @returns {{ deselected: boolean, keys: string[] }}
 */
export function toggleVoxelGroupSelection(currentCoordinateKeys, groupCoordinateKeys, additive) {
  const currentKeys = [...currentCoordinateKeys];
  const groupKeys = [...groupCoordinateKeys];
  const current = new Set(currentKeys);
  const deselected = groupKeys.length > 0 && groupKeys.every((key) => current.has(key));

  if (deselected) {
    const group = new Set(groupKeys);
    return { deselected: true, keys: currentKeys.filter((key) => !group.has(key)) };
  }

  return {
    deselected: false,
    keys: [...new Set([...(additive ? currentKeys : []), ...groupKeys])],
  };
}

/**
 * Remove every voxel whose coordinate is in the current group selection.
 *
 * @param {Voxel[]} voxels
 * @param {Iterable<string>} selectedCoordinateKeys
 * @returns {{ removedCount: number, voxels: Voxel[] }}
 */
export function removeSelectedVoxels(voxels, selectedCoordinateKeys) {
  const selected = new Set(selectedCoordinateKeys);
  const remaining = voxels.filter((voxel) => !selected.has(cellObjectSelectionKey(voxel)));
  return {
    removedCount: voxels.length - remaining.length,
    voxels: remaining.map((voxel) => ({ ...voxel })),
  };
}

/**
 * Moves a selected component one cell if the complete destination is valid.
 * Horizontal room bounds are enforced; Z is deliberately unbounded.
 *
 * @param {Voxel[]} voxels
 * @param {Iterable<string>} selectedCoordinateKeys
 * @param {number} dx
 * @param {number} dy
 * @param {HorizontalWorld} world
 * @param {number} [dz]
 * @param {Set<string>} [shareableBlockIds]
 * @param {BlockDefinitions | null} [definitions]
 * @returns {{ moved: boolean, selectedKeys: string[], voxels: Voxel[] }}
 */
export function moveVoxelGroup(
  voxels,
  selectedCoordinateKeys,
  dx,
  dy,
  world,
  dz = 0,
  shareableBlockIds = new Set(),
  definitions = null,
) {
  const selected = new Set(selectedCoordinateKeys);
  const moving = voxels.filter((voxel) => selected.has(cellObjectSelectionKey(voxel)));
  if (!moving.length || (dx === 0 && dy === 0 && dz === 0)) {
    return { moved: false, selectedKeys: [...selected], voxels: voxels.map((voxel) => ({ ...voxel })) };
  }

  const stationarySolidCoordinates = new Set(
    voxels
      .filter((voxel) =>
        !selected.has(cellObjectSelectionKey(voxel)) &&
        !voxelCanShareCell(voxel, shareableBlockIds, definitions))
      .map(voxelCoordinateKey),
  );
  const destinations = moving.map((voxel) => ({
    ...voxel,
    x: voxel.x + dx,
    y: voxel.y + dy,
    z: voxel.z + dz,
  }));
  const blocked = destinations.some((voxel) =>
    voxel.x < 0 ||
    voxel.x >= world.width ||
    voxel.y < 0 ||
    voxel.y >= world.height ||
    (!voxelCanShareCell(voxel, shareableBlockIds, definitions) &&
      stationarySolidCoordinates.has(voxelCoordinateKey(voxel))),
  );
  if (blocked) {
    return { moved: false, selectedKeys: [...selected], voxels: voxels.map((voxel) => ({ ...voxel })) };
  }

  const movedBySource = new Map(
    moving.map((voxel, index) => [cellObjectSelectionKey(voxel), destinations[index]]),
  );
  return {
    moved: true,
    selectedKeys: destinations.map(cellObjectSelectionKey),
    voxels: voxels.map((voxel) => movedBySource.get(cellObjectSelectionKey(voxel)) ?? { ...voxel }),
  };
}
