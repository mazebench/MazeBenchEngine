import {
  engineRoleIdForObject,
  engineStatesEqualV1,
  readEngineStateV1
} from "../../engine/current/adapter.mjs";
import { ConnectedWorldSessionV1 } from "../../play/current/connected-world-session.mjs";

export const RANDOM_AGENT_START_POSITION_V1 = Object.freeze(["H", "I"]);
export const RANDOM_AGENT_DIRECTIONS_V1 = Object.freeze(["up", "right", "down", "left"]);
export const RANDOM_AGENT_TRAIL_LENGTH_V1 = 50;

const waitForNextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    objects: state.objects.map((object) => ({ ...object }))
  };
}

function definitionsMap(definitions) {
  return definitions instanceof Map
    ? definitions
    : new Map((definitions || []).map((definition) => [definition.id, definition]));
}

export function tagRandomAgentWorldV1(world) {
  return {
    ...world,
    rooms: world.rooms.map((room) => ({
      ...room,
      objects: room.objects.map((object, index) => ({
        ...object,
        randomAgentObjectId: `${room.fileName}:${index}`
      }))
    }))
  };
}

function objectsForRole(state, definitions, roleId) {
  const blocks = definitionsMap(definitions);
  return state.objects.filter((object) =>
    engineRoleIdForObject(object, blocks) === roleId);
}

function objectIsActive(object, state) {
  return object.x >= 0 && object.y >= 0 && object.x < state.width &&
    object.y < state.height && object.z !== -2_147_483_648;
}

export function activeRandomAgentPlayerV1(state, definitions) {
  return objectsForRole(state, definitions, "player")
    .find((object) => objectIsActive(object, state)) || null;
}

function collectedGemIdsIn(state, definitions) {
  return objectsForRole(state, definitions, "goal")
    .filter((object) => !objectIsActive(object, state))
    .map((object) => object.randomAgentObjectId);
}

export function randomAgentPixelV1(world, room, player) {
  if (!room || !player) return null;
  const width = world.columns.length * world.roomWidth;
  const height = world.rows.length * world.roomHeight;
  const x = room.columnIndex * world.roomWidth + player.x;
  const y = room.rowIndex * world.roomHeight + player.y;
  if (![x, y].every(Number.isInteger) || x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x, y, index: y * width + x };
}

function prepareStateOrder(state, definitions) {
  const dynamic = [];
  const fixed = [];
  for (const object of state.objects) {
    const roleId = engineRoleIdForObject(object, definitions);
    const target = roleId === "floor" || roleId === "ice" || roleId === "solid" ||
      roleId === "goal" || roleId.startsWith("ice-slope-") ? fixed : dynamic;
    target.push({ ...object });
  }
  return {
    state: { width: state.width, height: state.height, objects: [...dynamic, ...fixed] },
    dynamicVoxelCount: dynamic.length
  };
}

function elapsedNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function runRandomAgentV1(engine, sourceWorld, options = {}) {
  const world = tagRandomAgentWorldV1(sourceWorld);
  const definitions = world.blockDefinitions || world.blocks;
  const blocks = definitionsMap(definitions);
  const nativeGemIds = [];
  const nativeGemIndexes = new Map();
  for (const worldRoom of world.rooms) {
    for (const object of worldRoom.objects) {
      if (engineRoleIdForObject(object, blocks) !== "goal") continue;
      const index = nativeGemIds.length;
      object.genericId = index;
      nativeGemIds.push(object.randomAgentObjectId);
      nativeGemIndexes.set(object.randomAgentObjectId, index);
    }
  }
  const startPosition = options.startPosition || RANDOM_AGENT_START_POSITION_V1;
  const startRoom = world.rooms.find((candidate) =>
    candidate.position?.[0] === startPosition[0] && candidate.position?.[1] === startPosition[1]);
  if (!startRoom) throw new Error(`Random-agent starter room ${startPosition.join("×")} is missing.`);
  if (typeof engine.exports.random_agent_run !== "function") {
    throw new Error("The imported engine does not include the native random-agent batch API.");
  }

  const connected = new ConnectedWorldSessionV1(engine, definitions, world.rooms);
  const maximumActions = Number.isFinite(options.maximumActions)
    ? Math.max(0, Math.floor(options.maximumActions))
    : Number.POSITIVE_INFINITY;
  const batchSize = Math.max(1, Math.floor(Number(options.batchSize) || 262_144));
  const reportEveryMs = Math.max(16, Number(options.reportEveryMs) || 100);
  const collectedGems = new Set();
  const reachedRooms = new Set();
  let pendingVisited = new Set();
  let pendingTrail = [];
  let trailReplaces = false;
  let pendingRooms = [];
  let seed = (Number(options.seed) >>> 0) || 0x9e3779b9;
  let room = startRoom;
  let state = engine.createState(startRoom);
  let template;
  let dynamicVoxelCount;
  let playerIndex;
  let goalEntries;
  let buffer;
  let stride;
  let actions = 0;
  let undos = 0;
  let nativeBatches = 0;
  let edgeHandoffs = 0;
  let edgeCacheHits = 0;
  const edgeKinds = [0, 0, 0];
  const edgeCache = new Map();
  const nativeRooms = new Array(world.columns.length * world.rows.length);
  let nativeWorldReady = false;
  const startedAt = elapsedNow();
  let lastReportAt = startedAt;

  const reachRoom = (observedRoom) => {
    if (reachedRooms.has(observedRoom.fileName)) return;
    reachedRooms.add(observedRoom.fileName);
    pendingRooms.push({
      fileName: observedRoom.fileName,
      position: observedRoom.position,
      columnIndex: observedRoom.columnIndex,
      rowIndex: observedRoom.rowIndex
    });
  };

  const observe = (observedRoom, observedState, settled = true) => {
    if (settled) reachRoom(observedRoom);
    const pixel = randomAgentPixelV1(
      world,
      observedRoom,
      activeRandomAgentPlayerV1(observedState, definitions)
    );
    if (!pixel) return;
    pendingVisited.add(pixel.index);
    pendingTrail.push(pixel.index);
  };

  const observeCell = (observedRoom, x, y) => {
    reachRoom(observedRoom);
    const pixel = randomAgentPixelV1(world, observedRoom, { x, y });
    if (!pixel) return;
    pendingVisited.add(pixel.index);
    pendingTrail.push(pixel.index);
  };

  const edgeCacheKey = (direction) => {
    const values = [room.fileName, direction];
    for (let index = 0; index < dynamicVoxelCount; index += 1) {
      const offset = index * stride;
      for (let field = 0; field < stride; field += 1) values.push(buffer[offset + field]);
    }
    for (const goal of goalEntries) {
      const offset = goal.index * stride;
      for (let field = 0; field < stride; field += 1) values.push(buffer[offset + field]);
    }
    return values.join(",");
  };

  const syncNative = (nextState) => {
    const prepared = prepareStateOrder(nextState, definitions);
    state = cloneState(prepared.state);
    template = prepared.state;
    dynamicVoxelCount = prepared.dynamicVoxelCount;
    playerIndex = template.objects.findIndex((object) =>
      engineRoleIdForObject(object, definitions) === "player");
    goalEntries = template.objects.map((object, index) => ({ object, index }))
      .filter(({ object }) => engineRoleIdForObject(object, definitions) === "goal")
      .map(({ object, index }) => ({ id: object.randomAgentObjectId, index }));
    const resident = engine.writeState(template, definitions);
    buffer = resident.buffer;
    stride = resident.stride;
    const roomIndex = room.rowIndex * world.columns.length + room.columnIndex;
    const started = nativeWorldReady
      ? engine.exports.random_world_resume(
          roomIndex,
          resident.count,
          template.width,
          template.height,
          dynamicVoxelCount,
          seed
        )
      : engine.exports.random_agent_begin(
          resident.count,
          template.width,
          template.height,
          dynamicVoxelCount,
          seed
        );
    if (started !== 1) {
      throw new Error("The native random agent could not compile this room.");
    }
  };

  const selectNativeRoom = (roomIndex) => {
    const cached = nativeRooms[roomIndex];
    if (!cached) throw new Error(`Native random agent entered unknown room ${roomIndex}.`);
    room = cached.room;
    template = cached.template;
    dynamicVoxelCount = cached.dynamicVoxelCount;
    playerIndex = cached.playerIndex;
    goalEntries = cached.goalEntries;
    stride = cached.stride;
    buffer = new Int32Array(
      engine.exports.memory.buffer,
      engine.exports.voxel_buffer(),
      cached.voxelCount * stride
    );
    state = template;
  };

  const uploadNativeWorld = () => {
    if (engine.exports.random_world_reset(world.columns.length, world.rows.length) !== 1) {
      throw new Error("The random-agent accelerator rejected the world dimensions.");
    }
    const fallbackPlayer = startRoom.objects.find((object) =>
      engineRoleIdForObject(object, definitions) === "player");
    for (const authoredRoom of world.rooms) {
      const source = engine.createState(authoredRoom);
      if (!source.objects.some((object) =>
        engineRoleIdForObject(object, definitions) === "player")) {
        source.objects.push({ ...fallbackPlayer, x: 0, y: 0 });
      }
      const prepared = prepareStateOrder(source, definitions);
      const resident = engine.writeState(prepared.state, definitions);
      const cachedPlayerIndex = prepared.state.objects.findIndex((object) =>
        engineRoleIdForObject(object, definitions) === "player");
      const roomIndex = authoredRoom.rowIndex * world.columns.length + authoredRoom.columnIndex;
      if (engine.exports.random_world_add_room(
        roomIndex,
        resident.count,
        prepared.state.width,
        prepared.state.height,
        prepared.dynamicVoxelCount,
        cachedPlayerIndex
      ) !== 1) {
        throw new Error(`The random-agent accelerator could not import ${authoredRoom.fileName}.`);
      }
      nativeRooms[roomIndex] = {
        room: authoredRoom,
        template: prepared.state,
        dynamicVoxelCount: prepared.dynamicVoxelCount,
        playerIndex: cachedPlayerIndex,
        goalEntries: prepared.state.objects.map((object, index) => ({ object, index }))
          .filter(({ object }) => engineRoleIdForObject(object, definitions) === "goal")
          .map(({ object, index }) => ({ id: object.randomAgentObjectId, index })),
        stride: resident.stride,
        voxelCount: resident.count
      };
    }
    const startRoomIndex = startRoom.rowIndex * world.columns.length + startRoom.columnIndex;
    if (engine.exports.random_world_start(startRoomIndex, seed) !== 1) {
      throw new Error("The random-agent accelerator could not start at H×I.");
    }
    nativeWorldReady = true;
    selectNativeRoom(startRoomIndex);
  };

  const collectNativeMap = (nativeActions) => {
    const worldCellCount = world.columns.length * world.roomWidth *
      world.rows.length * world.roomHeight;
    for (let wordIndex = 0; wordIndex < Math.ceil(worldCellCount / 32); wordIndex += 1) {
      const word = engine.exports.random_agent_visited_word(wordIndex) >>> 0;
      for (let bit = 0; bit < 32; bit += 1) {
        if ((word & (1 << bit)) === 0) continue;
        const cell = wordIndex * 32 + bit;
        if (cell < worldCellCount) pendingVisited.add(cell);
      }
    }
    const count = engine.exports.random_agent_trail_count();
    const nativeTrail = [];
    for (let index = 0; index < count; index += 1) {
      const cell = engine.exports.random_agent_trail_cell(index);
      if (cell < 0) continue;
      nativeTrail.push(cell);
    }
    if (nativeActions >= RANDOM_AGENT_TRAIL_LENGTH_V1 - 1) {
      pendingTrail = nativeTrail;
      trailReplaces = true;
    } else {
      pendingTrail.push(...nativeTrail);
    }
  };

  const collectNativeWorldStats = () => {
    for (let wordIndex = 0; wordIndex < Math.ceil(nativeRooms.length / 32); wordIndex += 1) {
      const word = engine.exports.random_agent_reached_room_word(wordIndex) >>> 0;
      for (let bit = 0; bit < 32; bit += 1) {
        if ((word & (1 << bit)) === 0) continue;
        const cached = nativeRooms[wordIndex * 32 + bit];
        if (cached) reachRoom(cached.room);
      }
    }
    for (let wordIndex = 0; wordIndex < Math.ceil(nativeGemIds.length / 32); wordIndex += 1) {
      const word = engine.exports.random_agent_collected_goal_word(wordIndex) >>> 0;
      for (let bit = 0; bit < 32; bit += 1) {
        if ((word & (1 << bit)) === 0) continue;
        const id = nativeGemIds[wordIndex * 32 + bit];
        if (id) collectedGems.add(id);
      }
    }
  };

  const report = (type = "progress") => {
    const elapsedMs = elapsedNow() - startedAt;
    options.onProgress?.({
      type,
      width: world.columns.length * world.roomWidth,
      height: world.rows.length * world.roomHeight,
      roomWidth: world.roomWidth,
      roomHeight: world.roomHeight,
      visitedCells: [...pendingVisited],
      trail: pendingTrail,
      trailReplaces,
      reachedRooms: pendingRooms,
      stats: {
        actions,
        actionsPerSecond: elapsedMs > 0 ? actions * 1000 / elapsedMs : 0,
        rooms: reachedRooms.size,
        gems: collectedGems.size,
        undos,
        nativeBatches,
        edgeHandoffs,
        edgeCacheHits,
        edgeKinds,
        teleports: engine.exports.random_agent_teleports?.() || 0,
        currentRoom: room.position?.join("×") || room.fileName,
        elapsedMs
      }
    });
    pendingVisited = new Set();
    pendingTrail = [];
    trailReplaces = false;
    pendingRooms = [];
  };

  reachRoom(room);
  observe(room, state);
  uploadNativeWorld();
  collectNativeWorldStats();
  report("ready");

  while (actions < maximumActions) {
    if (options.isCancelled?.()) throw new DOMException("Random agent stopped.", "AbortError");
    const remaining = Number.isFinite(maximumActions) ? maximumActions - actions : batchSize;
    const status = engine.exports.random_agent_run(Math.min(batchSize, remaining));
    nativeBatches += 1;
    if (status < 0) throw new Error(`Native random-agent batch failed (${status}).`);
    const nativeActions = engine.exports.random_agent_actions();
    actions += nativeActions;
    undos += engine.exports.random_agent_death_undos();
    seed = engine.exports.random_agent_seed() >>> 0;
    const nativeRoomIndex = engine.exports.random_agent_current_room();
    if (nativeRoomIndex >= 0) selectNativeRoom(nativeRoomIndex);
    collectNativeMap(nativeActions);
    collectNativeWorldStats();

    if (status === 1 && actions < maximumActions) {
      edgeHandoffs += 1;
      const directionIndex = engine.exports.random_agent_exit_direction();
      const direction = RANDOM_AGENT_DIRECTIONS_V1[directionIndex];
      if (!direction) throw new Error("Native random agent returned an invalid edge direction.");
      const previousRoom = room;
      const exitKind = engine.exports.random_agent_exit_kind?.() || 0;
      edgeKinds[exitKind] = (edgeKinds[exitKind] || 0) + 1;
      const previousState = readEngineStateV1(template, definitions, buffer, stride);
      const cacheKey = edgeCacheKey(direction);
      let outcome = edgeCache.get(cacheKey);
      if (outcome) edgeCacheHits += 1;
      if (!outcome) {
        const simulation = await connected.simulateCommand(previousState, room, direction);
        const trace = simulation.animationFrames?.length
          ? simulation.animationFrames
          : [{ room: simulation.room || room, state: simulation.final }];
        const alive = Boolean(activeRandomAgentPlayerV1(simulation.final, definitions));
        const nextRoom = alive ? simulation.room || room : previousRoom;
        const nextState = alive ? simulation.final : previousState;
        const gemIds = alive
          ? [...new Set([
              ...trace.flatMap((frame) => collectedGemIdsIn(frame.state, definitions)),
              ...collectedGemIdsIn(simulation.final, definitions)
            ])]
          : [];
        outcome = {
          alive,
          room: nextRoom,
          state: cloneState(nextState),
          observations: trace.map((frame) => ({
            room: frame.room || room,
            state: cloneState(frame.state)
          })),
          gemIds,
          observedCell: null,
          reusableNativeState: !alive || (
            nextRoom.fileName === previousRoom.fileName &&
            engineStatesEqualV1(previousState, nextState, definitions)
          )
        };
        edgeCache.set(cacheKey, outcome);
      }
      // Trace pixels are telemetry; only the settled outcome is a reached room.
      for (const frame of outcome.observations) observe(frame.room, frame.state, false);
      if (outcome.observedCell) {
        observeCell(outcome.observedCell.room, outcome.observedCell.x, outcome.observedCell.y);
      }
      actions += 1;
      engine.exports.random_agent_note_external_action();
      if (outcome.alive) {
        for (const id of outcome.gemIds) {
          collectedGems.add(id);
          const gemIndex = nativeGemIndexes.get(id);
          if (gemIndex !== undefined) engine.exports.random_agent_mark_goal_collected(gemIndex);
        }
        room = outcome.room;
        if (outcome.state) state = cloneState(outcome.state);
      } else {
        room = previousRoom;
        state = previousState;
        undos += 1;
      }
      if (outcome.state) observe(room, state);
      if (!outcome.reusableNativeState) {
        syncNative(state);
      }
    }

    const now = elapsedNow();
    if (now - lastReportAt >= reportEveryMs || actions >= maximumActions) {
      report();
      lastReportAt = now;
      await waitForNextTask();
    }
  }

  report("complete");
  return {
    actions,
    rooms: reachedRooms.size,
    gems: collectedGems.size,
    undos,
    currentRoom: room.position?.join("×") || room.fileName
  };
}
