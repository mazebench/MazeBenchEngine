#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const vm = require("node:vm");

const {
  defaultLevelIdForGame,
  getGame,
  getLevel,
  getLevelState
} = require("../server/app");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_TERMINAL_REPLAY_ROOT = path.join(ROOT_DIR, "outputs", "maze-terminal");

function normalizeGameWonGemCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 100;
}

const GAME_CONFIG_PATH = path.join(ROOT_DIR, "games", "maze", "config.json");

function configuredGameWonGemCount() {
  if (process.env.MAZEBENCH_GAME_WON_GEM_COUNT) {
    return normalizeGameWonGemCount(process.env.MAZEBENCH_GAME_WON_GEM_COUNT);
  }

  try {
    const config = JSON.parse(fs.readFileSync(GAME_CONFIG_PATH, "utf8"));
    return normalizeGameWonGemCount(config?.game_won_gem_count);
  } catch (_error) {
    // Fall back to the built-in default when the shared config is missing.
  }

  return 100;
}

const GAME_WON_GEM_COUNT = configuredGameWonGemCount();
const TILE_GRANULARITY = 4;
const MAX_PITCH = TILE_GRANULARITY;
const TOP_DOWN_TILE_SIZE = 4;
const TILTED_TILE_WIDTH = 4;
const TILTED_MAX_DEPTH_STEP = 4;
const TILTED_MAX_Z_STEP = 4;
const FLOOR_THICKNESS = 0.16;
const ACTOR_INSET = 0.18;
const ACTOR_HEIGHT = 0.82;
const VIEW_NAMES = ["top", "top-diagonal", "diagonal", "side-diagonal", "side"];
const MOVE_ACTIONS = new Map([
  ["U", { dx: 0, dy: -1, label: "Up" }],
  ["D", { dx: 0, dy: 1, label: "Down" }],
  ["L", { dx: -1, dy: 0, label: "Left" }],
  ["R", { dx: 1, dy: 0, label: "Right" }]
]);
const DEATH_MESSAGE = "The player died, you must now undo or reset or go to a level.";
const ALIVE_ALLOWED_COMMANDS = Object.freeze([
  "up",
  "down",
  "left",
  "right",
  "rotate camera up",
  "rotate camera down",
  "rotate camera left",
  "rotate camera right",
  "undo",
  "reset",
  "go to level X Y",
  "quit"
]);
const DEAD_ALLOWED_COMMANDS = Object.freeze([
  "undo",
  "reset",
  "go to level X Y"
]);
function glyphPair(top, side) {
  return { side, top };
}

const TERRAIN_GLYPHS = {
  block_asset: glyphPair("&", "7"),
  empty: glyphPair(" ", " "),
  exit: glyphPair("E", "e"),
  floor: glyphPair("A", "a"),
  hole: glyphPair("H", "h"),
  ice: glyphPair("I", "i"),
  ice_block: glyphPair("K", "k"),
  ice_slope: glyphPair("~", "-"),
  orange_wall: glyphPair("O", "o"),
  player_gate: glyphPair("Y", "y"),
  shrub: glyphPair("S", "s"),
  tree: glyphPair("T", "t"),
  wall: glyphPair("W", "w")
};
const PLAYER_LIFT_GLYPHS = {
  player_lift: {
    loweredTop: ">",
    raisedTop: "L",
    side: "l"
  }
};
const ORANGE_BUTTON_GLYPHS = {
  orange_button: glyphPair("8", " ")
};
const BLOCK_ASSET_GLYPHS = {
  1: glyphPair("!", "1"),
  2: glyphPair("@", "2"),
  3: glyphPair("#", "3"),
  4: glyphPair("$", "4")
};
const ICE_SLOPE_DIRECTION_GLYPHS = {
  down: glyphPair("V", "v"),
  left: glyphPair("<", ","),
  right: glyphPair("R", "r"),
  up: glyphPair("^", "6")
};
const ACTOR_GLYPHS = {
  box: glyphPair("B", "b"),
  clone: glyphPair("{", "["),
  floating_floor: glyphPair("F", "f"),
  gem: glyphPair("G", "g"),
  player: glyphPair("P", "p"),
  puncher: glyphPair("}", "]"),
  weightless_box: glyphPair(";", "_")
};
const CLONE_GLYPHS = {
  c0: glyphPair("C", "c"),
  c1: glyphPair("D", "d"),
  c2: glyphPair("J", "j")
};
const WEIGHTLESS_BOX_GLYPHS = {
  M0: glyphPair("U", "u"),
  M1: glyphPair("0", "9"),
  M2: glyphPair("(", ")"),
  M3: glyphPair("+", "="),
  M4: glyphPair(".", ":")
};
const PUNCHER_DIRECTION_GLYPHS = {
  down: glyphPair("%", "5"),
  left: glyphPair("X", "x"),
  right: glyphPair("Q", "q"),
  up: glyphPair("Z", "z")
};
const UNKNOWN_GLYPHS = {
  actor: glyphPair("|", "\\"),
  terrain: glyphPair("`", "'")
};
const DEFAULT_WORLD_AXIS = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
const WORLD_LEVEL_PATTERN = /^level_([A-Z])x([A-Z])$/;
const JSON_OBJECT_NAME_UNIVERSE = Object.freeze([
  "block_asset",
  "box",
  "clone",
  "empty",
  "exit",
  "floor",
  "floating_floor",
  "hole",
  "ice",
  "ice_block",
  "ice_slope_down",
  "ice_slope_left",
  "ice_slope_right",
  "ice_slope_up",
  "orange_button",
  "orange_wall",
  "player_gate",
  "player_lift_lowered",
  "player_lift_raised",
  "puncher_down",
  "puncher_left",
  "puncher_right",
  "puncher_up",
  "shrub",
  "tree",
  "wall",
  "weightless_box"
]);
const HIDDEN_NAME_ALPHABET = Array.from("ABCDEFGHJKLMNOQRSTUVWXYZabcdefghijklmnoqrstuvwxyz");

function assertUniqueGlyphPairs(groups) {
  const used = new Map();

  Object.entries(groups).forEach(([groupName, group]) => {
    Object.entries(group).forEach(([name, pair]) => {
      const owner = `${groupName}.${name}`;

      Object.entries(pair).forEach(([role, symbol]) => {
        if (symbol === " ") {
          return;
        }

        if (String(symbol).length !== 1) {
          throw new Error(`${groupName}.${name}.${role} must be one character`);
        }

        const previous = used.get(symbol);
        if (previous && previous.owner !== owner) {
          throw new Error(`Duplicate ASCII glyph ${JSON.stringify(symbol)} in ${previous.path} and ${owner}.${role}`);
        }

        used.set(symbol, { owner, path: `${owner}.${role}` });
      });
    });
  });
}

assertUniqueGlyphPairs({
  ACTOR_GLYPHS,
  BLOCK_ASSET_GLYPHS,
  CLONE_GLYPHS,
  ICE_SLOPE_DIRECTION_GLYPHS,
  ORANGE_BUTTON_GLYPHS,
  PLAYER_LIFT_GLYPHS,
  PUNCHER_DIRECTION_GLYPHS,
  TERRAIN_GLYPHS,
  UNKNOWN_GLYPHS,
  WEIGHTLESS_BOX_GLYPHS
});

