export const SLOPE_DIRECTIONS = ["up", "right", "down", "left"];
export const LIFT_ORIENTATIONS = ["top", "north", "east", "south", "west"];
export const BUTTON_ORIENTATIONS = ["top", "north", "east", "south", "west", "bottom"];
export const LIFT_GENERIC_MAX = 9;
export const GATE_GENERIC_MAX = 1;
export const PUNCHER_GENERIC_MAX = 1;

const DIRECTION_ALIASES = new Map([
  ["north", "up"],
  ["east", "right"],
  ["south", "down"],
  ["west", "left"],
  ["u", "up"],
  ["r", "right"],
  ["d", "down"],
  ["l", "left"],
]);

const LIFT_ORIENTATION_ALIASES = new Map([
  ["up", "top"],
  ["upward", "top"],
  ["floor", "top"],
  ["front", "north"],
  ["right", "east"],
  ["back", "south"],
  ["left", "west"],
]);

export function normalizeSlopeDirection(orientation, variantId = 0) {
  const candidate = String(orientation ?? "").trim().toLowerCase();
  const normalized = DIRECTION_ALIASES.get(candidate) ?? candidate;
  if (SLOPE_DIRECTIONS.includes(normalized)) return normalized;
  const index = Number.isInteger(Number(variantId)) ? Number(variantId) : 0;
  return SLOPE_DIRECTIONS[((index % 4) + 4) % 4];
}

export function slopeDirectionIndex(direction) {
  return SLOPE_DIRECTIONS.indexOf(normalizeSlopeDirection(direction));
}

export function offsetSlopeDirection(direction, offset) {
  const index = slopeDirectionIndex(direction);
  return SLOPE_DIRECTIONS[((index + offset) % 4 + 4) % 4];
}

export function rotateSlopeMetadata(voxel, quarterTurns) {
  const orientation = String(voxel?.orientation ?? "").trim().toLowerCase();
  const normalized = DIRECTION_ALIASES.get(orientation) ?? orientation;
  if (!SLOPE_DIRECTIONS.includes(normalized)) return { ...voxel };
  const nextDirection = offsetSlopeDirection(normalized, quarterTurns);
  return {
    ...voxel,
    orientation: nextDirection,
    variantId: slopeDirectionIndex(nextDirection),
  };
}

// Punchers use the same four horizontal directions as slopes, but unlike
// slopes their direction comes from the side face they are mounted on. The
// direction is the outward punch direction, not the supporting face normal's
// inverse.
export function puncherDirectionFromPaintFace(facePick = {}) {
  if (facePick?.face === "bottom-face") return null;
  const dx = Math.sign(Number(facePick?.dx) || 0);
  const dy = Math.sign(Number(facePick?.dy) || 0);
  if (dx > 0) return "right";
  if (dx < 0) return "left";
  if (dy > 0) return "down";
  if (dy < 0) return "up";
  return null;
}

export function rotatePuncherMetadata(voxel, quarterTurns) {
  return rotateSlopeMetadata(voxel, quarterTurns);
}

export function gateIsRaised(genericId = 0) {
  const id = Math.max(0, Math.min(GATE_GENERIC_MAX, Math.floor(Number(genericId) || 0)));
  return id === 1;
}

export function puncherIsSprung(genericId = 0) {
  const id = Math.max(0, Math.min(PUNCHER_GENERIC_MAX, Math.floor(Number(genericId) || 0)));
  return id === 1;
}

// The public project format keeps a puncher's visible binary state separate
// from its authored orientation. The compact C++ ABI has one mechanism word,
// so encode direction in the upper bits and sprung state in the low bit.
export function puncherMechanismId(direction, sprung = false) {
  return slopeDirectionIndex(direction) * 2 + (sprung ? 1 : 0);
}

export function puncherDirectionFromMechanismId(mechanismId = 0) {
  const id = Math.max(0, Math.min(7, Math.floor(Number(mechanismId) || 0)));
  return SLOPE_DIRECTIONS[Math.floor(id / 2)];
}

export function puncherIsSprungMechanismId(mechanismId = 0) {
  const id = Math.max(0, Math.min(7, Math.floor(Number(mechanismId) || 0)));
  return (id & 1) === 1;
}

export function liftIsRaised(genericId = 0) {
  const id = Math.max(0, Math.min(LIFT_GENERIC_MAX, Math.floor(Number(genericId) || 0)));
  return id % 2 === 1;
}

export function liftGenericId(orientation, raised = false) {
  return liftOrientationIndex(orientation) * 2 + (raised ? 1 : 0);
}

// Editor face picks are expressed in world coordinates, so this mapping stays
// correct regardless of the camera yaw. A bottom-face pick is deliberately not
// mapped: downward lifts do not exist in the authored 0–9 family yet.
export function liftOrientationFromPaintFace(facePick = {}) {
  if (facePick?.face === "bottom-face") return null;
  const dx = Math.sign(Number(facePick?.dx) || 0);
  const dy = Math.sign(Number(facePick?.dy) || 0);
  if (dx > 0) return "east";
  if (dx < 0) return "west";
  if (dy > 0) return "south";
  if (dy < 0) return "north";
  return "top";
}

// Orange buttons use the same face-normal convention as lifts, with the
// additional downward mounting that the lift family deliberately reserves.
export function buttonOrientationFromPaintFace(facePick = {}) {
  if (facePick?.face === "bottom-face") return "bottom";
  return liftOrientationFromPaintFace(facePick) ?? "top";
}

