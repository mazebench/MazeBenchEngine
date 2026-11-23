// Static parsing extracted from MazeBenchEngine's server/maze-levels.js and
// public/maze-token-patterns.js at bac6efc9aef6cbf0812c4a57dccb1ad67a15c9ea.
// This module intentionally contains no game, solver, or physics code.

export const RENDERER_VERSION = 1;

export const MAZE_COLORS = Object.freeze({
  empty: "#050608",
  floor: "#d6bd94",
  wall: "#23262c",
  tree: "#2f7d3f",
  shrub: "#476b35",
  blockAsset: "#5b2f14",
  ice: "#a9d6f4",
  orange: "#b85f16",
  gate: "#c75652",
  lift: "#8a63d2",
  button: "#f59e0b",
  player: "#5aa95c",
  clone: "#b59a2a",
  weightless: "#315991",
  gem: "#6cd7ff",
  puncher: "#ef4444",
  actor: "#2a2d33"
});

const ACTOR_TYPES = new Set([
  "player", "clone", "box", "gem", "floating_floor", "orange_button", "puncher", "weightless_box"
]);
const RAISED_TERRAIN_TYPES = new Set([
  "wall", "ice_block", "ice_slope", "tree", "shrub", "block_asset", "orange_wall"
]);
const ASSET_URL = (fileName) => new URL(`./assets_3d/${fileName}`, import.meta.url).href;
const DEFINITIONS = new Map();

function addDefinition(type, tokens, options = {}) {
  const entries = Array.isArray(tokens) ? tokens : [tokens];
  entries.forEach((entry) => {
    const token = typeof entry === "string" ? entry : entry.token;
    const tokenOptions = typeof entry === "string" ? {} : entry;
    DEFINITIONS.set(token, Object.freeze({
      type,
      name: options.name || type,
      token,
      label: tokenOptions.label || options.label || type.replaceAll("_", " "),
      direction: tokenOptions.direction || options.direction || null,
      styleKey: tokenOptions.styleKey || options.styleKey || null,
      shape: tokenOptions.shape || options.shape || null,
      groupId: tokenOptions.groupId || options.groupId || null,
      initialRaised: tokenOptions.initialRaised === true || options.initialRaised === true,
      initialSprung: tokenOptions.initialSprung === true || options.initialSprung === true,
      modelUrl: options.model ? ASSET_URL(options.model) : null
    }));
  });
}

