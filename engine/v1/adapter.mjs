// Storage-v2 <-> MazeBenchEngineUnitTest's compact C++ ABI.
// The engine stores five int32 values per object: x, y, z, role hash, metadata.

export const ENGINE_V1_ABI = 4;
export const ENGINE_V1_VOXEL_STRIDE = 5;
export const ENGINE_V1_DIRECTIONS = Object.freeze(["up", "right", "down", "left"]);

const SLOPE_DIRECTIONS = ENGINE_V1_DIRECTIONS;
const LIFT_ORIENTATIONS = ["top", "north", "east", "south", "west"];
const BUTTON_ORIENTATIONS = [...LIFT_ORIENTATIONS, "bottom"];
const GENERIC_ROLES = new Set(["weightless-pushable", "clone"]);
const ENGINE_FALL_Z = -2_147_483_648;
const ORANGE_SCOPE_FLAG = 1 << 30;
const ORANGE_SCOPE_SHIFT = 17;
const ORANGE_VALUE_MASK = (1 << ORANGE_SCOPE_SHIFT) - 1;
const CLONE_NO_COMMAND_FLAG = 1 << 30;
const PLAYER_ROOM_GRID_FLAG = 1 << 30;
const ROOM_GRID_DIMENSION_BITS = 15;
const ROOM_GRID_DIMENSION_MASK = (1 << ROOM_GRID_DIMENSION_BITS) - 1;

function scopedOrangeId(object, value) {
  const scope = object.connectedWorldOrangeScope;
  if (scope === undefined) return value;
  if (!Number.isInteger(scope) || scope < 1 || scope >= (1 << 13) ||
      !Number.isInteger(value) || value < 0 || value > ORANGE_VALUE_MASK) {
    throw new Error("Invalid connected-room orange mechanism scope or state.");
  }
  return ORANGE_SCOPE_FLAG | (scope << ORANGE_SCOPE_SHIFT) | value;
}

function localOrangeId(value) {
  return value >= 0 && (value & ORANGE_SCOPE_FLAG) !== 0
    ? value & ORANGE_VALUE_MASK : value;
}

function definitionMap(definitions) {
  return definitions instanceof Map
    ? definitions
    : new Map((definitions || []).map((definition) => [definition.id, definition]));
}

function normalizedIndex(value, length) {
  const number = Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0;
  return ((number % length) + length) % length;
}

function normalizeSlopeDirection(object) {
  const aliases = { north: "up", east: "right", south: "down", west: "left" };
  const candidate = String(object.orientation || "").toLowerCase();
  const direction = aliases[candidate] || candidate;
  return SLOPE_DIRECTIONS.includes(direction)
    ? direction
    : SLOPE_DIRECTIONS[normalizedIndex(object.variantId, 4)];
}

function normalizeLiftOrientation(object) {
  const aliases = { up: "top", front: "north", right: "east", back: "south", left: "west" };
  const candidate = String(object.orientation || "").toLowerCase();
  const orientation = aliases[candidate] || candidate;
  return LIFT_ORIENTATIONS.includes(orientation)
    ? orientation
    : LIFT_ORIENTATIONS[normalizedIndex(object.variantId, LIFT_ORIENTATIONS.length)];
}

function normalizeButtonOrientation(object) {
  const candidate = String(object.orientation || "").toLowerCase();
  const aliases = {
    up: "top", front: "north", right: "east", back: "south", left: "west",
    down: "bottom", ceiling: "bottom"
  };
  const orientation = aliases[candidate] || candidate;
  return BUTTON_ORIENTATIONS.includes(orientation)
    ? orientation
    : BUTTON_ORIENTATIONS[normalizedIndex(object.variantId, BUTTON_ORIENTATIONS.length)];
}

function slopeRoleId(baseRoleId, direction) {
  if (baseRoleId === "weightless-pushable") return `blue-box-slope-${direction}`;
  if (baseRoleId === "clone") return `yellow-clone-slope-${direction}`;
  return `ice-slope-${direction}`;
}

export function engineRoleIdForObject(object, definitions) {
  const block = definitionMap(definitions).get(object.blockId);
  if (!block) return "solid";
  if (block.visual?.kind === "slope") {
    return slopeRoleId(block.roleId, normalizeSlopeDirection(object));
  }
  // Older v2 manifests called this role "gate". The canonical engine role is
  // now "player-gate"; keying off the visual keeps those rooms compatible.
  if (block.visual?.kind === "gate") return "player-gate";
  // Storage v2 treats floor/exit z=0 as a surface. Exit markers still need
  // ordinary support physics, not a full blocking cube at the player's z.
  if (block.visual?.kind === "exit") return "floor";
  return block.roleId || "solid";
}

function engineZForObject(object, block) {
  // Storage v2 records a surface and an actor standing on it at the same z.
  // The C++ engine records the surface at z and the actor at z + 1.
  if (block?.visual?.kind === "floor" || block?.visual?.kind === "exit") {
    return object.z;
  }
  if (block?.roleId === "orange-wall") {
    return object.z + Math.max(0, Math.floor(Number(object.mechanismDepth) || 0)) + 1;
  }
  return object.z + 1;
}

