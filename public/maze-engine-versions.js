/* Versioned physics only. Both versions use the canonical MazeBench renderer. */
(function () {
  const legacy = window.MazeEngine;
  const supportedActorTypes = Object.freeze([
    "player", "circle_player", "clone", "gem", "box", "weightless_box",
    "floating_floor", "puncher", "orange_button", "attached_lift", "attached_gate"
  ]);
  const supportedTerrainTypes = Object.freeze([
    "empty", "hole", "floor", "exit", "ice", "wall", "ice_block", "ice_slope",
    "tree", "shrub", "block_asset", "player_lift", "player_gate", "orange_button", "orange_wall"
  ]);
  const directions = ["up", "right", "down", "left"];
  const surfaceTypes = new Set(["floor", "exit", "ice"]);
  const actorRoles = {
    player: "player", circle_player: "player", clone: "clone", gem: "goal",
    box: "pushable", weightless_box: "weightless-pushable", floating_floor: "floating-floor",
    puncher: "puncher", orange_button: "orange-button", attached_lift: "player-lift",
    attached_gate: "player-gate"
  };
  let physics = null;
  let loading = null;
  function version(value) {
    if (value === undefined || value === null || value === "") return "v1";
    if (value !== "v1" && value !== "v1.1") throw new Error(`Unsupported MazeBench engine: ${value}`);
    return value;
  }
  function versionFor(playData) { return version(playData?.engineVersion ?? playData?.engine_version); }
  function install(module) {
    const instance = module instanceof WebAssembly.Instance ? module : new WebAssembly.Instance(module, {});
    const candidate = instance.exports;
    if (candidate.physics_abi_version?.() !== 4 || candidate.voxel_stride?.() !== 5) {
      throw new Error("The v1.1 engine has an incompatible physics ABI.");
    }
    physics = candidate;
    return physics;
  }
  async function load(requestedVersion = "v1", options = {}) {
    if (version(requestedVersion) === "v1") return legacy;
    if (physics) return physics;
    if (!loading) {
      loading = (async () => {
        if (options.module) return install(options.module);
        let bytes = options.bytes;
        if (!bytes) {
          const response = await fetch(options.url || `/physics/v1.1.wasm${window.__MAZEBENCH_PLAY_CONFIG__?.assetVersion ? `?v=${encodeURIComponent(window.__MAZEBENCH_PLAY_CONFIG__.assetVersion)}` : ""}`);
          if (!response.ok) throw new Error(`Could not load the v1.1 engine (${response.status}). Please retry.`);
          bytes = await response.arrayBuffer();
        }
        return install(await WebAssembly.compile(bytes));
      })().catch((error) => { loading = null; throw error; });
    }
    return loading;
  }
  function roleCode(name) {
    let hash = 2166136261;
    for (let index = 0; index < name.length; index++) hash = Math.imul(hash ^ name.charCodeAt(index), 16777619);
    return hash | 0;
  }
  function cloneTerrain(terrain) { return terrain.map((row) => row.map((cell) => ({ ...cell, layers: cell.layers.map((layer) => ({ ...layer })) }))); }
  function layersFor(cell = {}) {
    if (Array.isArray(cell.layers) && cell.layers.length) return cell.layers.map((layer) => ({ ...layer }));
    if (!cell.type || cell.type === "empty" || cell.type === "hole") return [];
    return [{ ...cell, elevation: 0, layers: undefined, underlay: undefined }];
  }
  function validateLevel(data) {
    const width = Number(data?.width), height = Number(data?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > (data.composedScene ? 8192 : 256) || height > (data.composedScene ? 8192 : 256)) {
      throw new Error("v1.1 rooms require positive whole-number dimensions no larger than 256.");
    }
    for (const actor of data.actors || []) {
      if (!supportedActorTypes.includes(actor.type)) throw new Error(`v1.1 does not support the ${actor.type} actor yet.`);
      if (!Number.isInteger(actor.x) || !Number.isInteger(actor.y) || !Number.isInteger(actor.elevation ?? 0)) {
        throw new Error("v1.1 actor coordinates must be whole numbers.");
      }
    }
    for (const row of data.terrain || []) for (const cell of row || []) for (const layer of layersFor(cell)) {
      if (!supportedTerrainTypes.includes(layer.type)) throw new Error(`v1.1 does not support ${layer.type} terrain yet. Choose v1 or remove this block.`);
      if (!Number.isInteger(layer.elevation ?? 0)) throw new Error("v1.1 terrain elevations must be whole numbers.");
      if ((layer.type === "player_lift" || layer.type === "player_gate") && layer.direction && !["up", "top"].includes(layer.direction)) {
        throw new Error("Side-mounted terrain devices are not supported by this editor yet.");
      }
    }
    return true;
  }
  function cloneState(state) {
    return {
      actorX: new Int32Array(state.actorX), actorY: new Int32Array(state.actorY),
      actorElevation: new Int32Array(state.actorElevation), actorRemoved: new Uint8Array(state.actorRemoved),
      actorGenericId: new Int32Array(state.actorGenericId), liftRaised: new Uint8Array(state.liftRaised),
      terrain: new Uint8Array(state.terrain), terrainState: cloneTerrain(state.terrainState),
      engineVersion: "v1.1", hashValid: false
    };
  }
  function createModernEngine(data) {
    if (!physics) throw new Error("The v1.1 engine has not loaded. Reload the game to retry.");
    validateLevel(data);
    const width = data.width, height = data.height, actorSource = data.actors || [];
    const actorTypes = actorSource.map((actor) => actor.type);
    const terrainTypes = legacy.terrainTypes;
    const groups = new Map();
    function groupId(actor, index) {
      const key = `${actor.type}:${actor.groupId ?? index}`;
      if (!groups.has(key)) groups.set(key, groups.size);
      return groups.get(key);
    }
    function initialGeneric(actor, index) {
      if (Number.isInteger(actor.v11GenericId)) return actor.v11GenericId;
      if (actor.type === "weightless_box" || actor.type === "clone") return groupId(actor, index);
      if (actor.type === "puncher") return Math.max(0, directions.indexOf(actor.direction || "right")) * 2;
      if (actor.type === "attached_lift" || actor.type === "attached_gate") return actor.raised ? 1 : 0;
      if (actor.type === "floating_floor" || actor.type === "orange_button") return 0;
      return -1;
    }
    const initialState = {
      actorX: Int32Array.from(actorSource, (a) => a.x), actorY: Int32Array.from(actorSource, (a) => a.y),
      actorElevation: Int32Array.from(actorSource, (a) => a.elevation ?? 0),
      actorRemoved: Uint8Array.from(actorSource, (a) => a.removed || a.collected ? 1 : 0),
      actorGenericId: Int32Array.from(actorSource, initialGeneric),
      liftRaised: new Uint8Array(width * height), terrain: new Uint8Array(width * height),
      terrainState: Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => {
        const cell = data.terrain?.[y]?.[x] || { type: "empty" };
        return { ...cell, layers: layersFor(cell) };
      })), engineVersion: "v1.1", hashValid: false
    };
    function syncTerrainArrays(state) {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const cell = state.terrainState[y][x];
        state.terrain[y * width + x] = terrainTypes[cell.type] ?? 0;
        state.liftRaised[y * width + x] = cell.layers.some((l) => l.type === "player_lift" && l.raised) ? 1 : 0;
      }
    }
    syncTerrainArrays(initialState);
    function encode(state, options) {
      const values = [], entries = [];
      function add(x, y, z, role, generic, entry) {
        if (entry.layerIndex !== undefined && (role === "orange-wall" || role === "orange-button")) {
          const scope = state.terrainState[y][x].v11Scope;
          if (scope !== undefined) generic = (1 << 30) | (scope << 17) | (generic & 131071);
        }
        values.push(x, y, z, roleCode(role), generic); entries.push(entry);
      }
      actorSource.forEach((actor, index) => {
        let role = actorRoles[actor.type];
        if (actor.shape === "slope" && (actor.type === "weightless_box" || actor.type === "clone")) {
          role = `${actor.type === "clone" ? "yellow-clone" : "blue-box"}-slope-${actor.direction || "up"}`;
        }
        let generic = state.actorGenericId[index];
        if (Number.isInteger(actor.v11CommandGeneric)) generic = actor.v11CommandGeneric;
        if (actor.type === "orange_button" && actor.v11Scope !== undefined) generic = (1 << 30) | (actor.v11Scope << 17) | (generic & 131071);
        if (actor.type === "clone" && options.suppressCloneInput === true) generic |= 1 << 30;
        add(state.actorRemoved[index] ? -1 : state.actorX[index], state.actorY[index], state.actorElevation[index] + 1,
          role, generic, { actorIndex: index });
      });
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        state.terrainState[y][x].layers.forEach((layer, layerIndex) => {
          const elevation = layer.elevation || 0;
          const entry = { x, y, layerIndex };
          const type = layer.type;
          if (type === "empty" || type === "hole") return;
          if (surfaceTypes.has(type)) return add(x, y, elevation, type === "ice" ? "ice" : "floor", -1, entry);
          if (type === "ice_slope") return add(x, y, elevation + 1, `ice-slope-${layer.direction || "up"}`, -1, entry);
          if (type === "player_lift" || type === "player_gate") {
            return add(x, y, elevation + 1, type.replaceAll("_", "-"), Number.isInteger(layer.v11GenericId) ? layer.v11GenericId : (layer.raised ? 1 : 0), entry);
          }
          if (type === "orange_wall") {
            const anchor = layer.v11AnchorElevation ?? elevation;
            const depth = layer.v11GenericId ?? 0;
            if (anchor === 0 && !state.terrainState[y][x].layers.some((candidate) => surfaceTypes.has(candidate.type) && (candidate.elevation || 0) === 0)) {
              add(x, y, 0, "floor", -1, { x, y, layerIndex, implicitSupport: true });
            }
            return add(x, y, anchor + 1, "orange-wall", depth, entry);
          }
          if (type === "orange_button") return add(x, y, elevation + 1, "orange-button", layer.v11GenericId ?? 0, entry);
          for (let z = 0; z < (type === "tree" ? 3 : 1); z++) add(x, y, elevation + z + 1, type === "ice_block" ? "ice" : "wall", -1, entry);
        });
      }
      if (entries.length > physics.voxel_capacity()) throw new Error(`v1.1 supports at most ${physics.voxel_capacity()} voxels per room.`);
      return { values, entries };
    }
    function project(view, entries, state) {
      let columns = null;
      entries.forEach((entry, index) => {
        const offset = index * 5, x = view[offset], y = view[offset + 1], z = view[offset + 2];
        const rawGeneric = view[offset + 4];
        const generic = (view[offset + 3] === roleCode("orange-wall") || view[offset + 3] === roleCode("orange-button")) && (rawGeneric & (1 << 30)) ? rawGeneric & 131071 : rawGeneric;
        if (entry.actorIndex !== undefined) {
          const i = entry.actorIndex, type = actorTypes[i];
          state.actorGenericId[i] = type === "clone" ? generic & ~(1 << 30) : generic;
          if (x < 0 || (type === "floating_floor" && generic === 1)) {
            state.actorRemoved[i] = 1;
            if (type === "floating_floor" && generic === 1 && x >= 0) {
              const cell = state.terrainState[y][x];
              if (!cell.layers.some((l) => l.type === "floor" && (l.elevation || 0) === z)) {
                cell.layers.push({ type: "floor", elevation: z, raised: false });
                if (cell.type === "empty" || cell.type === "hole") cell.type = "floor";
              }
            }
          } else {
            state.actorX[i] = x; state.actorY[i] = y; state.actorElevation[i] = z - 1; state.actorRemoved[i] = 0;
          }
        } else {
          if (entry.implicitSupport) return;
          const cell = state.terrainState[entry.y][entry.x], layer = cell.layers[entry.layerIndex];
          if (layer.type === "orange_wall") {
            const wallRole = roleCode("orange-wall");
            let lowestAnchor = z, support = -2147483648;
            // Index once per native tick; rescanning the complete connected
            // world for every orange wall is quadratic in authored scene size.
            if (!columns) {
              columns = new Map();
              for (let other = 0; other < entries.length; other++) {
                const p = other * 5, key = `${view[p]},${view[p + 1]}`;
                if (!columns.has(key)) columns.set(key, []);
                columns.get(key).push({ z: view[p + 2], role: view[p + 3] });
              }
            }
            const column = columns.get(`${x},${y}`) || [];
            for (const voxel of column) if (voxel.role === wallRole) lowestAnchor = Math.min(lowestAnchor, voxel.z);
            const excluded = new Set(["orange-wall", "player", "pushable", "weightless-pushable", "player-lift", "orange-button", "goal", "puncher", ...directions.map((d) => `blue-box-slope-${d}`)].map(roleCode));
            for (const voxel of column) if (voxel.z < lowestAnchor && !excluded.has(voxel.role)) support = Math.max(support, voxel.z);
            layer.v11AnchorElevation = z - 1;
            layer.v11GenericId = Math.max(0, generic);
            layer.v11SupportZ = support;
            layer.elevation = z - Math.max(0, generic) - 1;
            layer.raised = z - Math.max(0, generic) > support;
            layer.v11Hidden = z - Math.max(0, generic) < support;
            if (!layer.raised) layer.elevation = support;
            if (cell.type === layer.type) { cell.raised = layer.raised; cell.v11GenericId = generic; }
          }
          if (["player_lift", "player_gate", "orange_button"].includes(layer.type)) {
            layer.v11GenericId = generic;
            layer.raised = (generic & 1) === 1;
            if (cell.type === layer.type) { cell.raised = layer.raised; cell.v11GenericId = generic; }
          }
        }
      });
      syncTerrainArrays(state);
    }
    // Populate mechanism metadata without advancing physics. This keeps a blocked
    // first input from being counted as a move just because the adapter normalized it.
    const authoredScene = encode(initialState, {});
    project(Int32Array.from(authoredScene.values), authoredScene.entries, initialState);

    function recordsBetween(before, after, frames = []) {
      const moves = [];
      actorSource.forEach((actor, actorIndex) => {
        const i = actorIndex;
        const changed = before.actorX[i] !== after.actorX[i] || before.actorY[i] !== after.actorY[i] ||
          before.actorElevation[i] !== after.actorElevation[i] || before.actorRemoved[i] !== after.actorRemoved[i] ||
          before.actorGenericId[i] !== after.actorGenericId[i];
        if (!changed) return;
        const move = { actorIndex, actorType: actor.type,
          fromX: before.actorX[i], fromY: before.actorY[i], fromElevation: before.actorElevation[i], fromRemoved: !!before.actorRemoved[i],
          toX: after.actorX[i], toY: after.actorY[i], toElevation: after.actorElevation[i], toRemoved: !!after.actorRemoved[i],
          toGenericId: after.actorGenericId[i], engineVersion: "v1.1",
          skipHoleFall: actor.type === "gem" || actor.type === "floating_floor" && after.actorGenericId[i] === 1,
          fadeOut: actor.type === "gem" };
        const path = [before, ...frames].map((state) => ({ x: state.actorX[i], y: state.actorY[i], elevation: state.actorElevation[i] }))
          .filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y || point.elevation !== all[index - 1].elevation);
        if (path.length > 1) {
          move.path = path; move.pathControlsElevation = true; move.pathEndElevation = path.at(-1).elevation;
          move.nativeContinuousMotion = path.length > 2;
        }
        moves.push(move);
      });
      return moves;
    }
    function move(state, dx, dy, options = {}) {
      const direction = dx === 1 && dy === 0 ? 1 : dx === -1 && dy === 0 ? 3 : dy === 1 && dx === 0 ? 2 : dy === -1 && dx === 0 ? 0 : -1;
      if (direction < 0) throw new Error("v1.1 requires a single cardinal direction.");
      if (!actorSource.some((actor, i) => (actor.type === "player" || actor.type === "circle_player") && !state.actorRemoved[i])) {
        return { engineVersion: "v1.1", moved: false, moves: [], ticks: [], raisedOrangeWalls: [], liftToggles: [] };
      }
      const before = cloneState(state), { values, entries } = encode(state, options);
      const view = new Int32Array(physics.memory.buffer, physics.voxel_buffer(), values.length);
      view.set(values); physics.reset_command();
      const frames = [], ticks = [];
      const includeTrace = data.physicsTrace !== false;
      let previous = before, lastTick = 0, complete = false;
      for (let iteration = 0; iteration < 4096; iteration++) {
        const status = physics.step_command_tick(entries.length, width, height, direction);
        if (status < 0) throw new Error(`v1.1 rejected this command (${status}).`);
        const current = cloneState(previous);
        project(view, entries, current);
        const tick = physics.command_tick();
        if (tick !== lastTick || status === 0 && physics.command_cycle_detected()) {
          frames.push({ actorX: current.actorX, actorY: current.actorY, actorElevation: current.actorElevation, actorRemoved: current.actorRemoved });
          const changedTerrain = JSON.stringify(previous.terrainState) !== JSON.stringify(current.terrainState);
          if (data.composedScene && !changedTerrain) current.terrainState = previous.terrainState;
          if (includeTrace) ticks.push({
            moves: recordsBetween(previous, current, [current]),
            terrain: !changedTerrain || data.composedScene ? null : cloneTerrain(current.terrainState),
            actorGenericId: Array.from(current.actorGenericId),
            state: data.composedScene ? current : undefined
          });
          previous = current; lastTick = tick;
        }
        if (status === 0) { complete = true; break; }
      }
      if (!complete) throw new Error("This v1.1 command exceeded the 4,096-tick playback limit.");
      const final = previous;
      // Cycle rollback is a no-op, including rewards and mechanism changes.
      const moves = recordsBetween(before, final, frames);
      const terrainChanged = JSON.stringify(before.terrainState) !== JSON.stringify(final.terrainState);
      copyStateInto(state, final);
      return { engineVersion: "v1.1", moved: moves.length > 0 || terrainChanged, moves, ticks,
        terrainAfter: cloneTerrain(final.terrainState), actorGenericId: Array.from(final.actorGenericId),
        raisedOrangeWalls: raisedOrangeWallKeys(final), liftToggles: [], cycle: physics.command_cycle_detected() === 1,
        direction: ["U", "R", "D", "L"][direction], previousState: before,
        frames: data.composedScene ? frames : undefined };
    }
    function copyStateInto(target, source) {
      for (const key of ["actorX", "actorY", "actorElevation", "actorRemoved", "actorGenericId", "liftRaised", "terrain"]) target[key].set(source[key]);
      target.terrainState = cloneTerrain(source.terrainState); target.hashValid = false;
    }
    function raisedOrangeWallKeys(state) {
      return state.terrainState.flatMap((row, y) => row.flatMap((cell, x) => cell.layers.some((layer) => layer.type === "orange_wall" && (layer.v11GenericId === undefined || layer.raised)) ? [`${x},${y}`] : []));
    }
    function stateKey(state) { return JSON.stringify([Array.from(state.actorX), Array.from(state.actorY), Array.from(state.actorElevation), Array.from(state.actorRemoved), Array.from(state.actorGenericId), state.terrainState]); }
    return { engineVersion: "v1.1", width, height, actorCount: actorSource.length, actorTypes,
      actorGroupIds: actorSource.map((a) => a.groupId), cellCount: width * height, terrainTypes, initialState,
      cloneState, copyStateInto, createStateBuffer: () => cloneState(initialState), move,
      moveForSearch: (state, dx, dy) => { const result = move(state, dx, dy); return { ...result, nonPlayerMoveCount: result.moves.filter((m) => !["player", "circle_player", "gem"].includes(m.actorType)).length }; },
      stateKey, cellIndex: (x, y) => y * width + x, loadWarnings: [],
      heuristic: () => 0, heuristicDistance: () => 0,
      undoMove: (state, result) => { if (result?.previousState) copyStateInto(state, result.previousState); },
      isSolved: (state) => actorTypes.every((type, index) => type !== "gem" || !!state.actorRemoved[index]),
      isPlayerMove: (record) => ["player", "circle_player", "clone"].includes(record?.actorType),
      raisedOrangeWallKeys, areOrangeButtonsPressed: () => false,
      computeRaisedPlayerGateSet: (state) => new Set(state.terrainState.flatMap((row, y) => row.flatMap((cell, x) => cell.layers.some((l) => l.type === "player_gate" && l.raised) ? [`${x},${y}`] : []))) };
  }
  function validateWorld(rooms) {
    const list = Array.isArray(rooms) ? rooms : Object.values(rooms || {});
    const dimensions = new Set();
    for (const room of list) {
      validateLevel(room); dimensions.add(`${room.width},${room.height}`);
      if ((room.actors || []).filter((actor) => (actor.type === "player" || actor.type === "circle_player") && !actor.removed).length > 1) {
        throw new Error("v1.1 world traversal supports one main player per room. Use clones for additional characters.");
      }
      let voxelCount = (room.actors || []).length;
      for (const row of room.terrain || []) for (const cell of row || []) for (const layer of layersFor(cell)) voxelCount += layer.type === "tree" ? 3 : layer.type === "orange_wall" ? 2 : 1;
      if (voxelCount > 65536) throw new Error("This v1.1 room exceeds the 65,536 voxel physics limit.");
    }
    if (dimensions.size > 1) throw new Error("Connected v1.1 rooms must have matching dimensions for continuous physics.");
    return true;
  }
  // Discover only the rooms a command can interact with. Each expansion reruns
  // from the same original state: native momentum is never restarted midway.
  // Nonplayer bodies cannot cross the native room grid, so the full main-player
  // path (including ice, gravity, and punches) determines frontier expansion.
  async function planWorldCommand(options) {
    const sources = { ...(options.rooms || {}), [options.currentLevelId]: options.currentRoom };
    const included = new Set([options.currentLevelId]), missing = new Set();
    for (let iteration = 0; iteration < 1024; iteration++) {
      const sceneOptions = { ...options, rooms: sources, physicsTrace: false,
        adjacentLevelId: (id, dx, dy) => {
          const next = options.adjacentLevelId?.(id, dx, dy);
          return included.has(next) ? next : null;
        },
        loadRoom: async (id) => sources[id] || null
      };
      const result = await simulateWorldCommand(sceneOptions);
      const frontier = new Set();
      for (const point of result.playerPath) {
        const room = sources[point.levelId];
        for (const [dx, dy, touches] of [[-1, 0, point.x === 0], [1, 0, point.x === room.width - 1], [0, -1, point.y === 0], [0, 1, point.y === room.height - 1]]) {
          if (!touches) continue;
          const id = options.adjacentLevelId?.(point.levelId, dx, dy);
          if (id && !included.has(id) && !missing.has(id)) frontier.add(id);
        }
      }
      let expanded = false;
      for (const id of frontier) {
        const room = sources[id] || await options.loadRoom?.(id);
        if (!room) { missing.add(id); continue; }
        sources[id] = room; included.add(id); expanded = true;
      }
      if (!expanded) {
        if (options.physicsTrace === false) return result;
        return simulateWorldCommand({ ...sceneOptions, physicsTrace: true });
      }
    }
    throw new Error("This v1.1 command traverses too many rooms to simulate safely.");
  }
  // Compose one native command before any mutation. Momentum is native state, so
  // restarting a command after a room boundary would change ice and punch physics.
  async function simulateWorldCommand(options) {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const currentId = options.currentLevelId;
    const savedRooms = clone(options.rooms || {});
    savedRooms[currentId] = clone(options.currentRoom);
    const placements = new Map([[currentId, { id: currentId, gx: 0, gy: 0, room: savedRooms[currentId] }]]);
    const queue = [placements.get(currentId)], missing = new Set();
    const roomWidth = Number(options.currentRoom.width), roomHeight = Number(options.currentRoom.height);
    // The ABI's uniform grid restricts movable objects to their room while the
    // player may cross. These tags are removed when projecting durable snapshots.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const id = options.adjacentLevelId?.(item.id, dx, dy);
        if (!id || placements.has(id) || missing.has(id)) continue;
        const source = savedRooms[id] || await options.loadRoom?.(id);
        if (!source) { missing.add(id); continue; }
        if (Number(source.width) !== roomWidth || Number(source.height) !== roomHeight) {
          throw new Error("Connected v1.1 rooms must have matching dimensions for continuous physics.");
        }
        if (queue.length >= 1024) throw new Error("This connected v1.1 world exceeds the supported scene size.");
        const next = { id, gx: item.gx + dx, gy: item.gy + dy, room: clone(source) };
        placements.set(id, next); queue.push(next);
      }
    }
    const minX = Math.min(...queue.map((r) => r.gx)), minY = Math.min(...queue.map((r) => r.gy));
    const width = (Math.max(...queue.map((r) => r.gx)) - minX + 1) * roomWidth;
    const height = (Math.max(...queue.map((r) => r.gy)) - minY + 1) * roomHeight;
    // Count before allocating the rectangular layout or entering the WASM engine.
    let count = 0;
    for (const { room } of queue) {
      validateLevel(room);
      count += (room.actors || []).length;
      for (const row of room.terrain || []) for (const cell of row) for (const layer of layersFor(cell)) count += layer.type === "tree" ? 3 : layer.type === "orange_wall" ? 2 : 1;
    }
    if (count > physics.voxel_capacity() || width * height > 1048576) {
      throw new Error(`This connected v1.1 world exceeds the ${physics.voxel_capacity().toLocaleString()} voxel physics limit. Split it into disconnected worlds or reduce its size.`);
    }
    const terrain = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ type: "hole", layers: [] })));
    const actors = [], ownership = [], groups = new Map();
    let mainIndex = -1;
    const isMain = (a) => a?.type === "player" || a?.type === "circle_player";
    queue.forEach((placement, scope) => {
      const { room, id } = placement;
      placement.x = (placement.gx - minX) * roomWidth;
      placement.y = (placement.gy - minY) * roomHeight;
      for (let y = 0; y < roomHeight; y++) for (let x = 0; x < roomWidth; x++) {
        terrain[y + placement.y][x + placement.x] = { ...(room.terrain[y]?.[x] || { type: "hole" }), v11Scope: scope };
      }
      (room.actors || []).forEach((actor, actorIndex) => {
        if (isMain(actor) && (id !== currentId || actor.removed)) return;
        const transformed = { ...actor, x: actor.x + placement.x, y: actor.y + placement.y };
        if (isMain(actor)) {
          if (mainIndex >= 0) throw new Error("v1.1 world traversal requires one main player per room.");
          mainIndex = actors.length;
          transformed.v11CommandGeneric = (1 << 30) | (roomHeight << 15) | roomWidth;
        }
        if (actor.type === "clone" || actor.type === "weightless_box") {
          const key = `${id}:${actor.type}:${actor.v11GenericId ?? actor.groupId ?? actorIndex}`;
          if (!groups.has(key)) groups.set(key, groups.size);
          transformed.v11CommandGeneric = groups.get(key) | (actor.type === "clone" && id !== currentId ? 1 << 30 : 0);
        }
        if (actor.type === "orange_button") transformed.v11Scope = scope;
        ownership.push({ id, actorIndex, actor: clone(actor), placement });
        actors.push(transformed);
      });
    });
    if (mainIndex < 0) throw new Error("This v1.1 room has no main player.");
    const engine = createModernEngine({ width, height, terrain, actors, composedScene: true, physicsTrace: options.physicsTrace !== false });
    const state = engine.cloneState(engine.initialState);
    const beforeState = engine.cloneState(state);
    const result = engine.move(state, options.dx, options.dy);
    const atPoint = (x, y) => queue.find((r) => x >= r.x && x < r.x + roomWidth && y >= r.y && y < r.y + roomHeight);
    function playerPoint(frame) {
      const x = frame.actorX[mainIndex], y = frame.actorY[mainIndex];
      const room = atPoint(x, y) || placements.get(currentId);
      return { levelId: room.id, x: x - room.x, y: y - room.y, elevation: frame.actorElevation[mainIndex], worldX: x, worldY: y, removed: !!frame.actorRemoved[mainIndex] };
    }
    let previousProjection = null;
    let previousTerrain = null;
    function projectRooms(frame) {
      const rooms = { ...savedRooms };
      for (const placement of queue) {
        const { id, room, x, y } = placement;
        rooms[id] = { ...room, actors: room.actors.map((actor) => ({ ...actor })), engineVersion: "v1.1", terrain: previousTerrain === frame.terrainState ? previousProjection[id].terrain : frame.terrainState.slice(y, y + roomHeight).map((row) => row.slice(x, x + roomWidth).map((cell, localX) => { const copy = clone(cell); delete copy.v11Scope; return copy; })) };
        delete rooms[id].v11WorldRooms;
        rooms[id].raisedOrangeWalls = rooms[id].terrain.flatMap((row, yy) => row.flatMap((cell, xx) => cell.layers?.some((l) => l.type === "orange_wall" && l.raised) ? [`${xx},${yy}`] : []));
      }
      ownership.forEach(({ id, actorIndex, actor, placement }, index) => {
        if (index === mainIndex) return;
        const next = rooms[id].actors[actorIndex];
        Object.assign(next, { x: frame.actorX[index] - placement.x, y: frame.actorY[index] - placement.y, elevation: frame.actorElevation[index], removed: !!frame.actorRemoved[index] });
        next.v11GenericId = ["clone", "weightless_box"].includes(actor.type) ? actor.v11GenericId : frame.actorGenericId[index];
        if (["attached_lift", "attached_gate"].includes(actor.type)) next.raised = (next.v11GenericId & 1) === 1;
      });
      const point = playerPoint(frame), targetRoom = rooms[point.levelId];
      let targetIndex = targetRoom.actors.findIndex(isMain);
      if (targetIndex < 0) { targetIndex = targetRoom.actors.length; targetRoom.actors.push(clone(ownership[mainIndex].actor)); }
      Object.assign(targetRoom.actors[targetIndex], { x: point.x, y: point.y, elevation: point.elevation, removed: point.removed, v11GenericId: -1 });
      previousProjection = rooms; previousTerrain = frame.terrainState;
      return { rooms, currentLevelId: point.levelId, currentRoom: targetRoom, point };
    }
    const initial = projectRooms(beforeState);
    const ticks = options.physicsTrace === false ? [] : result.ticks.map((tick) => projectRooms(tick.state));
    const projected = ticks.at(-1) || projectRooms(state);
    const playerPath = [beforeState, ...(result.frames || [])].map(playerPoint);
    const visitedLevelIds = [...new Set(playerPath.map((p) => p.levelId))];
    const collectedGems = ownership.flatMap((owned, index) => owned.actor.type === "gem" && !beforeState.actorRemoved[index] && state.actorRemoved[index] ? [{ levelId: owned.id, actorIndex: owned.actorIndex, actor: owned.actor }] : []);
    const moves = result.moves.map((move) => {
      const own = ownership[move.actorIndex];
      return { ...move, actor: own.actor, levelId: own.id, actorIndex: own.actorIndex, fromX: move.fromX - own.placement.x, fromY: move.fromY - own.placement.y, toX: move.toX - own.placement.x, toY: move.toY - own.placement.y,
        path: move.path?.map((p) => ({ ...p, x: p.x - own.placement.x, y: p.y - own.placement.y })) };
    });
    return { ...projected, moved: result.moved, moves, playerPath, visitedLevelIds, collectedGems,
      playerFell: !!state.actorRemoved[mainIndex], cycle: result.cycle,
      initial: options.physicsTrace === false ? undefined : initial, initialRooms: initial.rooms,
      placements: queue.map(({ id, x, y }) => ({ levelId: id, offset: { x, y } })),
      ticks };
  }
  window.MazeEngineVersions = Object.freeze({
    load, install, versionFor, validateLevel, validateWorld, planWorldCommand, supportedActorTypes, supportedTerrainTypes,
    isReady: (requestedVersion) => version(requestedVersion) === "v1" || !!physics,
    createEngine: (data, requestedVersion = versionFor(data)) => version(requestedVersion) === "v1.1" ? createModernEngine(data) : legacy.createEngine(data)
  });
})();