addDefinition("floor", ".");
addDefinition("ice", "i");
addDefinition("wall", "#");
addDefinition("ice_block", "I", { label: "Ice Block" });
addDefinition("ice_slope", [
  { token: "Sr", label: "Ice Slope Right", direction: "right" },
  { token: "Sl", label: "Ice Slope Left", direction: "left" },
  { token: "Su", label: "Ice Slope Up", direction: "up" },
  { token: "Sd", label: "Ice Slope Down", direction: "down" },
  { token: "Sr#", label: "Black Ice Slope Right", direction: "right", styleKey: "wall" },
  { token: "Sl#", label: "Black Ice Slope Left", direction: "left", styleKey: "wall" },
  { token: "Su#", label: "Black Ice Slope Up", direction: "up", styleKey: "wall" },
  { token: "Sd#", label: "Black Ice Slope Down", direction: "down", styleKey: "wall" }
], { label: "Ice Slope" });
addDefinition("player", "p");
addDefinition("clone", ["c0", "c1", "c2"], { label: "Clone" });
addDefinition("gem", "G", { model: "gem.glb" });
addDefinition("player_gate", "g");
addDefinition("player_lift", ["l", { token: "L", label: "Raised Player Lift", initialRaised: true }]);
addDefinition("orange_wall", "O", { label: "Orange Wall" });
addDefinition("orange_button", "o", { label: "Orange Button" });
addDefinition("puncher", [
  { token: "pr", label: "Puncher", direction: "right" },
  { token: "pl", label: "Puncher Left", direction: "left" },
  { token: "pu", label: "Puncher Up", direction: "up" },
  { token: "pd", label: "Puncher Down", direction: "down" },
  { token: "Pr", label: "Sprung Puncher", direction: "right", initialSprung: true },
  { token: "Pl", label: "Sprung Puncher Left", direction: "left", initialSprung: true },
  { token: "Pu", label: "Sprung Puncher Up", direction: "up", initialSprung: true },
  { token: "Pd", label: "Sprung Puncher Down", direction: "down", initialSprung: true }
], { label: "Puncher" });
addDefinition("box", "b");
addDefinition("floating_floor", "f");
addDefinition("weightless_box", ["M0", "M1", "M2", "M3", "M4"]);
addDefinition("tree", "t1", { label: "Tree 1", model: "t1.glb" });
addDefinition("tree", "t2", { label: "Tree 2", model: "t2.glb" });
addDefinition("tree", "t3", { label: "Tree 3", model: "t3.glb" });
addDefinition("tree", "t4", { label: "Tree 4", model: "t4.glb" });
addDefinition("tree", "st1", { label: "Small Tree 1", model: "st1.glb" });
addDefinition("tree", "st3", { label: "Small Tree 3", model: "st3.glb" });
addDefinition("tree", "st4", { label: "Small Tree 4", model: "st4.glb" });
addDefinition("shrub", "sh", { label: "Shrub", model: "sh.glb" });
addDefinition("block_asset", "b1", { label: "Block 1", model: "b1.glb" });
addDefinition("block_asset", "b2", { label: "Block 2", model: "b2.glb" });
addDefinition("block_asset", "b3", { label: "Block 3", model: "b3.glb" });
addDefinition("block_asset", "b4", { label: "Block 4", model: "b4.glb" });
addDefinition("exit", "e");
addDefinition("orange_ice_slope", [
  { token: "SrO", label: "Orange Ice Slope Right", direction: "right", styleKey: "orange" },
  { token: "SlO", label: "Orange Ice Slope Left", direction: "left", styleKey: "orange" },
  { token: "SuO", label: "Orange Ice Slope Up", direction: "up", styleKey: "orange" },
  { token: "SdO", label: "Orange Ice Slope Down", direction: "down", styleKey: "orange" }
], { label: "Orange Ice Slope" });

const DIRECTION = Object.freeze({ r: "right", l: "left", u: "up", d: "down" });

function patternedDefinition(token) {
  let match = /^M(\d+)$/.exec(token);
  if (match) return { ...DEFINITIONS.get("M0"), token, groupId: token, label: `Box ${match[1]}` };

  match = /^c(\d+)$/.exec(token);
  if (match) return { ...DEFINITIONS.get("c0"), token, groupId: token, label: `Clone ${match[1]}` };

  match = /^S([rlud])M(\d+)$/.exec(token);
  if (match) {
    const groupId = `M${match[2]}`;
    return {
      ...DEFINITIONS.get("M0"), token, groupId, styleKey: groupId,
      direction: DIRECTION[match[1]], shape: "slope",
      label: `Box Ice Slope ${match[2]} ${DIRECTION[match[1]]}`
    };
  }

  match = /^S([rlud])c(\d+)$/.exec(token);
  if (match) {
    const groupId = `c${match[2]}`;
    return {
      ...DEFINITIONS.get("c0"), token, groupId, styleKey: groupId,
      direction: DIRECTION[match[1]], shape: "slope",
      label: `Clone Ice Slope ${match[2]} ${DIRECTION[match[1]]}`
    };
  }

  return null;
}

export function normalizeToken(token) {
  const value = String(token ?? "").trim();
  return value === "h" ? "" : value;
}

export function resolveToken(token) {
  const normalized = normalizeToken(token);
  return DEFINITIONS.get(normalized) || patternedDefinition(normalized) || null;
}

export function parseLevelText(rawLevel) {
  return String(rawLevel)
    .split(/\r?\n/)
    .filter((row) => row.length > 0)
    .map((row) => row.split(" "));
}

export function serializeLevel(cells, trailingNewline = false) {
  return cells.map((row) => row.join(" ")).join("\n") + (trailingNewline ? "\n" : "");
}

function isActorDefinition(definition) {
  return ACTOR_TYPES.has(definition?.type);
}

function isRaisedTerrainDefinition(definition) {
  return RAISED_TERRAIN_TYPES.has(definition?.type) ||
    (definition?.type === "player_lift" && definition.initialRaised === true);
}