function parseArgs(argv) {
  const options = {
    gameId: "maze",
    gameWonGemCount: GAME_WON_GEM_COUNT,
    json: false,
    levelId: "level_HxI",
    maxExpandedStates: 1000000,
    moves: "",
    pitch: 1,
    replayDraft: false,
    replayFast: false,
    recordReplay: null,
    replayOutDir: "",
    replayFps: null,
    replayHeight: null,
    replayVideo: null,
    replayWidth: null,
    solve: false,
    yaw: 0,
    once: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] || "";

    if (arg === "--game") {
      options.gameId = next();
    } else if (arg === "--level") {
      options.levelId = next();
    } else if (arg === "--moves") {
      options.moves = next();
      options.once = true;
    } else if (arg === "--json") {
      options.json = true;
      options.once = true;
    } else if (arg === "--solve") {
      options.solve = true;
    } else if (arg === "--max-expanded-states") {
      options.maxExpandedStates = Number(next()) || options.maxExpandedStates;
    } else if (arg === "--game-won-gem-count" || arg === "--game-won-gems") {
      options.gameWonGemCount = normalizeGameWonGemCount(next());
    } else if (arg === "--pitch") {
      options.pitch = clampPitch(Number(next()));
    } else if (arg === "--view") {
      options.pitch = pitchFromView(next());
    } else if (arg === "--yaw") {
      options.yaw = normalizeYaw(Number(next()));
    } else if (arg === "--record-replay" || arg === "--replay") {
      options.recordReplay = true;
    } else if (arg === "--no-replay") {
      options.recordReplay = false;
    } else if (arg === "--replay-out-dir") {
      options.replayOutDir = next();
    } else if (arg === "--video") {
      options.replayVideo = true;
    } else if (arg === "--no-video" || arg === "--no-replay-video") {
      options.replayVideo = false;
    } else if (arg === "--fast" || arg === "--fast-video" || arg === "--fast-render") {
      options.replayFast = true;
    } else if (arg === "--no-fast") {
      options.replayFast = false;
    } else if (arg === "--draft" || arg === "--draft-video" || arg === "--draft-render") {
      options.replayDraft = true;
    } else if (arg === "--no-draft") {
      options.replayDraft = false;
    } else if (arg === "--fps" || arg === "--replay-fps") {
      options.replayFps = Number(next());
    } else if (arg === "--width" || arg === "--replay-width") {
      options.replayWidth = Number(next());
    } else if (arg === "--height" || arg === "--replay-height") {
      options.replayHeight = Number(next());
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: npm run maze:terminal -- [options]

Options:
  --level <id>       Maze world level id. Defaults to level_HxI.
  --moves <UDLR>     Apply moves and print the resulting board once.
  --view <name>      top, top-diagonal, diagonal, side-diagonal, or side.
                     Defaults to top-diagonal.
  --pitch <0-4>      Camera pitch; 0 is top-down, 4 is side.
  --yaw <0-3>        Camera yaw rotation.
  --json             Print machine-readable state instead of terminal text.
  --solve            Include the JS solver answer in --json output.
  --max-expanded-states <n>
                     Solver search cap used by --solve.
  --game-won-gem-count <n>
                     Unique gems required for the game_won condition.
  --record-replay    Write local replay artifacts for non-interactive runs.
                     Interactive runs write replay artifacts by default.
  --no-replay        Do not write replay artifacts for interactive runs.
  --replay-out-dir <path>
                     Directory for maze_scorecard.json, maze_actions.txt,
                     maze_replay.json, results.jsonl, and maze_replay.mp4.
  --video            Render maze_replay.mp4 for non-interactive runs.
  --no-video         Do not ask/render video for interactive runs.
  --fast             Render only settled states, not animation tweens.
  --draft            Lower replay DPR and disable effects for faster capture.
  --fps <n>          Replay video FPS when rendering without the prompt.
  --width <px>       Replay video width when rendering without the prompt.
  --height <px>      Replay video height when rendering without the prompt.
  --once             Render once and exit.

Interactive controls:
  Arrow keys         Up/Down/Left/Right movement relative to the current view.
	  W/S               Pitch Camera Up/Down.
	  A/D               Yaw Camera Left/Right.
	  z/u               Undo.
	  r                 Reset level.
	  q                 Quit and print scorecard.`);
}

function clampPitch(value) {
  return Math.max(0, Math.min(MAX_PITCH, Number.isInteger(value) ? value : 0));
}

function pitchFromView(value) {
  const index = VIEW_NAMES.indexOf(String(value || "").toLowerCase());
  return index === -1 ? 0 : index;
}

function normalizeYaw(value) {
  const integerValue = Number.isInteger(value) ? value : 0;
  return ((integerValue % 4) + 4) % 4;
}

function moveVector(dx, dy) {
  return {
    dx: Object.is(dx, -0) ? 0 : dx,
    dy: Object.is(dy, -0) ? 0 : dy
  };
}

function screenMoveVector(move, yaw = 0) {
  const screenMove = MOVE_ACTIONS.get(String(move || "").toUpperCase());

  if (!screenMove) {
    return null;
  }

  const { dx, dy } = screenMove;

  switch (normalizeYaw(yaw)) {
    case 1:
      return moveVector(dy, -dx);
    case 2:
      return moveVector(-dx, -dy);
    case 3:
      return moveVector(-dy, dx);
    default:
      return moveVector(dx, dy);
  }
}

function normalizeAxisValues(values, fallback = DEFAULT_WORLD_AXIS) {
  const safeFallback = Array.isArray(fallback) ? fallback : DEFAULT_WORLD_AXIS;

  if (!Array.isArray(values) || values.length === 0) {
    return safeFallback.slice();
  }

  const normalized = values
    .filter((value) => typeof value === "string" && /^[A-Z]$/.test(value))
    .slice();

  return normalized.length > 0 ? normalized : safeFallback.slice();
}

function parseWorldLevelId(levelId, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
  const match = String(levelId || "").match(WORLD_LEVEL_PATTERN);

  if (!match) {
    return null;
  }

  const columns = normalizeAxisValues(worldColumns);
  const rows = normalizeAxisValues(worldRows);
  const columnIndex = columns.indexOf(match[1]);
  const rowIndex = rows.indexOf(match[2]);

  if (columnIndex === -1 || rowIndex === -1) {
    return null;
  }

  return {
    columnIndex,
    rowIndex
  };
}

function worldLevelId(columnIndex, rowIndex, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
  const columns = normalizeAxisValues(worldColumns);
  const rows = normalizeAxisValues(worldRows);

  if (columns.length === 0 || rows.length === 0) {
    return null;
  }

  const normalizedColumn = ((columnIndex % columns.length) + columns.length) % columns.length;
  const normalizedRow = ((rowIndex % rows.length) + rows.length) % rows.length;
  return `level_${columns[normalizedColumn]}x${rows[normalizedRow]}`;
}

function adjacentWorldLevelId(levelId, dx, dy, worldColumns = DEFAULT_WORLD_AXIS, worldRows = DEFAULT_WORLD_AXIS) {
  const coordinates = parseWorldLevelId(levelId, worldColumns, worldRows);

  if (!coordinates) {
    return null;
  }

  return worldLevelId(
    coordinates.columnIndex + dx,
    coordinates.rowIndex + dy,
    worldColumns,
    worldRows
  );
}

function isPlayerActorType(type) {
  return type === "player";
}

function loadBrowserScript(relativePath) {
  const absolutePath = path.join(ROOT_DIR, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");

  vm.runInThisContext(source, {
    filename: absolutePath,
    displayErrors: true
  });
}

function loadMazeEngine() {
  global.window = global.window || {};
  loadBrowserScript("public/maze-engine.js");
  return global.window.MazeEngine;
}

function loadMazeSolver() {
  global.window = global.window || {};
  if (!global.window.MazeEngine) {
    loadMazeEngine();
  }
  loadBrowserScript("public/maze-solver.js");
  return global.window.MazeSolver;
}

function resolvePlayData(options) {
  const game = getGame(options.gameId);

  if (!game) {
    throw new Error(`Unknown game: ${options.gameId}`);
  }

  const levelId = options.levelId || defaultLevelIdForGame(game);
  const level = getLevel(game, levelId);

  if (!level) {
    throw new Error(`Unknown level: ${levelId}`);
  }

  return {
    game,
    level,
    playData: getLevelState(game, level)
  };
}

function cloneTransferActor(actor) {
  return {
    type: actor.type,
    groupId: actor.groupId ?? null,
    label: actor.label,
    imageUrl: actor.imageUrl || null,
    modelUrl: actor.modelUrl || null,
    direction: actor.direction || actor.facing || null,
    removed: false,
    elevation: actor.elevation ?? 0,
    x: actor.x,
    y: actor.y
  };
}

function buildRuntimeRoom(mazeEngine, playData, transferActor = null) {
  const roomPlayData = {
    ...playData,
    actors: (playData.actors || []).map((actor) => ({ ...actor }))
  };

  if (transferActor) {
    roomPlayData.actors = roomPlayData.actors
      .filter((actor) => !isPlayerActorType(actor.type))
      .concat({ ...transferActor });
  }

  const engine = mazeEngine.createEngine(roomPlayData);

  return {
    engine,
    playData: roomPlayData,
    state: engine.cloneState(engine.initialState)
  };
}

function captureRoomSnapshot(context) {
  return {
    engine: context.engine,
    level: context.level,
    playData: context.playData,
    state: context.engine.cloneState(context.state)
  };
}

function cloneRoomSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    engine: snapshot.engine,
    level: snapshot.level,
    playData: snapshot.playData,
    state: snapshot.engine.cloneState(snapshot.state)
  };
}

function captureHistorySnapshot(context) {
  return {
    entrySnapshot: cloneRoomSnapshot(context.entrySnapshot),
    room: captureRoomSnapshot(context)
  };
}

function restoreRoomSnapshot(context, snapshot) {
  const room = cloneRoomSnapshot(snapshot);

  if (!room) {
    return false;
  }

  context.engine = room.engine;
  context.level = room.level;
  context.playData = room.playData;
  context.state = room.state;
  return true;
}

function createRunStats(levelId, options = {}) {
  return {
    actionCounts: {
      move: 0,
      reset: 0,
      rotateCamera: 0,
      undo: 0
    },
    actions: [],
    blockedMoves: 0,
    collectedGemIds: new Set(),
    elevationChanges: 0,
    elevationGain: 0,
    elevationLoss: 0,
    maxElevation: null,
    minElevation: null,
    moveAttempts: {
      D: 0,
      L: 0,
      R: 0,
      U: 0
    },
    moveSuccesses: {
      D: 0,
      L: 0,
      R: 0,
      U: 0
    },
    pitchRotations: {
      down: 0,
      up: 0
    },
    initialPitch: clampPitch(Number.isInteger(options.pitch) ? options.pitch : 1),
    initialYaw: normalizeYaw(Number.isInteger(options.yaw) ? options.yaw : 0),
    roomTransitions: 0,
    startedAtMs: Date.now(),
    startingLevelId: levelId,
    successfulMoves: 0,
    uniqueElevationTiles: new Set(),
    uniqueTiles: new Set(),
    visitedRooms: new Set(levelId ? [levelId] : []),
    yawRotations: {
      left: 0,
      right: 0
    }
  };
}

function createTerminalContext(mazeEngine, options) {
  const normalizedOptions = {
    ...options,
    gameWonGemCount: normalizeGameWonGemCount(options.gameWonGemCount)
  };
  const { game, level, playData } = resolvePlayData(normalizedOptions);
  const room = buildRuntimeRoom(mazeEngine, playData);
  const context = {
    engine: room.engine,
    entrySnapshot: null,
    game,
    history: [],
    level,
    mazeEngine,
    options: normalizedOptions,
    playData: room.playData,
    stats: null,
    state: room.state
  };

  context.entrySnapshot = captureRoomSnapshot(context);
  context.stats = createRunStats(context.level.id, normalizedOptions);
  recordPlayerVisit(context);
  return context;
}

function terrainTypeNameByValue(terrainTypes) {
  return Object.fromEntries(Object.entries(terrainTypes).map(([name, value]) => [value, name]));
}

function cellIndex(playData, x, y) {
  return y * playData.width + x;
}

function orangeButtonsPressedForState(engine, state) {
  return typeof engine?.areOrangeButtonsPressed === "function"
    ? engine.areOrangeButtonsPressed(state)
    : false;
}

function pressedOrangeWallLowersAsBlock(engine, state, x, y, elevation) {
  return typeof engine?.pressedOrangeWallLowersAsBlock === "function"
    ? engine.pressedOrangeWallLowersAsBlock(state, x, y, elevation)
    : false;
}

function terrainStateOverridesCell(stateType, cell) {
  if (!stateType) {
    return false;
  }

  return stateType !== (cell.type || "empty");
}

function terrainTypeAt(playData, state, typeNames, x, y) {
  const index = cellIndex(playData, x, y);
  const stateType = typeNames[state.terrain[index]];
  const cell = playData.terrain[y]?.[x] || {};

  if (terrainStateOverridesCell(stateType, cell)) {
    return stateType;
  }

  const layers = Array.isArray(cell.layers) ? cell.layers : [];
  if (layers.length > 0) {
    return layers.reduce((top, layer) =>
      (layer.elevation ?? 0) >= (top.elevation ?? 0) ? layer : top
    ).type || cell.type || "empty";
  }

  return cell.type || "empty";
}

function terrainLayerHeight(layer, state, index, type, orangeButtonsPressed = false) {
  const layerElevation = layer.elevation ?? 0;

  if (
    type === "wall" ||
    type === "ice_block" ||
    type === "ice_slope" ||
    type === "shrub" ||
    type === "block_asset"
  ) {
    return layerElevation + 1;
  }

  if (type === "tree") {
    return layerElevation + 3;
  }

  if (type === "player_lift") {
    return state.liftRaised[index] ? layerElevation + 1 : layerElevation;
  }

  if (type === "orange_wall") {
    return layerElevation + (orangeButtonsPressed ? 0 : 1);
  }

  if (type === "player_gate") {
    return layerElevation + 1;
  }

  return layerElevation;
}

function transitionLayerSurfaceHeight(playData, state, typeNames, layer, x, y) {
  const type = layer.type || "empty";
  const elevation = layer.elevation ?? 0;

  if (type === "empty" || type === "hole") {
    return null;
  }

  if (
    type === "wall" ||
    type === "ice_block" ||
    type === "ice_slope" ||
    type === "shrub" ||
    type === "block_asset"
  ) {
    return elevation + 1;
  }

  if (type === "tree") {
    return elevation + 3;
  }

  if (type === "player_lift") {
    const index = cellIndex(playData, x, y);
    return state.liftRaised[index] ? elevation + 1 : elevation;
  }

  if (type === "orange_wall") {
    return elevation + 1;
  }

  if (type === "player_gate") {
    const index = cellIndex(playData, x, y);
    const stateType = typeNames[state.terrain[index]];
    return stateType === "player_gate" ? elevation + 1 : elevation;
  }

  return elevation;
}

function transitionLayerBlocksElevation(playData, state, typeNames, layer, x, y, elevation) {
  const type = layer.type || "empty";
  const layerElevation = layer.elevation ?? 0;

  if (type === "wall" || type === "ice_block") {
    return layerElevation === elevation;
  }

  if (type === "ice_slope") {
    return elevation === layerElevation || elevation === layerElevation + 1;
  }

  if (type === "tree") {
    return elevation >= layerElevation && elevation < layerElevation + 3;
  }

  if (type === "shrub" || type === "block_asset") {
    return elevation >= layerElevation && elevation <= layerElevation + 1;
  }

  if (type === "player_lift") {
    const index = cellIndex(playData, x, y);
    return state.liftRaised[index] && layerElevation === elevation;
  }

  if (type === "orange_wall") {
    return layerElevation === elevation;
  }

  if (type === "player_gate") {
    const index = cellIndex(playData, x, y);
    const stateType = typeNames[state.terrain[index]];
    return stateType === "player_gate" && layerElevation === elevation;
  }

  return false;
}

function transitionTerrainBlocksElevation(playData, state, typeNames, x, y, elevation) {
  if (x < 0 || y < 0 || x >= playData.width || y >= playData.height) {
    return true;
  }

  return terrainLayersAt(playData, state, typeNames, x, y).some((layer) =>
    transitionLayerBlocksElevation(playData, state, typeNames, layer, x, y, elevation)
  );
}

function transitionSurfaceTypeAt(playData, state, engine, x, y, elevation) {
  if (x < 0 || y < 0 || x >= playData.width || y >= playData.height) {
    return null;
  }

  const typeNames = terrainTypeNameByValue(engine.terrainTypes);

  if (transitionTerrainBlocksElevation(playData, state, typeNames, x, y, elevation)) {
    return null;
  }

  return (
    terrainLayersAt(playData, state, typeNames, x, y)
      .map((layer, index) => ({
        index,
        layer,
        surfaceHeight: transitionLayerSurfaceHeight(playData, state, typeNames, layer, x, y)
      }))
      .filter((entry) => entry.surfaceHeight === elevation)
      .sort(
        (left, right) =>
          (right.layer.elevation ?? 0) - (left.layer.elevation ?? 0) ||
          right.index - left.index
      )[0]
      ?.layer.type || null
  );
}

function transitionHoleTypeAt(playData, state, engine, x, y, elevation) {
  if (x < 0 || y < 0 || x >= playData.width || y >= playData.height) {
    return null;
  }

  const typeNames = terrainTypeNameByValue(engine.terrainTypes);

  return (
    terrainLayersAt(playData, state, typeNames, x, y).find(
      (layer) => layer.type === "hole" && (layer.elevation ?? 0) === elevation
    )?.type || null
  );
}

function terrainLayersAt(playData, state, typeNames, x, y) {
  const index = cellIndex(playData, x, y);
  const stateType = typeNames[state.terrain[index]];
  const cell = playData.terrain[y]?.[x] || {};

  if (terrainStateOverridesCell(stateType, cell)) {
    if (stateType === "empty") {
      return [];
    }

    return [
      {
        elevation: 0,
        type: stateType
      }
    ];
  }

  const layers = Array.isArray(cell.layers) ? cell.layers : [];

  if (layers.length > 0) {
    return layers.filter((layer) => layer?.type && layer.type !== "empty");
  }

  const type = terrainTypeAt(playData, state, typeNames, x, y);
  return type && type !== "empty" ? [{ elevation: 0, type }] : [];
}

function semanticTerrainLayersAt(playData, state, typeNames, x, y) {
  const layers = terrainLayersAt(playData, state, typeNames, x, y);
  return layers.length > 0 ? layers : [{ elevation: 0, type: "empty" }];
}

function terrainObjectId(x, y, layerIndex) {
  return `terrain:${x}:${y}:${layerIndex}`;
}

function actorObjectId(index) {
  return `actor:${index}`;
}

function normalizeDirection(value) {
  const direction = String(value || "").toLowerCase();
  return ["down", "left", "right", "up"].includes(direction) ? direction : "";
}

function blockAssetVariant(layer) {
  const values = [layer?.modelUrl, layer?.label, layer?.name, layer?.token];

  for (const value of values) {
    const text = String(value || "");
    const match =
      text.match(/(?:^|[^a-z0-9])b([1-4])(?:\.glb|[^a-z0-9]|$)/i) ||
      text.match(/\bblock\s*([1-4])\b/i) ||
      text.match(/\bblock_asset[_-]?([1-4])\b/i);

    if (match) {
      return match[1];
    }
  }

  return "";
}

function cloneVariant(actor) {
  const values = [actor?.groupId, actor?.label, actor?.name, actor?.token];

  for (const value of values) {
    const text = String(value || "").toLowerCase();
    const match = text.match(/\bc([0-2])\b/) || text.match(/\bclone\s*([0-2])\b/);

    if (match) {
      return `c${match[1]}`;
    }
  }

  return "";
}

function weightlessBoxVariant(actor) {
  const values = [actor?.groupId, actor?.label, actor?.name, actor?.token];

  for (const value of values) {
    const text = String(value || "");
    const match =
      text.match(/\bM([0-4])\b/) ||
      text.match(/\bweightless(?:_|\s*)box\s*([0-4])\b/i);

    if (match) {
      return `M${match[1]}`;
    }
  }

  return "";
}

function normalizeGlyph(value) {
  if (value && typeof value === "object" && typeof value.top === "string") {
    return value;
  }

  if (!value) {
    return UNKNOWN_GLYPHS.actor;
  }

  const top = String(value).charAt(0) || UNKNOWN_GLYPHS.actor.top;
  return glyphPair(top, top.toLowerCase());
}

function terrainGlyph(layerOrType, state = null, index = -1, orangeButtonsPressed = false) {
  const layer =
    typeof layerOrType === "object" && layerOrType !== null
      ? layerOrType
      : { type: layerOrType };
  const type = layer.type || "";

  if (type === "player_lift") {
    const raised = index >= 0 && state?.liftRaised
      ? state.liftRaised[index] === 1
      : layer.raised === true;
    const glyph = PLAYER_LIFT_GLYPHS.player_lift;
    return glyphPair(raised ? glyph.raisedTop : glyph.loweredTop, glyph.side);
  }

  if (type === "orange_wall") {
    return TERRAIN_GLYPHS.orange_wall;
  }

  if (type === "orange_button") {
    return ORANGE_BUTTON_GLYPHS.orange_button;
  }

  if (type === "block_asset") {
    return BLOCK_ASSET_GLYPHS[blockAssetVariant(layer)] || TERRAIN_GLYPHS.block_asset;
  }

  if (type === "ice_slope") {
    return (
      ICE_SLOPE_DIRECTION_GLYPHS[normalizeDirection(layer.direction)] ||
      TERRAIN_GLYPHS.ice_slope
    );
  }

  return TERRAIN_GLYPHS[type] || UNKNOWN_GLYPHS.terrain;
}

function actorGlyph(actorOrType) {
  const actor =
    typeof actorOrType === "object" && actorOrType !== null
      ? actorOrType
      : { type: actorOrType };
  const type = actor.type || "";

  if (type === "orange_button") {
    return ORANGE_BUTTON_GLYPHS.orange_button;
  }

  if (type === "clone") {
    return CLONE_GLYPHS[cloneVariant(actor)] || ACTOR_GLYPHS.clone;
  }

  if (type === "puncher") {
    return (
      PUNCHER_DIRECTION_GLYPHS[normalizeDirection(actor.direction)] ||
      ACTOR_GLYPHS.puncher
    );
  }

  if (type === "weightless_box") {
    return WEIGHTLESS_BOX_GLYPHS[weightlessBoxVariant(actor)] || ACTOR_GLYPHS.weightless_box;
  }

  return ACTOR_GLYPHS[type] || UNKNOWN_GLYPHS.actor;
}

function actorLetter(actorOrType) {
  return actorGlyph(actorOrType).top;
}

function rotatePoint(x, y, yaw) {
  switch (yaw) {
    case 1:
      return { x: y, y: -x };
    case 2:
      return { x: -x, y: -y };
    case 3:
      return { x: -y, y: x };
    default:
      return { x, y };
  }
}

function cameraSteps(pitch) {
  if (pitch === 0) {
    return {
      depthStep: TOP_DOWN_TILE_SIZE,
      zStep: 0
    };
  }

  return {
    depthStep: TILTED_MAX_DEPTH_STEP * ((MAX_PITCH - pitch) / MAX_PITCH),
    zStep: TILTED_MAX_Z_STEP * (pitch / MAX_PITCH)
  };
}

function projectPoint(playData, point, options) {
  const yaw = normalizeYaw(options.yaw);
  const pitch = clampPitch(options.pitch);
  const centeredX = point.x - playData.width / 2;
  const centeredY = point.y - playData.height / 2;
  const rotated = rotatePoint(centeredX, centeredY, yaw);

  if (pitch === 0) {
    return {
      depth: point.z,
      x: rotated.x * TOP_DOWN_TILE_SIZE,
      y: rotated.y * TOP_DOWN_TILE_SIZE
    };
  }

  const { depthStep, zStep } = cameraSteps(pitch);

  return {
    depth: rotated.y * pitch + point.z * (MAX_PITCH - pitch + 1),
    x: rotated.x * TILTED_TILE_WIDTH,
    y: rotated.y * depthStep - point.z * zStep
  };
}

function addFace(faces, points, letter, kind, options = {}) {
  faces.push({
    kind,
    letter,
    layer: options.layer || 0,
    topLetter: options.topLetter || letter,
    points
  });
}

function boxCorners(box) {
  const { x0, x1, y0, y1, z0, z1 } = box;

  return [
    { x: x0, y: y0, z: z0 },
    { x: x1, y: y0, z: z0 },
    { x: x1, y: y1, z: z0 },
    { x: x0, y: y1, z: z0 },
    { x: x0, y: y0, z: z1 },
    { x: x1, y: y0, z: z1 },
    { x: x1, y: y1, z: z1 },
    { x: x0, y: y1, z: z1 }
  ];
}

function addActorSolidFace(faces, box, glyphOrLetter) {
  const glyph = normalizeGlyph(glyphOrLetter);

  addFace(faces, boxCorners(box), glyph.side, "actor_solid", {
    layer: 20,
    topLetter: glyph.top
  });
}

function addBoxFaces(faces, box, glyphOrLetter, options = {}) {
  const glyph = normalizeGlyph(glyphOrLetter);
  const { x0, x1, y0, y1, z0, z1 } = box;
  const layer = options.layer || 0;
  const sides = options.sides || {
    east: z0,
    north: z0,
    south: z0,
    west: z0
  };

  if (z1 < z0) {
    return;
  }

  addFace(
    faces,
    [
      { x: x0, y: y0, z: z1 },
      { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 },
      { x: x0, y: y1, z: z1 }
    ],
    glyph.top,
    "top",
    { layer, topLetter: glyph.top }
  );

  if (Math.abs(z1 - z0) < 0.001) {
    return;
  }

  const sideLetter = glyph.side;

  if (sides.south < z1) {
    addFace(
      faces,
      [
        { x: x0, y: y1, z: sides.south },
        { x: x1, y: y1, z: sides.south },
        { x: x1, y: y1, z: z1 },
        { x: x0, y: y1, z: z1 }
      ],
      sideLetter,
      "side",
      { layer }
    );
  }

  if (sides.east < z1) {
    addFace(
      faces,
      [
        { x: x1, y: y0, z: sides.east },
        { x: x1, y: y1, z: sides.east },
        { x: x1, y: y1, z: z1 },
        { x: x1, y: y0, z: z1 }
      ],
      sideLetter,
      "side",
      { layer }
    );
  }

  if (sides.west < z1) {
    addFace(
      faces,
      [
        { x: x0, y: y0, z: sides.west },
        { x: x0, y: y1, z: sides.west },
        { x: x0, y: y1, z: z1 },
        { x: x0, y: y0, z: z1 }
      ],
      sideLetter,
      "side",
      { layer }
    );
  }

  if (sides.north < z1) {
    addFace(
      faces,
      [
        { x: x0, y: y0, z: sides.north },
        { x: x1, y: y0, z: sides.north },
        { x: x1, y: y0, z: z1 },
        { x: x0, y: y0, z: z1 }
      ],
      sideLetter,
      "side",
      { layer }
    );
  }
}

function terrainBoxForLayer(
  playData,
  engine,
  state,
  layer,
  x,
  y,
  orangeButtonsPressed = false
) {
  const index = cellIndex(playData, x, y);
  const type = layer.type || "empty";

  if (type === "empty" || type === "hole") {
    return null;
  }

  const top = terrainLayerHeight(layer, state, index, type, orangeButtonsPressed);
  const elevation = layer.elevation ?? 0;
  const orangeWallLowersAsBlock =
    type === "orange_wall" &&
    orangeButtonsPressed &&
    pressedOrangeWallLowersAsBlock(engine, state, x, y, elevation);
  const bottom =
    type === "orange_wall" && orangeButtonsPressed
      ? orangeWallLowersAsBlock
        ? elevation - 1
        : top
      : top > elevation
        ? elevation
        : top - FLOOR_THICKNESS;

  return {
    x0: x,
    x1: x + 1,
    y0: y,
    y1: y + 1,
    z0: bottom,
    z1: top
  };
}

function terrainTopHeightAt(
  playData,
  state,
  typeNames,
  x,
  y,
  orangeButtonsPressed = false
) {
  if (x < 0 || y < 0 || x >= playData.width || y >= playData.height) {
    return -Infinity;
  }

  const layers = terrainLayersAt(playData, state, typeNames, x, y);
  let height = -Infinity;

  layers.forEach((layer) => {
    const type = layer.type || "empty";

    if (type === "empty" || type === "hole") {
      return;
    }

    const index = cellIndex(playData, x, y);
    height = Math.max(
      height,
      terrainLayerHeight(layer, state, index, type, orangeButtonsPressed)
    );
  });

  return height;
}

function exposedTerrainSides(
  playData,
  state,
  typeNames,
  box,
  x,
  y,
  orangeButtonsPressed = false
) {
  const sideFloor = (neighborHeight) => Math.max(box.z0, neighborHeight);

  return {
    east: sideFloor(
      terrainTopHeightAt(playData, state, typeNames, x + 1, y, orangeButtonsPressed)
    ),
    north: sideFloor(
      terrainTopHeightAt(playData, state, typeNames, x, y - 1, orangeButtonsPressed)
    ),
    south: sideFloor(
      terrainTopHeightAt(playData, state, typeNames, x, y + 1, orangeButtonsPressed)
    ),
    west: sideFloor(
      terrainTopHeightAt(playData, state, typeNames, x - 1, y, orangeButtonsPressed)
    )
  };
}

function buildSceneFaces(playData, engine, state) {
  const typeNames = terrainTypeNameByValue(engine.terrainTypes);
  const orangeButtonsPressed = orangeButtonsPressedForState(engine, state);
  const faces = [];

  for (let y = 0; y < playData.height; y += 1) {
    for (let x = 0; x < playData.width; x += 1) {
      const layers = terrainLayersAt(playData, state, typeNames, x, y);

      layers.forEach((layer) => {
        const index = cellIndex(playData, x, y);
        const box = terrainBoxForLayer(
          playData,
          engine,
          state,
          layer,
          x,
          y,
          orangeButtonsPressed
        );

        if (box) {
          addBoxFaces(faces, box, terrainGlyph(layer, state, index, orangeButtonsPressed), {
            layer: 0,
            sides: exposedTerrainSides(
              playData,
              state,
              typeNames,
              box,
              x,
              y,
              orangeButtonsPressed
            )
          });
        }
      });
    }
  }

  for (let index = 0; index < engine.actorCount; index += 1) {
    if (state.actorRemoved[index]) {
      continue;
    }

    const actor = playData.actors[index] || {};
    const type = engine.actorTypes[index] || actor.type || "";

    if (type === "orange_button") {
      const elevation = state.actorElevation[index] || 0;
      addBoxFaces(
        faces,
        {
          x0: state.actorX[index],
          x1: state.actorX[index] + 1,
          y0: state.actorY[index],
          y1: state.actorY[index] + 1,
          z0: elevation,
          z1: elevation
        },
        actorGlyph({ ...actor, type }),
        { layer: 10 }
      );
      continue;
    }

    if (type === "gem") {
      const glyph = actorGlyph({ ...actor, type });
      const z0 = (state.actorElevation[index] || 0) + 0.18;
      const box = {
        x0: state.actorX[index] + 0.3,
        x1: state.actorX[index] + 0.7,
        y0: state.actorY[index] + 0.3,
        y1: state.actorY[index] + 0.7,
        z0,
        z1: z0 + 0.45
      };

      addBoxFaces(
        faces,
        box,
        glyph,
        { layer: 10 }
      );
      addActorSolidFace(faces, box, glyph);
      continue;
    }

    const glyph = actorGlyph({ ...actor, type });
    const z0 = state.actorElevation[index] || 0;
    const box = {
      x0: state.actorX[index] + ACTOR_INSET,
      x1: state.actorX[index] + 1 - ACTOR_INSET,
      y0: state.actorY[index] + ACTOR_INSET,
      y1: state.actorY[index] + 1 - ACTOR_INSET,
      z0,
      z1: z0 + ACTOR_HEIGHT
    };

    addBoxFaces(
      faces,
      box,
      glyph,
      { layer: 10 }
    );
    addActorSolidFace(faces, box, glyph);
  }

  return faces;
}

function projectedFace(face, playData, options) {
  const points = face.points.map((point) => projectPoint(playData, point, options));

  return {
    ...face,
    averageDepth: points.reduce((sum, point) => sum + point.depth, 0) / points.length,
    averageY: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    pitch: clampPitch(options.pitch),
    points
  };
}

function faceSortKey(face) {
  return face.layer * 10000 + face.averageY + face.averageDepth * 0.1 + (face.kind === "top" ? 0.04 : 0);
}

function pointInPolygon(x, y, polygon) {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses =
      (currentPoint.y > y) !== (previousPoint.y > y) &&
      x <
        ((previousPoint.x - currentPoint.x) * (y - currentPoint.y)) /
          ((previousPoint.y - currentPoint.y) || 0.000001) +
          currentPoint.x;

    if (crosses) {
      inside = !inside;
    }
  }

  return inside;
}

function drawLine(canvas, x0, y0, x1, y1, letter) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);

  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + (dx * step) / steps);
    const y = Math.round(y0 + (dy * step) / steps);

    if (canvas[y]?.[x] !== undefined) {
      canvas[y][x] = letter;
    }
  }
}

function drawProjectedFace(canvas, face) {
  const minX = Math.floor(Math.min(...face.points.map((point) => point.x)));
  const maxX = Math.ceil(Math.max(...face.points.map((point) => point.x)));
  const minY = Math.floor(Math.min(...face.points.map((point) => point.y)));
  const maxY = Math.ceil(Math.max(...face.points.map((point) => point.y)));

  if (face.kind === "actor_solid") {
    if (face.pitch === MAX_PITCH) {
      const centerX = Math.round((minX + maxX) / 2);
      const left = centerX - Math.floor(TILE_GRANULARITY / 2);
      const top = maxY - TILE_GRANULARITY;
      drawRect(canvas, left, top, TILE_GRANULARITY, TILE_GRANULARITY, face.letter);
      return;
    }

    const width = Math.max(1, maxX - minX + 1);
    const height = Math.max(1, maxY - minY + 1);
    const topRows = Math.max(0, Math.min(height, Math.round(height * ((MAX_PITCH - face.pitch) / MAX_PITCH))));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (canvas[y]?.[x] === undefined) {
          continue;
        }

        const localX = x - minX;
        const localY = y - minY;
        const inset = height > 2 && localY > 0 && localY < height - 1 ? 0 : 1;

        if (width > 2 && (localX < inset || localX >= width - inset)) {
          continue;
        }

        canvas[y][x] = localY < topRows ? face.topLetter : face.letter;
      }
    }

    return;
  }

  let painted = false;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!canvas[y]?.[x]) {
        continue;
      }

      if (pointInPolygon(x + 0.5, y + 0.5, face.points)) {
        canvas[y][x] = face.letter;
        painted = true;
      }
    }
  }

  if (!painted) {
    for (let index = 0; index < face.points.length; index += 1) {
      const current = face.points[index];
      const next = face.points[(index + 1) % face.points.length];
      drawLine(
        canvas,
        Math.round(current.x),
        Math.round(current.y),
        Math.round(next.x),
        Math.round(next.y),
        face.letter
      );
    }
  }
}

function trimCanvasRows(rows) {
  const nonEmptyRows = rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => /[^ ]/.test(row));

  if (nonEmptyRows.length === 0) {
    return "";
  }

  const top = nonEmptyRows[0].index;
  const bottom = nonEmptyRows[nonEmptyRows.length - 1].index;
  let left = Infinity;
  let right = -Infinity;

  for (let y = top; y <= bottom; y += 1) {
    const row = rows[y];
    const first = row.search(/[^ ]/);
    const last = row.length - 1 - row.split("").reverse().join("").search(/[^ ]/);

    if (first !== -1) {
      left = Math.min(left, first);
      right = Math.max(right, last);
    }
  }

  return rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1)).join("\n");
}

function displayDimensions(playData, yaw) {
  return yaw % 2 === 0
    ? { width: playData.width, height: playData.height }
    : { width: playData.height, height: playData.width };
}

function displayCoordinatesForWorld(playData, yaw, x, y) {
  switch (yaw) {
    case 1:
      return { x: playData.height - 1 - y, y: x };
    case 2:
      return { x: playData.width - 1 - x, y: playData.height - 1 - y };
    case 3:
      return { x: y, y: playData.width - 1 - x };
    default:
      return { x, y };
  }
}

function worldCoordinatesForDisplay(playData, yaw, x, y) {
  switch (yaw) {
    case 1:
      return { x: y, y: playData.height - 1 - x };
    case 2:
      return { x: playData.width - 1 - x, y: playData.height - 1 - y };
    case 3:
      return { x: playData.width - 1 - y, y: x };
    default:
      return { x, y };
  }
}

function terrainTopAt(playData, state, typeNames, x, y, orangeButtonsPressed = false) {
  if (x < 0 || y < 0 || x >= playData.width || y >= playData.height) {
    return null;
  }

  const layers = terrainLayersAt(playData, state, typeNames, x, y);
  let top = null;

  layers.forEach((layer) => {
    const type = layer.type || "empty";

    if (type === "empty" || type === "hole") {
      return;
    }

    const index = cellIndex(playData, x, y);
    const height = terrainLayerHeight(layer, state, index, type, orangeButtonsPressed);

    if (!top || height >= top.height) {
      top = {
        height,
        type
      };
    }
  });

  return top;
}

function terrainBlocksAt(
  playData,
  engine,
  state,
  typeNames,
  x,
  y,
  orangeButtonsPressed = false
) {
  return terrainLayersAt(playData, state, typeNames, x, y)
    .map((layer, layerIndex) => {
      const type = layer.type || "empty";

      if (type === "empty" || type === "hole") {
        return null;
      }

      const index = cellIndex(playData, x, y);
      const elevation = layer.elevation ?? 0;
      const isPressedOrangeWall = type === "orange_wall" && orangeButtonsPressed;
      const lowersAsBlock =
        isPressedOrangeWall &&
        pressedOrangeWallLowersAsBlock(engine, state, x, y, elevation);
      const bottom = isPressedOrangeWall
        ? lowersAsBlock
          ? elevation - 1
          : elevation
        : elevation;
      const top = terrainLayerHeight(layer, state, index, type, orangeButtonsPressed);
      const glyph = terrainGlyph(layer, state, index, orangeButtonsPressed);

      return {
        bottom,
        letter: glyph.top,
        objectId: terrainObjectId(x, y, layerIndex),
        sideLetter: glyph.side,
        surfaceOnly: isPressedOrangeWall && !lowersAsBlock,
        top,
        type
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.bottom - right.bottom || left.top - right.top);
}

function maxTerrainStackHeight(
  playData,
  engine,
  state,
  typeNames,
  orangeButtonsPressed = false
) {
  let maxHeight = 0;

  for (let y = 0; y < playData.height; y += 1) {
    for (let x = 0; x < playData.width; x += 1) {
      terrainBlocksAt(
        playData,
        engine,
        state,
        typeNames,
        x,
        y,
        orangeButtonsPressed
      ).forEach((block) => {
        maxHeight = Math.max(maxHeight, block.top);
      });
    }
  }

  return maxHeight;
}

function actorRows(playData, engine, state, yaw) {
  const rows = new Map();

  for (let index = 0; index < engine.actorCount; index += 1) {
    if (state.actorRemoved[index]) {
      continue;
    }

    const type = engine.actorTypes[index] || playData.actors[index]?.type || "";
    const actor = playData.actors[index] || {};
    const glyph = actorGlyph({ ...actor, type });
    const surfaceOnly = type === "orange_button";
    const display = displayCoordinatesForWorld(
      playData,
      yaw,
      state.actorX[index],
      state.actorY[index]
    );
    const entry = {
      displayX: display.x,
      displayY: display.y,
      elevation: state.actorElevation[index] || 0,
      letter: glyph.top,
      objectId: actorObjectId(index),
      sideLetter: glyph.side,
      surfaceOnly,
      topElevation: (state.actorElevation[index] || 0) + (surfaceOnly ? 0 : 1)
    };

    if (!rows.has(display.y)) {
      rows.set(display.y, []);
    }

    rows.get(display.y).push(entry);
  }

  return rows;
}

function drawRect(canvas, left, top, width, height, letter, ownerCanvas = null, ownerId = "") {
  if (width <= 0 || height <= 0) {
    return;
  }

  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (canvas[y]?.[x] !== undefined) {
        canvas[y][x] = letter;
        if (ownerCanvas && ownerId) {
          ownerCanvas[y][x] = ownerId;
        }
      }
    }
  }
}

function drawRectIfBlank(
  canvas,
  left,
  top,
  width,
  height,
  letter,
  ownerCanvas = null,
  ownerId = ""
) {
  if (width <= 0 || height <= 0) {
    return;
  }

  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (canvas[y]?.[x] === " ") {
        canvas[y][x] = letter;
        if (ownerCanvas && ownerId) {
          ownerCanvas[y][x] = ownerId;
        }
      }
    }
  }
}

function markBlankOwnerRect(canvas, ownerCanvas, left, top, width, height, ownerId) {
  if (!ownerCanvas || !ownerId || width <= 0 || height <= 0) {
    return;
  }

  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (canvas[y]?.[x] === " ") {
        ownerCanvas[y][x] = ownerId;
      }
    }
  }
}

function drawTerrainTopForLevel(
  canvas,
  block,
  screenX,
  baseY,
  topRows,
  sideRows,
  level,
  ownerCanvas = null
) {
  if (block.top !== level) {
    return;
  }

  drawRect(
    canvas,
    screenX,
    baseY - block.top * sideRows,
    TILE_GRANULARITY,
    topRows,
    block.letter,
    ownerCanvas,
    block.objectId
  );
}

function drawTerrainSideForLevel(
  canvas,
  block,
  screenX,
  baseY,
  topRows,
  sideRows,
  frontHeight,
  level,
  ownerCanvas = null
) {
  if (sideRows <= 0 || block.surfaceOnly) {
    return;
  }

  if (block.top > block.bottom) {
    if (level < block.bottom || level >= block.top || frontHeight >= level + 1) {
      return;
    }

    const exposedBottom = Math.max(level, frontHeight);
    drawRect(
      canvas,
      screenX,
      baseY - (level + 1) * sideRows + topRows,
      TILE_GRANULARITY,
      (level + 1 - exposedBottom) * sideRows,
      block.sideLetter,
      ownerCanvas,
      block.objectId
    );
    return;
  }

  if (block.top !== level || frontHeight >= block.top) {
    return;
  }

  const exposedBottom = Math.max(block.top - 1, frontHeight);
  drawRect(
    canvas,
    screenX,
    baseY - block.top * sideRows + topRows,
    TILE_GRANULARITY,
    (block.top - exposedBottom) * sideRows,
    block.sideLetter,
    ownerCanvas,
    block.objectId
  );
}

function actorCells(playData, engine, state, yaw) {
  const cells = new Map();

  for (let index = 0; index < engine.actorCount; index += 1) {
    if (state.actorRemoved[index]) {
      continue;
    }

    const type = engine.actorTypes[index] || playData.actors[index]?.type || "";

    if (type === "orange_button") {
      continue;
    }

    const actor = playData.actors[index] || {};
    const glyph = actorGlyph({ ...actor, type });
    const display = displayCoordinatesForWorld(
      playData,
      yaw,
      state.actorX[index],
      state.actorY[index]
    );
    const key = `${display.x},${display.y}`;
    const entry = {
      displayX: display.x,
      displayY: display.y,
      elevation: state.actorElevation[index] || 0,
      letter: glyph.top,
      objectId: actorObjectId(index),
      sideLetter: glyph.side
    };

    if (!cells.has(key)) {
      cells.set(key, []);
    }

    cells.get(key).push(entry);
  }

  return cells;
}

function visibleObjectIdsFromOwnerCanvas(ownerCanvas) {
  return new Set(ownerCanvas ? ownerCanvas.flat().filter(Boolean) : []);
}

function maxRenderedActorHeight(engine, state) {
  return Math.max(
    0,
    ...Array.from({ length: engine.actorCount }, (_, index) => {
      if (state.actorRemoved[index]) {
        return 0;
      }

      const elevation = state.actorElevation[index] || 0;
      return engine.actorTypes[index] === "orange_button" ? elevation : elevation + 1;
    })
  );
}

function renderAsciiSideScene(playData, engine, state, options, trackOwners = false) {
  const yaw = normalizeYaw(options.yaw);
  const typeNames = terrainTypeNameByValue(engine.terrainTypes);
  const orangeButtonsPressed = orangeButtonsPressedForState(engine, state);
  const dimensions = displayDimensions(playData, yaw);
  const maxTerrainHeight = maxTerrainStackHeight(
    playData,
    engine,
    state,
    typeNames,
    orangeButtonsPressed
  );
  const maxActorHeight = maxRenderedActorHeight(engine, state);
  const maxHeight = Math.max(1, maxTerrainHeight, maxActorHeight);
  const baseline = maxHeight * TILE_GRANULARITY;
  const width = dimensions.width * TILE_GRANULARITY;
  const height = baseline + 1;
  const canvas = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const ownerCanvas = trackOwners
    ? Array.from({ length: height }, () => Array.from({ length: width }, () => ""))
    : null;
  const actorsByCell = actorCells(playData, engine, state, yaw);

  for (let displayY = dimensions.height - 1; displayY >= 0; displayY -= 1) {
    for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
      const screenX = displayX * TILE_GRANULARITY;
      const { x, y } = worldCoordinatesForDisplay(playData, yaw, displayX, displayY);
      const blocks = terrainBlocksAt(
        playData,
        engine,
        state,
        typeNames,
        x,
        y,
        orangeButtonsPressed
      );

      blocks.forEach((block) => {
        if (block.surfaceOnly) {
          return;
        }

        const letter = block.sideLetter;

        if (block.top > block.bottom) {
          drawRectIfBlank(
            canvas,
            screenX,
            baseline - block.top * TILE_GRANULARITY,
            TILE_GRANULARITY,
            (block.top - block.bottom) * TILE_GRANULARITY,
            letter,
            ownerCanvas,
            block.objectId
          );
        } else {
          drawRectIfBlank(
            canvas,
            screenX,
            baseline,
            TILE_GRANULARITY,
            1,
            letter,
            ownerCanvas,
            block.objectId
          );
        }
      });

      const actors = actorsByCell.get(`${displayX},${displayY}`) || [];
      actors
        .sort((left, right) => left.elevation - right.elevation)
        .forEach((actor) => {
          drawRectIfBlank(
            canvas,
            screenX,
            baseline - (actor.elevation + 1) * TILE_GRANULARITY,
            TILE_GRANULARITY,
            TILE_GRANULARITY,
            actor.sideLetter,
            ownerCanvas,
            actor.objectId
          );
        });
    }
  }

  return {
    text: trimCanvasRows(canvas.map((row) => row.join(""))),
    visibleObjectIds: visibleObjectIdsFromOwnerCanvas(ownerCanvas)
  };
}

function renderAsciiLayeredScene(playData, engine, state, options, trackOwners = false) {
  const yaw = normalizeYaw(options.yaw);
  const pitch = clampPitch(options.pitch);
  const typeNames = terrainTypeNameByValue(engine.terrainTypes);
  const orangeButtonsPressed = orangeButtonsPressedForState(engine, state);
  const dimensions = displayDimensions(playData, yaw);
  const topRows = TILE_GRANULARITY - pitch;
  const sideRows = pitch;
  const rowStep = Math.max(1, topRows);
  const maxTerrainHeight = maxTerrainStackHeight(
    playData,
    engine,
    state,
    typeNames,
    orangeButtonsPressed
  );
  const maxActorHeight = maxRenderedActorHeight(engine, state);
  const topMargin = Math.max(maxTerrainHeight, maxActorHeight) * sideRows + 1;
  const width = dimensions.width * TILE_GRANULARITY;
  const height =
    topMargin +
    dimensions.height * rowStep +
    TILE_GRANULARITY +
    Math.max(1, sideRows) +
    2;
  const canvas = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  const ownerCanvas = trackOwners
    ? Array.from({ length: height }, () => Array.from({ length: width }, () => ""))
    : null;
  const actorsByRow = actorRows(playData, engine, state, yaw);
  const maxSceneHeight = Math.max(maxTerrainHeight, maxActorHeight);

  for (let displayY = 0; displayY < dimensions.height; displayY += 1) {
    const baseY = topMargin + displayY * rowStep;
    const rowActors = actorsByRow.get(displayY) || [];

    for (let level = 0; level <= maxSceneHeight; level += 1) {
      for (let displayX = 0; displayX < dimensions.width; displayX += 1) {
        const { x, y } = worldCoordinatesForDisplay(playData, yaw, displayX, displayY);
        const blocks = terrainBlocksAt(
          playData,
          engine,
          state,
          typeNames,
          x,
          y,
          orangeButtonsPressed
        );
        const screenX = displayX * TILE_GRANULARITY;

        semanticTerrainLayersAt(playData, state, typeNames, x, y)
          .map((layer, layerIndex) => ({ layer, layerIndex }))
          .filter(({ layer }) => layer.type === "empty" || layer.type === "hole")
          .forEach(({ layer, layerIndex }) => {
            const elevation = layer.elevation ?? 0;
            if (elevation === level) {
              markBlankOwnerRect(
                canvas,
                ownerCanvas,
                screenX,
                baseY - elevation * sideRows,
                TILE_GRANULARITY,
                topRows,
                terrainObjectId(x, y, layerIndex)
              );
            }
          });

        if (blocks.length === 0) {
          continue;
        }

        const front = worldCoordinatesForDisplay(playData, yaw, displayX, displayY + 1);
        const frontTop = terrainTopAt(
          playData,
          state,
          typeNames,
          front.x,
          front.y,
          orangeButtonsPressed
        );
        const frontHeight = frontTop?.height ?? -1;

        blocks.forEach((block) => {
          drawTerrainTopForLevel(
            canvas,
            block,
            screenX,
            baseY,
            topRows,
            sideRows,
            level,
            ownerCanvas
          );
        });

        blocks.forEach((block) => {
          drawTerrainSideForLevel(
            canvas,
            block,
            screenX,
            baseY,
            topRows,
            sideRows,
            frontHeight,
            level,
            ownerCanvas
          );
        });
      }

      rowActors
        .filter(
          (actor) =>
            actor.topElevation === level ||
            (!actor.surfaceOnly && actor.elevation === level)
        )
        .sort(
          (left, right) =>
            left.displayX - right.displayX ||
            left.elevation - right.elevation ||
            Number(right.surfaceOnly) - Number(left.surfaceOnly)
        )
        .forEach((actor) => {
          const screenX = actor.displayX * TILE_GRANULARITY;
          const topY = baseY - actor.topElevation * sideRows;

          if (actor.topElevation === level) {
            drawRect(
              canvas,
              screenX,
              topY,
              TILE_GRANULARITY,
              topRows,
              actor.letter,
              ownerCanvas,
              actor.objectId
            );
          }

          if (!actor.surfaceOnly && actor.elevation === level) {
            drawRect(
              canvas,
              screenX,
              topY + topRows,
              TILE_GRANULARITY,
              sideRows,
              actor.sideLetter,
              ownerCanvas,
              actor.objectId
            );
          }
        });
    }
  }

  return {
    text: trimCanvasRows(canvas.map((row) => row.join(""))),
    visibleObjectIds: visibleObjectIdsFromOwnerCanvas(ownerCanvas)
  };
}

function renderAsciiDetailed(playData, engine, state, options, trackOwners = false) {
  if (clampPitch(options.pitch) === MAX_PITCH) {
    return renderAsciiSideScene(playData, engine, state, options, trackOwners);
  }

  return renderAsciiLayeredScene(playData, engine, state, options, trackOwners);
}

function renderAscii(playData, engine, state, options) {
  return renderAsciiDetailed(playData, engine, state, options, false).text;
}

const WORLD_DIRECTION_VECTORS = Object.freeze({
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  up: { dx: 0, dy: -1 }
});

function cameraRelativeDirection(worldDirection, yaw) {
  const normalized = normalizeDirection(worldDirection) || "up";
  const target = WORLD_DIRECTION_VECTORS[normalized];
  const screenDirections = [
    ["up", "U"],
    ["down", "D"],
    ["left", "L"],
    ["right", "R"]
  ];

  return (
    screenDirections.find(([, move]) => {
      const vector = screenMoveVector(move, yaw);
      return vector?.dx === target.dx && vector?.dy === target.dy;
    })?.[0] || normalized
  );
}

function semanticObjectName(type, source, yaw) {
  if (type === "circle_player") {
    return "player";
  }

  if (type === "ice_slope" || type === "puncher") {
    return `${type}_${cameraRelativeDirection(source?.direction, yaw)}`;
  }

  return type || "unknown";
}

function semanticTerrainObjectName(type, source, yaw, state, index, orangeButtonsPressed) {
  if (type === "player_lift") {
    return state.liftRaised[index] === 1
      ? "player_lift_raised"
      : "player_lift_lowered";
  }

  if (type === "orange_wall") {
    return "orange_wall";
  }

  return semanticObjectName(type, source, yaw);
}

function jsonObservationObjects(context) {
  const { engine, options, playData, state } = context;
  const typeNames = terrainTypeNameByValue(engine.terrainTypes);
  const orangeButtonsPressed = orangeButtonsPressedForState(engine, state);
  const objects = [];

  for (let y = 0; y < playData.height; y += 1) {
    for (let x = 0; x < playData.width; x += 1) {
      const index = cellIndex(playData, x, y);
      semanticTerrainLayersAt(playData, state, typeNames, x, y).forEach((layer, layerIndex) => {
        const type = layer.type || "empty";
        objects.push({
          elevation:
            type === "orange_wall" && orangeButtonsPressed
              ? (layer.elevation ?? 0) - 1
              : layer.elevation ?? 0,
          id: terrainObjectId(x, y, layerIndex),
          name: semanticTerrainObjectName(
            type,
            layer,
            options.yaw,
            state,
            index,
            orangeButtonsPressed
          ),
          x,
          y
        });
      });
    }
  }

  for (let index = 0; index < engine.actorCount; index += 1) {
    if (state.actorRemoved[index]) {
      continue;
    }

    const source = playData.actors[index] || {};
    const type = engine.actorTypes[index] || source.type || "unknown";
    objects.push({
      elevation: state.actorElevation[index] || 0,
      id: actorObjectId(index),
      name: semanticObjectName(type, source, options.yaw),
      x: state.actorX[index],
      y: state.actorY[index]
    });
  }

  return objects;
}

function hiddenObjectNameMap(seed) {
  const normalizedSeed = String(seed || "mazebench-json");
  const names = JSON_OBJECT_NAME_UNIVERSE.slice().sort((left, right) => {
    const leftHash = crypto.createHash("sha256").update(`${normalizedSeed}:${left}`).digest("hex");
    const rightHash = crypto.createHash("sha256").update(`${normalizedSeed}:${right}`).digest("hex");
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });

  return new Map(names.map((name, index) => [name, HIDDEN_NAME_ALPHABET[index]]));
}

function hiddenObjectName(name, seed, mapping) {
  if (name === "player" || name === "gem") {
    return name;
  }

  if (mapping.has(name)) {
    return mapping.get(name);
  }

  const hash = crypto.createHash("sha256").update(`${seed}:${name}`).digest();
  const first = HIDDEN_NAME_ALPHABET[hash[0] % HIDDEN_NAME_ALPHABET.length];
  const second = HIDDEN_NAME_ALPHABET[hash[1] % HIDDEN_NAME_ALPHABET.length];
  return `${first}${second}`;
}

function buildJsonObservation(context, observationOptions = {}) {
  applyCollectedGemsToContext(context);
  const omniscient = observationOptions.omniscient === true;
  const hideNames = observationOptions.hideNames === true;
  const hideNamesSeed = String(observationOptions.hideNamesSeed || "mazebench-json");
  const visibleObjectIds = omniscient
    ? null
    : renderAsciiDetailed(
        context.playData,
        context.engine,
        context.state,
        context.options,
        true
      ).visibleObjectIds;
  const nameMapping = hideNames ? hiddenObjectNameMap(hideNamesSeed) : null;
  const grouped = {};

  jsonObservationObjects(context)
    .filter((object) => omniscient || visibleObjectIds.has(object.id))
    .forEach((object) => {
      const name = hideNames
        ? hiddenObjectName(object.name, hideNamesSeed, nameMapping)
        : object.name;
      grouped[name] ||= [];
      grouped[name].push([object.x, object.y, object.elevation]);
    });

  return {
    observation_mode: "json",
    omniscient,
    hide_names: hideNames,
    room: {
      id: context.level.id,
      width: context.playData.width,
      height: context.playData.height
    },
    camera: {
      view: VIEW_NAMES[context.options.pitch],
      yaw: context.options.yaw
    },
    coordinate_format: "[x,y,elevation]",
    objects: grouped
  };
}

function renderAsciiProjected(playData, engine, state, options) {
  const pitch = clampPitch(options.pitch);
  const projectedFaces = buildSceneFaces(playData, engine, state)
    .filter((face) => pitch !== 0 || face.kind === "top")
    .filter((face) =>
      pitch !== MAX_PITCH ||
      face.kind === "actor_solid" ||
      (face.kind === "side" && face.layer < 10)
    )
    .map((face) => projectedFace(face, playData, options));

  if (projectedFaces.length === 0) {
    return "";
  }

  const minX = Math.floor(Math.min(...projectedFaces.flatMap((face) => face.points.map((point) => point.x)))) - 2;
  const maxX = Math.ceil(Math.max(...projectedFaces.flatMap((face) => face.points.map((point) => point.x)))) + 2;
  const minY = Math.floor(Math.min(...projectedFaces.flatMap((face) => face.points.map((point) => point.y)))) - 2;
  const maxY = Math.ceil(Math.max(...projectedFaces.flatMap((face) => face.points.map((point) => point.y)))) + 2;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const canvas = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));

  projectedFaces
    .map((face) => ({
      ...face,
      points: face.points.map((point) => ({
        ...point,
        x: point.x - minX,
        y: point.y - minY
      }))
    }))
    .sort((left, right) => faceSortKey(left) - faceSortKey(right))
    .forEach((face) => drawProjectedFace(canvas, face));

  return trimCanvasRows(canvas.map((row) => row.join("")));
}

function activePlayerEntries(context) {
  const entries = [];

  for (let index = 0; index < context.engine.actorCount; index += 1) {
    if (
      !context.state.actorRemoved[index] &&
      isPlayerActorType(context.engine.actorTypes[index])
    ) {
      entries.push({
        elevation: context.state.actorElevation[index] || 0,
        index,
        source: context.playData.actors[index] || {},
        type: context.engine.actorTypes[index],
        x: context.state.actorX[index],
        y: context.state.actorY[index]
      });
    }
  }

  return entries;
}

function activePlayerEntry(context) {
  return activePlayerEntries(context)[0] || null;
}

function isPlayerDead(context) {
  return !activePlayerEntry(context);
}

function allowedCommandsForContext(context) {
  return isPlayerDead(context)
    ? Array.from(DEAD_ALLOWED_COMMANDS)
    : Array.from(ALIVE_ALLOWED_COMMANDS);
}

function playerTileKey(context, player, includeElevation = false) {
  if (!context?.level?.id || !player) {
    return null;
  }

  const base = `${context.level.id}:${player.x},${player.y}`;
  return includeElevation ? `${base},${player.elevation ?? 0}` : base;
}

function recordPlayerVisit(context) {
  const stats = context?.stats;
  const player = activePlayerEntry(context);

  if (!stats || !player) {
    return;
  }

  const tileKey = playerTileKey(context, player, false);
  const elevationTileKey = playerTileKey(context, player, true);

  if (tileKey) {
    stats.uniqueTiles.add(tileKey);
  }

  if (elevationTileKey) {
    stats.uniqueElevationTiles.add(elevationTileKey);
  }

  stats.visitedRooms.add(context.level.id);
  stats.minElevation =
    stats.minElevation === null ? player.elevation : Math.min(stats.minElevation, player.elevation);
  stats.maxElevation =
    stats.maxElevation === null ? player.elevation : Math.max(stats.maxElevation, player.elevation);
}

const LEGACY_GEM_ID_PATTERN = /^(.*):gem:(?:-?\d+:)?(-?\d+),(-?\d+),(-?\d+)$/;

function normalizeGemCollectionId(value) {
  const id = String(value || "");
  const match = id.match(LEGACY_GEM_ID_PATTERN);
  return match ? `${match[1]}:gem:${match[2]},${match[3]},${match[4]}` : id;
}

function normalizeCollectedGemIds(ids) {
  if (!(ids instanceof Set) || ids.size === 0) {
    return ids;
  }

  const normalized = Array.from(ids, normalizeGemCollectionId);
  ids.clear();
  normalized.forEach((id) => ids.add(id));
  return ids;
}

function terminalGemId(context, index) {
  const actor = context.playData.actors[index] || {};
  const x = actor.x ?? context.state.actorX[index] ?? 0;
  const y = actor.y ?? context.state.actorY[index] ?? 0;
  const elevation = actor.elevation ?? context.state.actorElevation[index] ?? 0;
  return `${context.level.id}:gem:${x},${y},${elevation}`;
}

function applyCollectedGemsToContext(context) {
  if (!context?.stats?.collectedGemIds?.size) {
    return;
  }

  normalizeCollectedGemIds(context.stats.collectedGemIds);

  for (let index = 0; index < context.engine.actorCount; index += 1) {
    const type = context.engine.actorTypes[index] || context.playData.actors[index]?.type || "";

    if (type === "gem" && context.stats.collectedGemIds.has(terminalGemId(context, index))) {
      context.state.actorRemoved[index] = 1;
    }
  }
}

function visibleGemIds(context) {
  applyCollectedGemsToContext(context);
  const ids = [];

  for (let index = 0; index < context.engine.actorCount; index += 1) {
    const type = context.engine.actorTypes[index] || context.playData.actors[index]?.type || "";

    if (type === "gem" && !context.state.actorRemoved[index]) {
      ids.push(terminalGemId(context, index));
    }
  }

  return ids;
}

function recordCollectedGems(context, beforeIds) {
  const stats = context?.stats;

  if (!stats) {
    return [];
  }

  normalizeCollectedGemIds(stats.collectedGemIds);
  const before = new Set(Array.from(beforeIds || [], normalizeGemCollectionId));
  const after = new Set(visibleGemIds(context));
  const collected = [];

  before.forEach((id) => {
    if (!after.has(id) && !stats.collectedGemIds.has(id)) {
      stats.collectedGemIds.add(id);
      collected.push(id);
    }
  });

  return collected;
}

function recordMoveStats(context, move, result, before) {
  const stats = context?.stats;

  if (!stats || !MOVE_ACTIONS.has(move)) {
    return;
  }

  const afterPlayer = activePlayerEntry(context);
  const roomChanged = before.levelId !== context.level.id;
  const playerMoved =
    before.player &&
    afterPlayer &&
    (before.player.x !== afterPlayer.x ||
      before.player.y !== afterPlayer.y ||
      before.player.elevation !== afterPlayer.elevation);
  const moved = Boolean(result === true || result?.moved || roomChanged || playerMoved);

  stats.actionCounts.move += 1;
  stats.moveAttempts[move] += 1;

  if (moved) {
    stats.successfulMoves += 1;
    stats.moveSuccesses[move] += 1;
  } else {
    stats.blockedMoves += 1;
  }

  if (roomChanged) {
    stats.roomTransitions += 1;
  }

  if (before.player && afterPlayer && before.player.elevation !== afterPlayer.elevation) {
    const delta = afterPlayer.elevation - before.player.elevation;
    stats.elevationChanges += 1;

    if (delta > 0) {
      stats.elevationGain += delta;
    } else {
      stats.elevationLoss += Math.abs(delta);
    }
  }

  if (before.levelId === context.level.id) {
    recordCollectedGems(context, before.visibleGemIds);
  }

  recordPlayerVisit(context);
}

function edgeTransitionForMove(context, dx, dy) {
  const players = activePlayerEntries(context);

  if (players.length !== 1) {
    return null;
  }

  const player = players[0];
  const onEdge =
    (dx < 0 && player.x === 0) ||
    (dx > 0 && player.x === context.playData.width - 1) ||
    (dy < 0 && player.y === 0) ||
    (dy > 0 && player.y === context.playData.height - 1);

  if (!onEdge) {
    return null;
  }

  const sourceType = transitionSurfaceTypeAt(
    context.playData,
    context.state,
    context.engine,
    player.x,
    player.y,
    player.elevation
  );

  if (!sourceType) {
    return null;
  }

  const nextLevelId = adjacentWorldLevelId(
    context.level.id,
    dx,
    dy,
    context.playData.worldColumns,
    context.playData.worldRows
  );

  if (!nextLevelId) {
    return null;
  }

  const nextLevel = getLevel(context.game, nextLevelId);

  if (!nextLevel) {
    return false;
  }

  const nextPlayData = getLevelState(context.game, nextLevel);
  const nextRoom = buildRuntimeRoom(context.mazeEngine, nextPlayData);
  const targetX = dx < 0
    ? nextRoom.playData.width - 1
    : dx > 0
      ? 0
      : Math.min(player.x, nextRoom.playData.width - 1);
  const targetY = dy < 0
    ? nextRoom.playData.height - 1
    : dy > 0
      ? 0
      : Math.min(player.y, nextRoom.playData.height - 1);
  const targetSurfaceType = transitionSurfaceTypeAt(
    nextRoom.playData,
    nextRoom.state,
    nextRoom.engine,
    targetX,
    targetY,
    player.elevation
  );
  const targetType =
    targetSurfaceType ||
    transitionHoleTypeAt(nextRoom.playData, nextRoom.state, nextRoom.engine, targetX, targetY, player.elevation) ||
    "empty";

  if (!isAllowedEdgeTransition(sourceType, targetType)) {
    return false;
  }

  const transferActor = cloneTransferActor({
    ...player.source,
    type: player.type,
    elevation: player.elevation,
    x: targetX,
    y: targetY
  });

  context.level = nextLevel;
  context.playData = {
    ...nextRoom.playData,
    actors: nextRoom.playData.actors
      .filter((actor) => !isPlayerActorType(actor.type))
      .concat(transferActor)
  };
  context.engine = context.mazeEngine.createEngine(context.playData);
  context.state = context.engine.cloneState(context.engine.initialState);

  return true;
}

function isAllowedEdgeTransition(sourceType, targetType) {
  if (!sourceType || !targetType) {
    return false;
  }

  if (sourceType === "floor" && targetType === "hole") {
    return true;
  }

  return sourceType === targetType;
}

function moveCommand(move) {
  return MOVE_ACTIONS.get(String(move || "").toUpperCase())?.label.toLowerCase() || "";
}

function recordReplayAction(context, command, normalizedAction, args = {}) {
  const stats = context?.stats;

  if (!stats || !command) {
    return null;
  }

  const record = {
    args,
    command,
    normalized_action: normalizedAction,
    turn: stats.actions.length + 1,
    valid: true
  };

  stats.actions.push(record);
  return record;
}

function replayActionCommands(context) {
  return (context?.stats?.actions || [])
    .filter((record) => record && record.valid !== false)
    .map((record) => String(record.command || "").trim())
    .filter(Boolean);
}

function applyMove(context, move) {
  const action = screenMoveVector(move, context.options.yaw);
  if (!action) {
    return null;
  }

  if (isPlayerDead(context)) {
    return { moved: false, playerDead: true };
  }

  const command = moveCommand(move);

  applyCollectedGemsToContext(context);
  const beforeStats = {
    levelId: context.level.id,
    player: activePlayerEntry(context),
    visibleGemIds: visibleGemIds(context)
  };
  const previous = captureHistorySnapshot(context);
  const edgeTransition = edgeTransitionForMove(context, action.dx, action.dy);

  if (edgeTransition !== null) {
    if (edgeTransition) {
      context.history.push(previous);
      context.entrySnapshot = captureRoomSnapshot(context);
    }

    recordMoveStats(context, move, edgeTransition, beforeStats);
    recordReplayAction(context, command, "move", { direction: command });
    return edgeTransition;
  }

  const result = context.engine.move(context.state, action.dx, action.dy);

  if (result?.moved) {
    context.history.push(previous);
  }

  recordMoveStats(context, move, result, beforeStats);
  recordReplayAction(context, command, "move", { direction: command });
  return result;
}

function undoMove(context) {
  const previous = context.history.pop();
  const stats = context.stats;

  if (stats) {
    stats.actionCounts.undo += 1;
  }

  recordReplayAction(context, "undo", "undo");

  if (!previous) {
    return false;
  }

  restoreRoomSnapshot(context, previous.room);
  context.entrySnapshot = cloneRoomSnapshot(previous.entrySnapshot) || captureRoomSnapshot(context);
  recordPlayerVisit(context);
  return true;
}

function resetLevel(context) {
  const stats = context.stats;

  if (stats) {
    stats.actionCounts.reset += 1;
  }

  recordReplayAction(context, "reset", "reset_level");

  if (!context.entrySnapshot) {
    return false;
  }

  restoreRoomSnapshot(context, context.entrySnapshot);
  context.entrySnapshot = captureRoomSnapshot(context);
  context.history.length = 0;
  applyCollectedGemsToContext(context);
  recordPlayerVisit(context);
  return true;
}

function applyMoves(context, moves) {
  for (const move of String(moves || "").toUpperCase()) {
    applyMove(context, move);
  }
}

function rotateCamera(context, direction) {
  const normalized = String(direction || "").toLowerCase();
  const stats = context?.stats;

  if (isPlayerDead(context)) {
    return false;
  }

  if (normalized === "up") {
    context.options.pitch = clampPitch(context.options.pitch - 1);
    if (stats) {
      stats.actionCounts.rotateCamera += 1;
      stats.pitchRotations.up += 1;
    }
  } else if (normalized === "down") {
    context.options.pitch = clampPitch(context.options.pitch + 1);
    if (stats) {
      stats.actionCounts.rotateCamera += 1;
      stats.pitchRotations.down += 1;
    }
  } else if (normalized === "left") {
    context.options.yaw = normalizeYaw(context.options.yaw - 1);
    if (stats) {
      stats.actionCounts.rotateCamera += 1;
      stats.yawRotations.left += 1;
    }
  } else if (normalized === "right") {
    context.options.yaw = normalizeYaw(context.options.yaw + 1);
    if (stats) {
      stats.actionCounts.rotateCamera += 1;
      stats.yawRotations.right += 1;
    }
  } else {
    return false;
  }

  recordReplayAction(context, `rotate camera ${normalized}`, "rotate_camera", {
    direction: normalized
  });
  return true;
}

function solverDirectionsForYaw(yaw) {
  return Array.from(MOVE_ACTIONS.keys())
    .map((label) => ({
      label,
      ...screenMoveVector(label, yaw)
    }))
    .filter((direction) => Number.isFinite(direction.dx) && Number.isFinite(direction.dy));
}

async function solveContext(context) {
  const mazeSolver = loadMazeSolver();

  return mazeSolver.solveWithAStar(context.engine, {
    directions: solverDirectionsForYaw(context.options.yaw),
    maxExpandedStates: context.options.maxExpandedStates
  });
}

function renderScreen(context) {
  applyCollectedGemsToContext(context);
  const { engine, level, options, playData, state } = context;
  const solved = engine.isSolved(state) ? " solved" : "";
  const header =
    `${playData.gameId} ${level.id} | view=${VIEW_NAMES[options.pitch]} yaw=${options.yaw}${solved}`;
  return `${header}\n${renderAscii(playData, engine, state, options)}`;
}

async function buildJsonPayload(context) {
  applyCollectedGemsToContext(context);
  const player = activePlayerEntry(context);
  const playerDead = !player;
  const observation = renderAscii(context.playData, context.engine, context.state, context.options);
  const payload = {
    allowedCommands: allowedCommandsForContext(context),
    deathMessage: playerDead ? DEATH_MESSAGE : "",
    gameId: context.playData.gameId,
    height: context.playData.height,
    inputMoves: context.options.moves || "",
    levelId: context.level.id,
    pitch: context.options.pitch,
    player,
    playerDead,
    solved: context.engine.isSolved(context.state),
    view: VIEW_NAMES[context.options.pitch],
    width: context.playData.width,
    yaw: context.options.yaw,
    observation,
    screen: renderScreen(context)
  };

  if (context.options.solve) {
    const solution = await solveContext(context);
    payload.solution = {
      expanded: solution.expanded ?? null,
      maxExpanded: solution.maxExpanded ?? null,
      moves: solution.moves ?? null,
      path: solution.path || "",
      status: solution.status
    };
  }

  return payload;
}

function countTotalGems(game) {
  return (game?.levels || []).reduce((total, level) => {
    try {
      const state = getLevelState(game, level);
      return total + (state.actors || []).filter((actor) => actor.type === "gem").length;
    } catch (_error) {
      return total;
    }
  }, 0);
}

function totalRoomCount(game) {
  return game?.worldMap?.byPosition?.size || game?.levels?.length || 0;
}

function buildScorecard(context, nowMs = Date.now()) {
  const stats = context.stats || createRunStats(context.level?.id || "");
  normalizeCollectedGemIds(stats.collectedGemIds);
  const player = activePlayerEntry(context);
  const durationMs = nowMs - stats.startedAtMs;
  const totalGems = countTotalGems(context.game);
  const totalRooms = totalRoomCount(context.game);
  const collectedGemCount = stats.collectedGemIds.size;
  const gameWonGemCount = normalizeGameWonGemCount(context.options?.gameWonGemCount);
  const totalActions =
    stats.actionCounts.move +
    stats.actionCounts.rotateCamera +
    stats.actionCounts.undo +
    stats.actionCounts.reset;

  return JSON.stringify(
    {
      scorecard: {
        result: {
          won: collectedGemCount >= gameWonGemCount,
          percent: (100 * collectedGemCount) / gameWonGemCount
        },
        gems: {
          collected: collectedGemCount,
          total: totalGems,
          ids: Array.from(stats.collectedGemIds).sort()
        },
        rooms: {
          current: context.level.id,
          starting: stats.startingLevelId,
          visited: stats.visitedRooms.size,
          total: totalRooms,
          ids: Array.from(stats.visitedRooms).sort()
        },
        tiles: {
          visited: stats.uniqueTiles.size
        },
        duration: {
          milliseconds: durationMs,
          seconds: Math.round(durationMs / 1000)
        },
        current_position: player
          ? {
              level_id: context.level.id,
              x: player.x,
              y: player.y,
              elevation: player.elevation
            }
          : null,
        actions: {
          total: totalActions,
          moves: {
            attempted: stats.actionCounts.move,
            successful: stats.successfulMoves,
            blocked: stats.blockedMoves,
            room_transitions: stats.roomTransitions,
            by_direction: Object.fromEntries(
              Array.from(MOVE_ACTIONS.entries()).map(([key, action]) => [
                action.label.toLowerCase(),
                {
                  attempted: stats.moveAttempts[key] || 0,
                  successful: stats.moveSuccesses[key] || 0
                }
              ])
            )
          },
          camera: {
            total: stats.actionCounts.rotateCamera,
            pitch_up: stats.pitchRotations.up,
            pitch_down: stats.pitchRotations.down,
            yaw_left: stats.yawRotations.left,
            yaw_right: stats.yawRotations.right
          },
          undo: stats.actionCounts.undo,
          reset: stats.actionCounts.reset
        },
        elevation: {
          changes: stats.elevationChanges,
          gain: stats.elevationGain,
          loss: stats.elevationLoss,
          min: stats.minElevation,
          max: stats.maxElevation
        }
      }
    },
    null,
    2
  );
}

function isGameWon(context) {
  normalizeCollectedGemIds(context?.stats?.collectedGemIds);
  const collectedGemCount = context?.stats?.collectedGemIds?.size || 0;
  const gameWonGemCount = normalizeGameWonGemCount(context?.options?.gameWonGemCount);
  return collectedGemCount >= gameWonGemCount;
}

function defaultTerminalReplayDir(date = new Date()) {
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return path.join(DEFAULT_TERMINAL_REPLAY_ROOT, timestamp);
}

function initialReplayView(context) {
  const pitch = clampPitch(context?.stats?.initialPitch ?? context?.options?.pitch);
  return VIEW_NAMES[pitch] || "top-diagonal";
}

function initialReplayYaw(context) {
  return normalizeYaw(context?.stats?.initialYaw ?? context?.options?.yaw);
}

function buildReplayRow(context, scorecard) {
  const stats = context.stats || {};
  const actionRecords = (stats.actions || []).map((record) => ({ ...record }));
  const gameWonGemCount = normalizeGameWonGemCount(context.options?.gameWonGemCount);
  const replay = {
    actions: actionRecords,
    game_id: context.options?.gameId || context.game?.id || "maze",
    game_won_gem_count: gameWonGemCount,
    initial: {
      view: initialReplayView(context),
      yaw: initialReplayYaw(context)
    },
    scorecard,
    start_level_id: stats.startingLevelId || context.level.id
  };

  return {
    info: {
      mazebench: {
        game_id: replay.game_id,
        game_won_gem_count: gameWonGemCount,
        level_id: replay.start_level_id,
        view: replay.initial.view,
        yaw: replay.initial.yaw
      }
    },
    maze_actions: actionRecords,
    maze_replay: replay,
    maze_scorecard: scorecard
  };
}

function writeReplayJsonFiles(outDir, row) {
  const replayPath = path.join(outDir, "maze_replay.json");
  const resultsPath = path.join(outDir, "results.jsonl");
  const metadataPath = path.join(outDir, "metadata.json");
  const metadata = {
    created_at: new Date().toISOString(),
    source: "maze-terminal"
  };

  fs.writeFileSync(replayPath, `${JSON.stringify(row.maze_replay, null, 2)}\n`);
  fs.writeFileSync(resultsPath, `${JSON.stringify(row)}\n`);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  return { metadataPath, replayPath, resultsPath };
}

function shouldWriteReplayArtifacts(options, interactive) {
  if (options.json || options.recordReplay === false) {
    return false;
  }

  return options.recordReplay === true || interactive;
}

function replayVideoOverrides(options = {}) {
  const overrides = {};

  if (Number.isFinite(options.replayFps) && options.replayFps > 0) {
    overrides.fps = options.replayFps;
  }

  if (Number.isFinite(options.replayWidth) && options.replayWidth > 0) {
    overrides.width = options.replayWidth;
  }

  if (Number.isFinite(options.replayHeight) && options.replayHeight > 0) {
    overrides.height = options.replayHeight;
  }

  if (options.replayDraft) {
    overrides.draft = true;
  }

  if (options.replayFast) {
    overrides.fast = true;
  }

  return overrides;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(String(value || "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDimensions(value, fallback) {
  const match = String(value || "").trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);

  if (!match) {
    return fallback;
  }

  return {
    height: parsePositiveInteger(match[2], fallback.height),
    width: parsePositiveInteger(match[1], fallback.width)
  };
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function promptReplayVideoOptions(options = {}) {
  const { defaultReplayOptions } = require("./maze-export-replay");
  const defaults = {
    ...defaultReplayOptions(),
    ...replayVideoOverrides(options)
  };

  process.stdin.resume();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = String(await askQuestion(rl, "\nGenerate replay video now? [y/N] "))
      .trim()
      .toLowerCase();

    if (answer !== "y" && answer !== "yes") {
      return null;
    }

    const fpsAnswer = await askQuestion(rl, `FPS [${defaults.fps}]: `);
    const dimensionsAnswer = await askQuestion(
      rl,
      `Dimensions WxH [${defaults.width}x${defaults.height}]: `
    );
    const fastAnswer = String(await askQuestion(rl, "Fast mode? [y/N] "))
      .trim()
      .toLowerCase();
    const draftAnswer = String(
      await askQuestion(rl, "Draft speed mode (DPR-scaled + effects off)? [y/N] ")
    )
      .trim()
      .toLowerCase();
    const dimensions = parseDimensions(dimensionsAnswer, {
      height: defaults.height,
      width: defaults.width
    });

    return {
      draft: draftAnswer === "y" || draftAnswer === "yes",
      fast: fastAnswer === "y" || fastAnswer === "yes",
      fps: parsePositiveInteger(fpsAnswer, defaults.fps),
      height: dimensions.height,
      width: dimensions.width
    };
  } finally {
    rl.close();
    process.stdin.pause();
  }
}

async function renderLocalReplayVideo(actions, row, outDir, videoOptions = {}) {
  const {
    defaultReplayOptions,
    humanSize,
    renderReplayVideo,
    validateReplayOptions
  } = require("./maze-export-replay");

  const replayOptions = validateReplayOptions({
    ...defaultReplayOptions(),
    ...videoOptions,
    video: true
  });
  const mazeOptions = {
    gameId: row.maze_replay.game_id,
    gameWonGemCount: row.maze_replay.game_won_gem_count,
    levelId: row.maze_replay.start_level_id,
    view: row.maze_replay.initial.view,
    yaw: row.maze_replay.initial.yaw
  };

  console.log("Rendering maze replay video...");
  const rendered = await renderReplayVideo(actions, mazeOptions, outDir, replayOptions);
  console.log(`Wrote ${rendered.videoPath} (${humanSize(rendered.videoPath)})`);
  return rendered;
}

async function writeLocalReplayArtifacts(context, scorecard, renderOptions = {}) {
  const { writeSidecarFiles } = require("./maze-export-replay");
  const outDir = path.resolve(
    ROOT_DIR,
    context.options.replayOutDir || defaultTerminalReplayDir()
  );
  const actions = replayActionCommands(context);
  const row = buildReplayRow(context, scorecard);
  const sidecars = writeSidecarFiles(outDir, actions, scorecard);
  const replayFiles = writeReplayJsonFiles(outDir, row);

  console.log(`\nReplay artifacts: ${outDir}`);
  console.log(`Wrote ${sidecars.scorecardPath}`);
  console.log(`Wrote ${sidecars.actionsPath}`);
  console.log(`Wrote ${replayFiles.replayPath}`);
  console.log(`Wrote ${replayFiles.resultsPath}`);

  if (renderOptions.renderVideo) {
    await renderLocalReplayVideo(actions, row, outDir, renderOptions.videoOptions || {});
  }

  return {
    ...sidecars,
    ...replayFiles,
    actions,
    outDir,
    row
  };
}

function printScreen(context, clear = false) {
  if (clear && process.stdout.isTTY) {
    process.stdout.write("\x1Bc");
  }
  console.log(renderScreen(context));
}

function interactiveHelpText(context) {
  if (isPlayerDead(context)) {
    return `\n${DEATH_MESSAGE}\nz/u undo. r resets.`;
  }

  return "\nArrows move in screen direction. W/S pitch camera. A/D yaw camera. z/u undo. r resets. q quits with scorecard.";
}

const INTERACTIVE_CAMERA_DIRECTIONS = Object.freeze({
  a: "left",
  d: "right",
  s: "down",
  w: "up"
});

function cameraDirectionForInteractiveKey(keyName) {
  return INTERACTIVE_CAMERA_DIRECTIONS[String(keyName || "").toLowerCase()] || null;
}

function startInteractive(context) {
  printScreen(context, true);
  console.log(interactiveHelpText(context));

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let ending = false;

  async function endRun(reason) {
    if (ending) {
      return;
    }

    ending = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    if (reason === "quit") {
      recordReplayAction(context, "quit", "quit");
    }

    const scorecardText = buildScorecard(context);
    const scorecard = JSON.parse(scorecardText).scorecard;
    console.log(scorecardText);

    if (shouldWriteReplayArtifacts(context.options, true)) {
      try {
        const artifacts = await writeLocalReplayArtifacts(context, scorecard);

        if (context.options.replayVideo !== false) {
          const videoOptions = await promptReplayVideoOptions(context.options);

          if (videoOptions) {
            await renderLocalReplayVideo(
              artifacts.actions,
              artifacts.row,
              artifacts.outDir,
              videoOptions
            );
          }
        }
      } catch (error) {
        console.error(
          `Replay artifact generation failed: ${error instanceof Error ? error.message : error}`
        );
        process.exitCode = 1;
      }
    }

    process.exit(process.exitCode || 0);
  }

  process.stdin.on("keypress", (_text, key = {}) => {
    let shouldRender = true;
    const dead = isPlayerDead(context);
    const cameraDirection = cameraDirectionForInteractiveKey(key.name);
    const blockedDeadKey = dead && (
      key.name === "up" ||
      key.name === "down" ||
      key.name === "left" ||
      key.name === "right" ||
      cameraDirection !== null
    );

    if (blockedDeadKey) {
      console.log(`\n${DEATH_MESSAGE}`);
      shouldRender = false;
    } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
      void endRun("quit");
      return;
    } else if (key.name === "up") {
      applyMove(context, "U");
    } else if (key.name === "down") {
      applyMove(context, "D");
    } else if (key.name === "left") {
      applyMove(context, "L");
    } else if (key.name === "right") {
      applyMove(context, "R");
    } else if (cameraDirection) {
      rotateCamera(context, cameraDirection);
    } else if (key.name === "z" || key.name === "u") {
      undoMove(context);
    } else if (key.name === "r") {
      resetLevel(context);
    } else {
      shouldRender = false;
    }

    if (shouldRender) {
      printScreen(context, true);
      if (isGameWon(context)) {
        void endRun("game_won");
        return;
      }
      console.log(interactiveHelpText(context));
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mazeEngine = loadMazeEngine();
  const context = createTerminalContext(mazeEngine, options);

  applyMoves(context, options.moves);

  if (options.json) {
    const payload = await buildJsonPayload(context);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const interactive = !options.once && process.stdin.isTTY;

  if (!interactive) {
    printScreen(context, false);
    if (shouldWriteReplayArtifacts(options, false)) {
      const scorecard = JSON.parse(buildScorecard(context)).scorecard;
      await writeLocalReplayArtifacts(context, scorecard, {
        renderVideo: options.replayVideo === true,
        videoOptions: replayVideoOverrides(options)
      });
    }
    return;
  }

  startInteractive(context);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  applyMove,
  buildJsonObservation,
  buildJsonPayload,
  buildScorecard,
  cameraDirectionForInteractiveKey,
  createTerminalContext,
  GAME_WON_GEM_COUNT,
  isPlayerDead,
  isGameWon,
  loadMazeEngine,
  loadMazeSolver,
  normalizeGameWonGemCount,
  replayActionCommands,
  renderAsciiDetailed,
  renderScreen,
  rotateCamera,
  resetLevel,
  solveContext,
  writeLocalReplayArtifacts,
  undoMove,
  screenMoveVector
};