export function normalizeButtonOrientation(orientation, variantId = 0) {
  const candidate = String(orientation ?? "").trim().toLowerCase();
  const normalized = LIFT_ORIENTATION_ALIASES.get(candidate) ?? candidate;
  if (normalized === "down" || normalized === "downward" || normalized === "ceiling") {
    return "bottom";
  }
  if (BUTTON_ORIENTATIONS.includes(normalized)) return normalized;
  const index = Number.isInteger(Number(variantId)) ? Number(variantId) : 0;
  return BUTTON_ORIENTATIONS[
    ((index % BUTTON_ORIENTATIONS.length) + BUTTON_ORIENTATIONS.length) % BUTTON_ORIENTATIONS.length
  ];
}

export function buttonOrientationIndex(orientation) {
  return BUTTON_ORIENTATIONS.indexOf(normalizeButtonOrientation(orientation));
}

// The compact C++ ABI carries mechanism metadata in one integer. The upper
// bits preserve the established orientation encoding; the low bit records
// whether the sensor is folded into geometry and therefore invisible/inert.
export function buttonMechanismId(orientation, hidden = false) {
  return buttonOrientationIndex(orientation) * 2 + (hidden ? 1 : 0);
}

export function buttonIsHiddenMechanismId(mechanismId = 0) {
  const id = Math.max(0, Math.min(11, Math.floor(Number(mechanismId) || 0)));
  return (id & 1) === 1;
}

export function buttonOrientationFromMechanismId(mechanismId = 0) {
  const id = Math.max(0, Math.min(11, Math.floor(Number(mechanismId) || 0)));
  return BUTTON_ORIENTATIONS[Math.floor(id / 2)];
}

export function liftOrientationFromGenericId(genericId = 0) {
  const id = Math.max(0, Math.min(LIFT_GENERIC_MAX, Math.floor(Number(genericId) || 0)));
  return LIFT_ORIENTATIONS[Math.floor(id / 2)];
}

export function normalizeLiftOrientation(orientation, variantId = 0, genericId) {
  if (genericId !== undefined && genericId !== null) {
    return liftOrientationFromGenericId(genericId);
  }
  const candidate = String(orientation ?? "").trim().toLowerCase();
  const normalized = LIFT_ORIENTATION_ALIASES.get(candidate) ?? candidate;
  if (LIFT_ORIENTATIONS.includes(normalized)) return normalized;
  const index = Number.isInteger(Number(variantId)) ? Number(variantId) : 0;
  return LIFT_ORIENTATIONS[((index % LIFT_ORIENTATIONS.length) + LIFT_ORIENTATIONS.length) % LIFT_ORIENTATIONS.length];
}

export function liftOrientationIndex(orientation) {
  return LIFT_ORIENTATIONS.indexOf(normalizeLiftOrientation(orientation));
}

export function rotateLiftMetadata(voxel, quarterTurns) {
  const explicitOrientation = normalizeLiftOrientation(voxel?.orientation, voxel?.variantId);
  const hasEncodedOrientation = Number(voxel?.genericId) >= 2;
  const orientation = hasEncodedOrientation
    ? liftOrientationFromGenericId(voxel.genericId)
    : explicitOrientation;
  const raised = liftIsRaised(voxel?.genericId);
  if (orientation === "top") {
    const genericId = liftGenericId(orientation, raised);
    return {
      ...voxel,
      orientation,
      variantId: 0,
      ...(voxel?.genericId === undefined ? {} : { genericId }),
      ...(voxel?.groupId === undefined ? {} : { groupId: genericId }),
    };
  }
  const horizontal = LIFT_ORIENTATIONS.slice(1);
  const index = horizontal.indexOf(orientation);
  const turns = ((quarterTurns % 4) + 4) % 4;
  const nextOrientation = horizontal[(index + turns) % 4];
  const genericId = liftGenericId(nextOrientation, raised);
  return {
    ...voxel,
    orientation: nextOrientation,
    variantId: liftOrientationIndex(nextOrientation),
    ...(voxel?.genericId === undefined ? {} : { genericId }),
    ...(voxel?.groupId === undefined ? {} : { groupId: genericId }),
  };
}

export function rotateButtonMetadata(voxel, quarterTurns) {
  const orientation = normalizeButtonOrientation(voxel?.orientation, voxel?.variantId);
  if (orientation === "top" || orientation === "bottom") {
    return {
      ...voxel,
      orientation,
      variantId: buttonOrientationIndex(orientation),
    };
  }
  const horizontal = BUTTON_ORIENTATIONS.slice(1, 5);
  const index = horizontal.indexOf(orientation);
  const turns = ((quarterTurns % 4) + 4) % 4;
  const nextOrientation = horizontal[(index + turns) % 4];
  return {
    ...voxel,
    orientation: nextOrientation,
    variantId: buttonOrientationIndex(nextOrientation),
  };
}

export function rotateVoxelVisualMetadata(voxel, quarterTurns) {
  return voxel?.blockId === "player-lift"
    ? rotateLiftMetadata(voxel, quarterTurns)
    : voxel?.blockId === "orange-button" || voxel?.blockId === "orange-button-hidden"
      ? rotateButtonMetadata(voxel, quarterTurns)
    : voxel?.blockId === "puncher"
      ? rotatePuncherMetadata(voxel, quarterTurns)
    : rotateSlopeMetadata(voxel, quarterTurns);
}
