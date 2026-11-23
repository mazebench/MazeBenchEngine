// Lossless semantic migration from the legacy layered text parser into the
// explicit object coordinates used by MazeBench voxel room v2.

import { parseCellState } from "./world-renderer.mjs";

const DIRECTION_INDEX = Object.freeze({ up: 0, right: 1, down: 2, left: 3 });

function numericGroup(value) {
  const match = /(-?\d+)$/.exec(String(value || ""));
  return match ? Number(match[1]) : undefined;
}

function layerBlockId(layer) {
  if (["t1", "t2", "t3", "t4", "st1", "st3", "st4", "sh", "b1", "b2", "b3", "b4"].includes(layer.token)) {
    return layer.token;
  }
  if (layer.type === "floor") return "floor";
  if (layer.type === "ice") return "ice-floor";
  if (layer.type === "exit") return "exit";
  if (layer.type === "wall") return "wall";
  if (layer.type === "ice_block") return "ice-block";
  if (layer.type === "ice_slope") return layer.styleKey === "wall" ? "wall-slope" : "ice-slope";
  if (layer.type === "orange_ice_slope") return "orange-slope";
  if (layer.type === "player_gate") return "gate";
  if (layer.type === "player_lift") return "lift";
  if (layer.type === "orange_wall") return "orange-wall";
  return "wall";
}

function actorBlockId(actor) {
  if (actor.type === "player") return "player";
  if (actor.type === "clone") return actor.shape === "slope" ? "clone-slope" : "clone";
  if (actor.type === "gem") return "gem";
  if (actor.type === "orange_button") return "orange-button";
  if (actor.type === "puncher") return "puncher";
  if (actor.type === "box") return "crate";
  if (actor.type === "floating_floor") return "floating-floor";
  if (actor.type === "weightless_box") return actor.shape === "slope" ? "weightless-slope" : "weightless-box";
  if (actor.type === "attached_gate") return "gate";
  if (actor.type === "attached_lift") return "lift";
  return "crate";
}

function metadataFor(source) {
  const object = {};
  const orientation = source.direction || (source.type === "player_lift" || source.type === "attached_lift" || source.type === "orange_button"
    ? "top"
    : undefined);
  if (orientation) {
    object.orientation = orientation;
    object.variantId = DIRECTION_INDEX[orientation] ?? 0;
  }
  const groupId = numericGroup(source.groupId || source.token);
  if (["clone", "weightless_box"].includes(source.type) && groupId !== undefined) {
    object.genericId = groupId;
    object.groupId = groupId;
  }
  if (["player_lift", "attached_lift"].includes(source.type)) {
    object.stateId = source.raised === true ? 1 : 0;
  }
  if (source.type === "puncher") {
    object.stateId = source.sprung === true ? 1 : 0;
  }
  return object;
}

export function legacyCellsToVoxelObjects(cells) {
  const objects = [];
  cells.forEach((row, y) => row.forEach((rawCell, x) => {
    const state = parseCellState(rawCell);
    state.layers.forEach((layer) => {
      objects.push({
        x,
        y,
        z: Math.floor(layer.elevation || 0),
        blockId: layerBlockId(layer),
        ...metadataFor(layer)
      });
    });
    state.actors.forEach((actor) => {
      objects.push({
        x,
        y,
        z: Math.floor(actor.elevation || 0),
        blockId: actorBlockId(actor),
        ...metadataFor(actor)
      });
    });
  }));
  return objects;
}