function terrainStackHeight(definition) {
  return definition?.type === "tree" ? 3 : isRaisedTerrainDefinition(definition) ? 1 : 0;
}

function terrainLayerSlotHeight(definition) {
  return definition?.type === "floor" || definition?.type === "ice"
    ? 0
    : Math.max(1, terrainStackHeight(definition));
}

export function colorForDefinition(definition) {
  if (!definition) return MAZE_COLORS.empty;
  if (definition.shape === "slope" && definition.styleKey?.startsWith("M")) return MAZE_COLORS.weightless;
  if (definition.shape === "slope" && definition.styleKey?.startsWith("c")) return MAZE_COLORS.clone;
  if (definition.styleKey === "wall") return MAZE_COLORS.wall;
  if (definition.styleKey === "orange") return MAZE_COLORS.orange;
  return {
    empty: MAZE_COLORS.empty, floor: MAZE_COLORS.floor, ice: MAZE_COLORS.ice,
    wall: MAZE_COLORS.wall, ice_block: MAZE_COLORS.ice, ice_slope: MAZE_COLORS.ice,
    orange_ice_slope: MAZE_COLORS.orange, tree: MAZE_COLORS.tree, shrub: MAZE_COLORS.shrub,
    block_asset: MAZE_COLORS.blockAsset, player_gate: MAZE_COLORS.gate,
    player_lift: MAZE_COLORS.lift, orange_wall: MAZE_COLORS.orange,
    orange_button: MAZE_COLORS.button, exit: MAZE_COLORS.floor, player: MAZE_COLORS.player,
    clone: MAZE_COLORS.clone, weightless_box: MAZE_COLORS.weightless,
    floating_floor: MAZE_COLORS.floor, gem: MAZE_COLORS.gem, puncher: MAZE_COLORS.puncher,
    box: MAZE_COLORS.actor, attached_lift: MAZE_COLORS.lift, attached_gate: MAZE_COLORS.gate
  }[definition.type] || MAZE_COLORS.actor;
}

function visualShape(definition) {
  if (!definition) return "empty";
  if (definition.shape) return definition.shape;
  return {
    floor: "floor", ice: "floor", wall: "block", ice_block: "block",
    ice_slope: "slope", orange_ice_slope: "slope", tree: "model", shrub: "model",
    block_asset: "model", player_gate: "plate", player_lift: "plate",
    orange_wall: "plate", orange_button: "button", exit: "exit", player: "cube",
    clone: "cube", weightless_box: "cube", box: "cube", floating_floor: "platform",
    gem: "gem", puncher: "puncher"
  }[definition.type] || "cube";
}

function terrainLayer(definition, elevation) {
  return {
    ...definition,
    color: colorForDefinition(definition),
    elevation,
    raised: definition.type === "player_lift" && definition.initialRaised === true,
    shape: visualShape(definition)
  };
}