function visualZForObject(engineZ, block, engineGenericId, filledFloatingFloor = false) {
  if (engineZ === ENGINE_FALL_Z) return engineZ;
  if (filledFloatingFloor || block?.visual?.kind === "floor" || block?.visual?.kind === "exit") {
    return engineZ;
  }
  if (block?.roleId === "orange-wall") {
    return engineZ - Math.max(0, engineGenericId) - 1;
  }
  return engineZ - 1;
}

function encodedLiftId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  const orientation = LIFT_ORIENTATIONS.indexOf(normalizeLiftOrientation(object));
  const raised = object.stateId === 1 || (Number.isInteger(object.genericId) && object.genericId % 2 === 1);
  return Math.max(0, orientation) * 2 + (raised ? 1 : 0);
}

function encodedButtonId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  const orientation = BUTTON_ORIENTATIONS.indexOf(normalizeButtonOrientation(object));
  return Math.max(0, orientation) * 2;
}

function encodedGateId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  return object.stateId === 1 || object.genericId === 1 ? 1 : 0;
}

function encodedPuncherId(object) {
  if (Number.isInteger(object.engineGenericId)) return object.engineGenericId;
  const direction = SLOPE_DIRECTIONS.indexOf(normalizeSlopeDirection(object));
  const sprung = object.stateId === 1 || object.genericId === 1;
  return Math.max(0, direction) * 2 + (sprung ? 1 : 0);
}

export function engineGenericIdForObject(object, definitions) {
  const block = definitionMap(definitions).get(object.blockId);
  if (!block) return -1;
  if (block.roleId === "player" && object.connectedWorldRoomWidth !== undefined) {
    const width = object.connectedWorldRoomWidth;
    const height = object.connectedWorldRoomHeight;
    if (!Number.isInteger(width) || width < 1 || width > ROOM_GRID_DIMENSION_MASK ||
        !Number.isInteger(height) || height < 1 || height > ROOM_GRID_DIMENSION_MASK) {
      throw new Error("Invalid connected-room grid dimensions.");
    }
    return PLAYER_ROOM_GRID_FLAG | (height << ROOM_GRID_DIMENSION_BITS) | width;
  }
  if (block.roleId === "player-lift") return encodedLiftId(object);
  if (block.visual?.kind === "gate" || block.roleId === "player-gate") return encodedGateId(object);
  if (block.roleId === "orange-button") return scopedOrangeId(object, encodedButtonId(object));
  if (block.roleId === "orange-wall") {
    return scopedOrangeId(object, Math.max(0, Math.floor(Number(object.mechanismDepth ?? object.stateId) || 0)));
  }
  if (block.visual?.kind === "puncher" || block.roleId === "puncher") {
    return encodedPuncherId(object);
  }
  if (GENERIC_ROLES.has(block.roleId)) {
    if (Number.isInteger(object.connectedWorldBodyGroup)) {
      return object.connectedWorldBodyGroup |
        (block.roleId === "clone" && object.connectedWorldCloneCommandDisabled ? CLONE_NO_COMMAND_FLAG : 0);
    }
    return Number.isInteger(object.groupId)
      ? object.groupId
      : Number.isInteger(object.genericId) ? object.genericId : 0;
  }
  return Number.isInteger(object.genericId) ? object.genericId : -1;
}

export function engineStatesEqualV1(left, right, definitions) {
  if (left.width !== right.width || left.height !== right.height ||
      left.objects.length !== right.objects.length) return false;
  const blocks = definitionMap(definitions);
  return left.objects.every((object, index) => {
    const other = right.objects[index];
    const block = blocks.get(object.blockId);
    const otherBlock = blocks.get(other.blockId);
    return object.x === other.x && object.y === other.y &&
      engineZForObject(object, block) === engineZForObject(other, otherBlock) &&
      engineRoleIdForObject(object, blocks) === engineRoleIdForObject(other, blocks) &&
      engineGenericIdForObject(object, blocks) === engineGenericIdForObject(other, blocks);
  });
}

export function createEngineStateV1(room) {
  return {
    width: room.width,
    height: room.height,
    objects: (room.objects || []).map((object) => ({ ...object }))
  };
}

function solidModelHeight(block) {
  if (block?.roleId !== "solid" || block.visual?.kind !== "model") return 1;
  const height = Number(block.visual.height);
  return Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
}

export function engineVoxelCountV1(state, definitions) {
  const blocks = definitionMap(definitions);
  return state.objects.reduce((count, object) =>
    count + solidModelHeight(blocks.get(object.blockId)), 0);
}

