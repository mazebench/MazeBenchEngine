// Face-normal placement and visual metadata adapted from
// MazeBenchEngineUnitTest's editorPaintTarget and visualVariants modules.

const DIRECTION_INDEX = Object.freeze({ up: 0, right: 1, down: 2, left: 3 });
const SIDE_ORIENTATION_INDEX = Object.freeze({ top: 0, north: 1, east: 2, south: 3, west: 4, bottom: 5 });
const BASE_LAYER_BLOCKS = new Set(["floor", "ice-floor", "exit"]);

export function editorPaintLayer(blockId, proposedLayer, strokeLayer = null) {
  if (BASE_LAYER_BLOCKS.has(blockId)) return 0;
  return Number.isInteger(strokeLayer) ? strokeLayer : proposedLayer;
}

export function resolveEditorPaintTargetV2(
  target,
  { erase = false, replace = false, selectedCanShare = false } = {}
) {
  const addToActorCell = !erase && !replace && selectedCanShare && target?.kind === "actor";
  const useSource = erase || replace || addToActorCell;
  return {
    x: useSource ? target.sourceX : target.paintX,
    y: useSource ? target.sourceY : target.paintY,
    z: useSource ? target.sourceZ : target.paintZ
  };
}

export function editorEraseRowKey(target) {
  const coordinate = resolveEditorPaintTargetV2(target, { erase: true });
  const blockId = target?.object?.blockId ?? target?.block?.id;
  const rowKind = BASE_LAYER_BLOCKS.has(blockId) ? "surface" : "object";
  return `${coordinate.z}:${rowKind}`;
}

export function resolveEditorEraseTargetV2(target, strokeRowKey = null) {
  const coordinate = resolveEditorPaintTargetV2(target, { erase: true });
  if (strokeRowKey !== null && editorEraseRowKey(target) !== strokeRowKey) return null;
  return coordinate;
}

export function orientationFromPaintFace(target, allowBottom = false) {
  if (target?.face === "bottom-face") return allowBottom ? "bottom" : null;
  const dx = Math.sign(Number(target?.dx) || 0);
  const dy = Math.sign(Number(target?.dy) || 0);
  if (dx > 0) return "east";
  if (dx < 0) return "west";
  if (dy > 0) return "south";
  if (dy < 0) return "north";
  return "top";
}

function groupNumber(token) {
  const match = /(\d+)$/.exec(token);
  return match ? Number(match[1]) : undefined;
}

function normalizedPuncherDirection(target, cameraDirections) {
  const faceOrientation = orientationFromPaintFace(target, false);
  const aliases = { north: "up", east: "right", south: "down", west: "left" };
  return aliases[faceOrientation] ||
    (DIRECTION_INDEX[cameraDirections?.near] !== undefined ? cameraDirections.near : "right");
}

function placementIdentity(token) {
  if (token === ".") return { blockId: "floor" };
  if (token === "i") return { blockId: "ice-floor" };
  if (token === "#") return { blockId: "wall" };
  if (token === "I") return { blockId: "ice-block" };
  if (/^S[rlud]#$/.test(token)) return { blockId: "wall-slope", slope: true };
  if (/^S[rlud]O$/.test(token)) return { blockId: "orange-slope", slope: true };
  if (/^S[rlud]M\d+$/.test(token)) return { blockId: "weightless-slope", slope: true, groupId: groupNumber(token) };
  if (/^S[rlud]c\d+$/.test(token)) return { blockId: "clone-slope", slope: true, groupId: groupNumber(token) };
  if (/^S[rlud]$/.test(token)) return { blockId: "ice-slope", slope: true };
  if (token === "p") return { blockId: "player" };
  if (/^c\d+$/.test(token)) return { blockId: "clone", groupId: groupNumber(token) };
  if (token === "G") return { blockId: "gem" };
  if (token === "g") return { blockId: "gate" };
  if (token === "l" || token === "L") return { blockId: "lift", lift: true, stateId: token === "L" ? 1 : 0 };
  if (token === "O") return { blockId: "orange-wall" };
  if (token === "o") return { blockId: "orange-button", button: true };
  if (/^[pP][rlud]$/.test(token)) {
    return { blockId: "puncher", puncher: true, stateId: token[0] === "P" ? 1 : 0 };
  }
  if (token === "b") return { blockId: "crate" };
  if (token === "f") return { blockId: "floating-floor" };
  if (/^M\d+$/.test(token)) return { blockId: "weightless-box", groupId: groupNumber(token) };
  if (["t1", "t2", "t3", "t4", "st1", "st3", "st4", "sh", "b1", "b2", "b3", "b4"].includes(token)) {
    return { blockId: token };
  }
  if (token === "e") return { blockId: "exit" };
  return null;
}

export function voxelPlacementForTool(token, coordinate, target, cameraDirections) {
  const identity = placementIdentity(token);
  if (!identity) return null;
  const placement = {
    x: coordinate.x,
    y: coordinate.y,
    z: coordinate.z,
    blockId: identity.blockId
  };
  if (identity.groupId !== undefined) {
    placement.genericId = identity.groupId;
    placement.groupId = identity.groupId;
  }
  if (identity.slope) {
    placement.orientation = cameraDirections.far;
    placement.variantId = DIRECTION_INDEX[placement.orientation];
  } else if (identity.puncher) {
    placement.orientation = normalizedPuncherDirection(target, cameraDirections);
    placement.variantId = DIRECTION_INDEX[placement.orientation];
    placement.stateId = identity.stateId;
  } else if (identity.lift) {
    const orientation = orientationFromPaintFace(target, false);
    if (!orientation) return null;
    placement.orientation = orientation;
    placement.variantId = SIDE_ORIENTATION_INDEX[orientation];
    placement.stateId = identity.stateId;
  } else if (identity.button) {
    const orientation = orientationFromPaintFace(target, true);
    placement.orientation = orientation;
    placement.variantId = SIDE_ORIENTATION_INDEX[orientation];
  }
  return placement;
}

export function rotateVoxelObject(object, transform, width, height) {
  const next = { ...object };
  const directionMaps = {
    right: { up: "right", right: "down", down: "left", left: "up", north: "east", east: "south", south: "west", west: "north" },
    left: { up: "left", left: "down", down: "right", right: "up", north: "west", west: "south", south: "east", east: "north" },
    horizontal: { up: "up", down: "down", left: "right", right: "left", north: "north", south: "south", east: "west", west: "east" },
    vertical: { up: "down", down: "up", left: "left", right: "right", north: "south", south: "north", east: "east", west: "west" }
  };
  if (transform === "right") {
    next.x = height - 1 - object.y;
    next.y = object.x;
  } else if (transform === "left") {
    next.x = object.y;
    next.y = width - 1 - object.x;
  } else if (transform === "horizontal") {
    next.x = width - 1 - object.x;
  } else {
    next.y = height - 1 - object.y;
  }
  if (directionMaps[transform][object.orientation]) {
    next.orientation = directionMaps[transform][object.orientation];
    next.variantId = DIRECTION_INDEX[next.orientation] ?? SIDE_ORIENTATION_INDEX[next.orientation] ?? 0;
  }
  return next;
}