export function parseCellState(rawCell) {
  const definitions = String(rawCell)
    .split("+")
    .map(normalizeToken)
    .map((token) => token ? resolveToken(token) : { isAir: true, token: "" })
    .filter(Boolean);
  const layers = [];
  const actors = [];
  let surfaceHeight = null;
  let previousSurfaceTerrain = false;
  let hasAirEntry = false;
  let consumedBaseVoid = false;
  let previousCarrier = false;

  definitions.forEach((definition) => {
    if (definition.isAir) {
      hasAirEntry = true;
      previousCarrier = false;
      if (surfaceHeight === null && !consumedBaseVoid) {
        consumedBaseVoid = true;
        previousSurfaceTerrain = false;
        return;
      }
      surfaceHeight = Math.max(0, surfaceHeight ?? 0) + 1;
      consumedBaseVoid = true;
      previousSurfaceTerrain = false;
      return;
    }

    if (isActorDefinition(definition)) {
      const elevation = Math.max(0, surfaceHeight ?? 0);
      const groupId = definition.type === "weightless_box" || definition.type === "clone"
        ? definition.groupId || definition.token
        : null;
      actors.push({
        ...definition,
        color: colorForDefinition(definition),
        elevation,
        groupId,
        sprung: definition.type === "puncher" && definition.initialSprung === true,
        shape: visualShape(definition)
      });
      surfaceHeight = elevation + 1;
      previousSurfaceTerrain = false;
      previousCarrier = definition.type === "weightless_box" || definition.type === "clone";
      return;
    }

    if (
      (definition.type === "player_lift" || definition.type === "player_gate") &&
      previousCarrier
    ) {
      const elevation = Math.max(0, surfaceHeight ?? 0);
      const type = definition.type === "player_lift" ? "attached_lift" : "attached_gate";
      actors.push({
        ...definition,
        type,
        color: colorForDefinition({ ...definition, type }),
        elevation,
        shape: "plate",
        raised: definition.initialRaised === true
      });
      surfaceHeight = elevation + 1;
      previousSurfaceTerrain = false;
      previousCarrier = false;
      return;
    }

    const baseSurface = definition.type === "floor" || definition.type === "ice";
    let elevation = Math.max(0, surfaceHeight ?? 0);
    if (baseSurface && previousSurfaceTerrain && surfaceHeight !== null) elevation = surfaceHeight + 1;
    layers.push(terrainLayer(definition, elevation));
    surfaceHeight = elevation + terrainLayerSlotHeight(definition);
    previousSurfaceTerrain = baseSurface;
    previousCarrier = definition.type === "orange_wall";
  });

  if (!hasAirEntry && actors.some((actor) => actor.type !== "orange_button") && layers.length === 0) {
    layers.push(terrainLayer(resolveToken("."), 0));
  }

  return { actors, hasAirEntry, layers, tokens: definitions.map((definition) => definition.token || "") };
}

export function describeCell(rawCell) {
  const state = parseCellState(rawCell);
  const terrain = state.layers.length ? state.layers.reduce((best, layer) => {
    const bestTop = best.elevation + terrainStackHeight(best);
    const layerTop = layer.elevation + terrainStackHeight(layer);
    return layerTop >= bestTop ? layer : best;
  }) : null;
  return {
    ...state,
    actor: state.actors.at(-1) || null,
    startsInAir: state.hasAirEntry,
    terrain
  };
}

export function cellForTool(token) {
  if (token === "__erase_top__") return "+";
  if (token === "." || token === "i") return token;
  return `.+${token}`;
}

function axisValues(entries, positionIndex) {
  return [...new Set(entries.map(([, position]) => position[positionIndex]))].sort();
}

async function readText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url.pathname}`);
  return response.text();
}

async function loadInBatches(entries, load, onProgress) {
  let next = 0;
  let complete = 0;
  const results = new Array(entries.length);

  async function worker() {
    while (next < entries.length) {
      const index = next++;
      results[index] = await load(entries[index], index);
      complete += 1;
      onProgress?.(complete, entries.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, worker));
  return results;
}

export async function loadMainWorld(onProgress) {
  const manifestUrl = new URL("../../level-data/v1/main-world/world_map.json", import.meta.url);
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error("Could not load the main-world map.");

  const manifest = await manifestResponse.json();
  const entries = Object.entries(manifest.levels || {});
  const columns = axisValues(entries, 0);
  const rows = axisValues(entries, 1);
  const columnIndexes = new Map(columns.map((value, index) => [value, index]));
  const rowIndexes = new Map(rows.map((value, index) => [value, index]));
  const rooms = await loadInBatches(
    entries,
    async ([fileName, position]) => {
      const source = await readText(new URL(fileName, manifestUrl));
      return {
        fileName,
        position,
        columnIndex: columnIndexes.get(position[0]),
        rowIndex: rowIndexes.get(position[1]),
        cells: parseLevelText(source),
        trailingNewline: source.endsWith("\n")
      };
    },
    onProgress
  );

  if (!rooms.length) throw new Error("The main-world map is empty.");
  const roomHeight = rooms[0].cells.length;
  const roomWidth = rooms[0].cells[0]?.length || 0;
  const malformed = rooms.find(
    (room) => room.cells.length !== roomHeight || room.cells.some((row) => row.length !== roomWidth)
  );
  if (!roomWidth || !roomHeight || malformed) {
    throw new Error(`Unexpected room dimensions in ${malformed?.fileName || "main world"}.`);
  }

  return { columns, rows, roomWidth, roomHeight, rooms };
}