// Model height is host metadata: C++ receives only unit voxels. Append the
// upper wall cells after every authored object so existing indices, mechanism
// identities and dynamic-prefix layouts stay stable. Readback uses the original
// template, keeping these collision-only cells out of rendering and saves.
export function engineCollisionStateV1(state, definitions) {
  const blocks = definitionMap(definitions);
  const upperWalls = [];
  for (const object of state.objects) {
    const height = solidModelHeight(blocks.get(object.blockId));
    for (let dz = 1; dz < height; ++dz) {
      upperWalls.push({ ...object, z: object.z + dz });
    }
  }
  return upperWalls.length ? { ...state, objects: [...state.objects, ...upperWalls] } : state;
}

export function writeEngineStateV1(state, definitions, roleCode, buffer, stride) {
  const blocks = definitionMap(definitions);
  state.objects.forEach((object, index) => {
    const block = blocks.get(object.blockId);
    const offset = index * stride;
    buffer[offset] = object.x;
    buffer[offset + 1] = object.y;
    buffer[offset + 2] = engineZForObject(object, block);
    buffer[offset + 3] = roleCode(engineRoleIdForObject(object, blocks));
    buffer[offset + 4] = engineGenericIdForObject(object, blocks);
  });
}

export function readEngineStateV1(template, definitions, buffer, stride) {
  const blocks = definitionMap(definitions);
  const floorBlockId = [...blocks.values()].find((block) => block.roleId === "floor")?.id;
  const objects = template.objects.map((object, index) => {
    const block = blocks.get(object.blockId);
    const offset = index * stride;
    const rawGenericId = buffer[offset + 4];
    const engineGenericId = block?.roleId === "orange-button" || block?.roleId === "orange-wall"
      ? localOrangeId(rawGenericId) : rawGenericId;
    const filledFloatingFloor = block?.roleId === "floating-floor" && engineGenericId === 1;
    const next = {
      ...object,
      ...(filledFloatingFloor && floorBlockId ? { blockId: floorBlockId } : {}),
      x: buffer[offset],
      y: buffer[offset + 1],
      z: visualZForObject(buffer[offset + 2], block, engineGenericId, filledFloatingFloor)
    };
    if (block?.roleId === "player-lift") {
      const id = Math.max(0, Math.min(9, engineGenericId));
      next.engineGenericId = id;
      next.genericId = id;
      next.groupId = id;
      next.orientation = LIFT_ORIENTATIONS[Math.floor(id / 2)];
      next.variantId = Math.floor(id / 2);
      next.stateId = id % 2;
    } else if (block?.roleId === "orange-button") {
      const id = Math.max(0, Math.min(11, engineGenericId));
      next.engineGenericId = id;
      next.orientation = BUTTON_ORIENTATIONS[Math.floor(id / 2)];
      next.variantId = Math.floor(id / 2);
      next.engineHidden = (id & 1) === 1;
    } else if (block?.visual?.kind === "gate" || block?.roleId === "player-gate") {
      const id = engineGenericId === 1 ? 1 : 0;
      next.engineGenericId = id;
      next.genericId = id;
      next.stateId = id;
    } else if (block?.roleId === "orange-wall") {
      next.mechanismDepth = Math.max(0, engineGenericId);
      next.stateId = 1;
    } else if (block?.visual?.kind === "puncher" || block?.roleId === "puncher") {
      const id = Math.max(0, Math.min(7, engineGenericId));
      const direction = Math.floor(id / 2);
      next.engineGenericId = id;
      next.genericId = id % 2;
      next.orientation = SLOPE_DIRECTIONS[direction];
      next.variantId = direction;
      next.stateId = id % 2;
    } else if (GENERIC_ROLES.has(block?.roleId)) {
      // Connected layouts assign temporary rigid-body IDs across rooms. Keep
      // authored IDs in readback so neither the namespace nor the input tag
      // escapes into rendering, saves, undo, or the next room's command.
      const id = Number.isInteger(object.connectedWorldBodyGroup)
        ? Number.isInteger(object.groupId) ? object.groupId : object.genericId ?? 0
        : engineGenericId;
      next.genericId = id;
      next.groupId = id;
    }
    return next;
  });
  return { width: template.width, height: template.height, objects };
}

export function activeEngineObjectsV1(state) {
  return state.objects
    .filter((object) => object.x >= 0 && object.y >= 0 &&
      object.x < state.width && object.y < state.height && !object.engineHidden)
    .map(({ engineGenericId, engineHidden, ...object }) => ({ ...object }));
}

export function roomFromEngineStateV1(state, room) {
  return {
    ...room,
    width: state.width,
    height: state.height,
    objects: activeEngineObjectsV1(state)
  };
}

export function countActiveRoleV1(state, definitions, roleId) {
  const blocks = definitionMap(definitions);
  return state.objects.filter((object) =>
    object.x >= 0 && object.y >= 0 && object.x < state.width && object.y < state.height &&
    blocks.get(object.blockId)?.roleId === roleId).length;
}

export function normalizeEngineDirectionV1(direction) {
  if (Number.isInteger(direction) && direction >= 0 && direction < 4) return direction;
  const index = ENGINE_V1_DIRECTIONS.indexOf(String(direction).toLowerCase());
  if (index < 0) throw new Error(`Unknown engine direction: ${direction}`);
  return index;
}
