// Renderer-only visual definitions. Values are normalized from
// MazeBenchEngine/public/play-render-three.js (TILE_SIZE == one world unit).

import { colorForDefinition } from "./world-renderer.mjs";
import { FLOOR_DROP, FLOOR_THICKNESS } from "./polycube-mesh.mjs";

export const PLATE_THICKNESS = 4 / 64;
export const PLATE_OFFSET = 0.012;
export const FLOATING_FLOOR_HEIGHT = 0.32;
export const ORANGE_BUTTON_HEIGHT = 0.12;
export const ORANGE_BUTTON_RADIUS = 0.21;
export const PUNCHER_RADIUS = 0.34;
export const PUNCHER_DEPTH = 0.13;

const FLOOR_TYPES = new Set(["floor", "ice", "exit"]);

export function terrainPieceDefinition(layer) {
  const elevation = layer.elevation || 0;
  const color = colorForDefinition(layer);
  if (FLOOR_TYPES.has(layer.type) && elevation === 0) {
    return {
      kind: "floor",
      bottom: -FLOOR_DROP - FLOOR_THICKNESS,
      top: -FLOOR_DROP,
      color,
      editorGrid: layer.type === "floor" || layer.type === "exit",
      exitMarker: layer.type === "exit"
    };
  }
  if (layer.modelUrl) {
    return {
      kind: "terrain_asset",
      bottom: elevation,
      top: elevation + (layer.type === "tree" ? 3 : 1),
      fallbackHeight: layer.type === "tree" ? 3 : 1,
      color
    };
  }
  if (layer.type === "ice_slope" || layer.type === "orange_ice_slope") {
    return { kind: "slope", bottom: elevation, top: elevation + 1, color };
  }
  if (layer.type === "player_gate") {
    return layer.raised
      ? { kind: "gate", bottom: elevation, top: elevation + 1, color, raised: true }
      : {
          kind: "gate",
          bottom: elevation + PLATE_OFFSET - PLATE_THICKNESS,
          top: elevation + PLATE_OFFSET,
          color,
          raised: false
        };
  }
  if (layer.type === "player_lift") {
    return layer.raised
      ? { kind: "raised_lift", bottom: elevation, top: elevation + 1, color, marker: "up" }
      : {
          kind: "lowered_lift",
          bottom: elevation + PLATE_OFFSET - PLATE_THICKNESS,
          top: elevation + PLATE_OFFSET,
          color,
          marker: "down"
        };
  }
  return { kind: "cube", bottom: elevation, top: elevation + 1, height: 1, color };
}

export function actorPieceDefinition(actor) {
  const elevation = actor.elevation || 0;
  const color = colorForDefinition(actor);
  if (actor.modelUrl) return { kind: "gem_asset", bottom: elevation, top: elevation + 1, color };
  if (actor.type === "orange_button") {
    return { kind: "orange_button", bottom: elevation, top: elevation + ORANGE_BUTTON_HEIGHT, color };
  }
  if (actor.type === "puncher") {
    return {
      kind: "puncher",
      bottom: elevation,
      top: elevation + 0.88,
      color,
      sprung: actor.sprung === true
    };
  }
  if (actor.shape === "slope") {
    return { kind: "slope", bottom: elevation, top: elevation + 1, color };
  }
  if (actor.type === "floating_floor") {
    return {
      kind: "floating_floor",
      bottom: elevation,
      top: elevation + FLOATING_FLOOR_HEIGHT,
      color
    };
  }
  if (actor.type === "attached_gate") {
    return actor.raised
      ? { kind: "gate", bottom: elevation, top: elevation + 1, color, raised: true }
      : {
          kind: "gate",
          bottom: elevation + PLATE_OFFSET - PLATE_THICKNESS,
          top: elevation + PLATE_OFFSET,
          color,
          raised: false
        };
  }
  if (actor.type === "attached_lift") {
    return actor.raised
      ? { kind: "raised_lift", bottom: elevation, top: elevation + 1, color, marker: "up" }
      : {
          kind: "lowered_lift",
          bottom: elevation + PLATE_OFFSET - PLATE_THICKNESS,
          top: elevation + PLATE_OFFSET,
          color,
          marker: "down"
        };
  }
  return { kind: "cube", bottom: elevation, top: elevation + 1, height: 1, color };
}
