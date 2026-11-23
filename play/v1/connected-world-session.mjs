import { engineGenericIdForObject, engineRoleIdForObject } from "../../engine/v1/adapter.mjs";

const DIRECTIONS = Object.freeze({
  up: { column: 0, row: -1 },
  right: { column: 1, row: 0 },
  down: { column: 0, row: 1 },
  left: { column: -1, row: 0 }
});

const ORIENTATION_DIRECTIONS = Object.freeze({
  up: "up",
  north: "up",
  right: "right",
  east: "right",
  down: "down",
  south: "down",
  left: "left",
  west: "left"
});

function cellKey(columnIndex, rowIndex) {
  return `${columnIndex},${rowIndex}`;
}

function roomKey(room) {
  return cellKey(room.columnIndex, room.rowIndex);
}

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    objects: state.objects.map((object) => ({ ...object }))
  };
}

function isInside(state, object) {
  return object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height;
}

function shiftedObject(object, offsetX, offsetY) {
  return { ...object, x: object.x + offsetX, y: object.y + offsetY };
}

function directionFromDelta(dx, dy) {
  if (dx === 0 && dy < 0) return "up";
  if (dx > 0 && dy === 0) return "right";
  if (dx === 0 && dy > 0) return "down";
  if (dx < 0 && dy === 0) return "left";
  return null;
}

export class ConnectedWorldSessionV1 {
  constructor(engine, definitions, rooms) {
    this.engine = engine;
    this.definitions = definitions;
    this.definitionMap = definitions instanceof Map
      ? definitions
      : new Map((definitions || []).map((definition) => [definition.id, definition]));
    this.rooms = rooms || [];
    this.roomsByCell = new Map(this.rooms.map((room) => [roomKey(room), room]));
    this.roomWidth = this.rooms[0]?.width || 0;
    this.roomHeight = this.rooms[0]?.height || 0;
    this.solidBlockId = [...this.definitionMap.values()].find((definition) =>
      engineRoleIdForObject({ blockId: definition.id }, this.definitionMap) === "solid")?.id;
  }

  isPlayer(object) {
    return engineRoleIdForObject(object, this.definitionMap) === "player";
  }

  activePlayer(state) {
    const players = state.objects.filter((object) => isInside(state, object) && this.isPlayer(object));
    return players.length === 1 ? players[0] : null;
  }

  neighbor(room, direction) {
    const delta = DIRECTIONS[direction];
    if (!delta || !Number.isInteger(room?.columnIndex) || !Number.isInteger(room?.rowIndex)) return null;
    return this.roomsByCell.get(cellKey(
      room.columnIndex + delta.column,
      room.rowIndex + delta.row
    )) || null;
  }

  freshRoomState(room) {
    const state = this.engine.createState(room);
    return {
      ...state,
      objects: state.objects.filter((object) => !this.isPlayer(object))
    };
  }

  buildLayout(visited, commandRoom) {
    const entries = [...visited.values()];
    const minColumn = Math.min(...entries.map(({ room }) => room.columnIndex));
    const maxColumn = Math.max(...entries.map(({ room }) => room.columnIndex));
    const minRow = Math.min(...entries.map(({ room }) => room.rowIndex));
    const maxRow = Math.max(...entries.map(({ room }) => room.rowIndex));
    const placements = entries.map(({ room, state }) => ({
      room,
      state,
      offsetX: (room.columnIndex - minColumn) * this.roomWidth,
      offsetY: (room.rowIndex - minRow) * this.roomHeight
    }));
    const width = (maxColumn - minColumn + 1) * this.roomWidth;
    const height = (maxRow - minRow + 1) * this.roomHeight;
    const bodyGroups = new Map();
    const objects = placements.flatMap(({ room, state, offsetX, offsetY }, roomIndex) =>
      state.objects
        .filter((object) => isInside(state, object))
        .map((object) => {
          const shifted = shiftedObject(object, offsetX, offsetY);
          const role = engineRoleIdForObject(object, this.definitionMap);
          // Combining geometry must not combine the rooms' control circuits.
          // The C++ engine keeps this scope through every intermediate tick.
          if (placements.length > 1 && (role === "orange-button" || role === "orange-wall")) {
            shifted.connectedWorldOrangeScope = roomIndex + 1;
          }
          if (placements.length > 1 && role === "player") {
            // Opening the rectangle for player travel must preserve the room
            // borders for all other bodies, including pushed/carried objects.
            shifted.connectedWorldRoomWidth = this.roomWidth;
            shifted.connectedWorldRoomHeight = this.roomHeight;
          }
          const bodyRole = this.definitionMap.get(object.blockId)?.roleId;
          if (placements.length > 1 && (bodyRole === "clone" || bodyRole === "weightless-pushable")) {
            // Clones receive the input only in its originating room, even if
            // Ice or a punch carries the player through several other rooms.
            // Equal authored IDs in separate rooms are separate rigid bodies.
            const key = `${roomIndex}:${bodyRole}:${engineGenericIdForObject(object, this.definitionMap)}`;
            if (!bodyGroups.has(key)) bodyGroups.set(key, bodyGroups.size);
            shifted.connectedWorldBodyGroup = bodyGroups.get(key);
            if (bodyRole === "clone") {
              shifted.connectedWorldCloneCommandDisabled = roomKey(room) !== roomKey(commandRoom);
            }
          }
          return shifted;
        }));

    const zValues = objects.map((object) => Number(object.z)).filter(Number.isFinite);
    const minimumZ = Math.min(0, ...zValues) - 2;
    const maximumZ = Math.max(0, ...zValues) + 2;
    const boundaryKeys = new Set();
    const boundaryObjects = [];
    const addBoundaryColumn = (x, y) => {
      for (let z = minimumZ; z <= maximumZ; z += 1) {
        const key = `${x},${y},${z}`;
        if (boundaryKeys.has(key)) continue;
        boundaryKeys.add(key);
        boundaryObjects.push({
          x,
          y,
          z,
          blockId: this.solidBlockId,
          connectedWorldBoundary: true
        });
      }
    };

    placements.forEach(({ room, offsetX, offsetY }) => {
      Object.entries(DIRECTIONS).forEach(([direction, delta]) => {
        const neighborColumn = room.columnIndex + delta.column;
        const neighborRow = room.rowIndex + delta.row;
        const insideBounds = neighborColumn >= minColumn && neighborColumn <= maxColumn &&
          neighborRow >= minRow && neighborRow <= maxRow;
        if (!insideBounds || visited.has(cellKey(neighborColumn, neighborRow))) return;
        if (!this.solidBlockId) {
          throw new Error("Connected world needs a solid block definition for unvisited room boundaries.");
        }
        if (direction === "up" || direction === "down") {
          const y = direction === "up" ? offsetY - 1 : offsetY + this.roomHeight;
          for (let x = offsetX; x < offsetX + this.roomWidth; x += 1) addBoundaryColumn(x, y);
        } else {
          const x = direction === "left" ? offsetX - 1 : offsetX + this.roomWidth;
          for (let y = offsetY; y < offsetY + this.roomHeight; y += 1) addBoundaryColumn(x, y);
        }
      });
    });

    return {
      state: { width, height, objects: [...objects, ...boundaryObjects] },
      placements,
      minColumn,
      minRow
    };
  }

  placementForObject(object, layout) {
    return layout.placements.find(({ offsetX, offsetY }) =>
      object.x >= offsetX && object.y >= offsetY &&
      object.x < offsetX + this.roomWidth &&
      object.y < offsetY + this.roomHeight) || null;
  }

  playerPlacement(state, layout) {
    const player = this.activePlayer(state);
    if (!player) return null;
    const placement = this.placementForObject(player, layout);
    return placement ? { player, placement } : null;
  }

  projectState(state, placement) {
    const { offsetX, offsetY } = placement;
    return {
      width: this.roomWidth,
      height: this.roomHeight,
      objects: state.objects
        .filter((object) => !object.connectedWorldBoundary &&
          object.x >= offsetX && object.y >= offsetY &&
          object.x < offsetX + this.roomWidth &&
          object.y < offsetY + this.roomHeight)
        .map(({ connectedWorldOrangeScope, connectedWorldBodyGroup,
          connectedWorldCloneCommandDisabled, connectedWorldRoomWidth,
          connectedWorldRoomHeight, ...object }) =>
          ({ ...object, x: object.x - offsetX, y: object.y - offsetY }))
    };
  }

  playerIsOnIce(state, player) {
    return state.objects.some((object) => {
      if (object === player || object.x !== player.x || object.y !== player.y) return false;
      const roleId = engineRoleIdForObject(object, this.definitionMap);
      return (roleId === "ice" || roleId.startsWith("ice-slope-")) &&
        (object.z === player.z || object.z === player.z - 1);
    });
  }

  isAtRoomEdge(player, placement, direction) {
    if (direction === "up") return player.y === placement.offsetY;
    if (direction === "right") return player.x === placement.offsetX + this.roomWidth - 1;
    if (direction === "down") return player.y === placement.offsetY + this.roomHeight - 1;
    if (direction === "left") return player.x === placement.offsetX;
    return false;
  }

  exitIntent(simulation, layout, requestedDirection, blockedExits = new Set()) {
    const attachedRooms = new Set(layout.placements.map(({ room }) => roomKey(room)));
    const candidate = (located, direction) => {
      if (!located || !direction || !this.isAtRoomEdge(located.player, located.placement, direction)) return null;
      const { placement } = located;
      const key = `${roomKey(placement.room)}:${direction}`;
      const nextRoom = this.neighbor(placement.room, direction);
      if (!nextRoom || attachedRooms.has(roomKey(nextRoom)) || blockedExits.has(key)) return null;
      return { direction, placement, nextRoom, key };
    };

    // An outward command may reflect immediately if it starts on an edge slope.
    const initial = this.playerPlacement(layout.state, layout);
    const initialExit = candidate(initial, requestedDirection);
    if (initialExit) return initialExit;

    let previous = initial?.player;
    const punchedDirections = new Set();
    // The final cycle frame is a rollback, not physical movement.
    const frames = simulation.cycle ? simulation.frames.slice(0, -1) : simulation.frames;
    for (const state of frames) {
      for (const object of state.objects) {
        const definition = this.definitionMap.get(object.blockId);
        if (definition?.roleId !== "puncher" && definition?.visual?.kind !== "puncher") continue;
        if (object.stateId === 1 || object.engineGenericId % 2 === 1) {
          punchedDirections.add(ORIENTATION_DIRECTIONS[String(object.orientation).toLowerCase()]);
        }
      }
      const located = this.playerPlacement(state, layout);
      const player = located?.player;
      const direction = player && previous
        ? directionFromDelta(player.x - previous.x, player.y - previous.y)
        : null;
      previous = player;
      const exit = candidate(located, direction);
      // Inspect the first edge contact, before a temporary boundary can bounce
      // the player back into the room or turn the command into a cycle.
      if (exit && (this.playerIsOnIce(state, player) || punchedDirections.has(direction))) return exit;
    }
    return null;
  }

  projectSimulation(simulation, layout, fallbackRoom) {
    let activePlacement = this.playerPlacement(layout.state, layout)?.placement ||
      layout.placements.find(({ room }) => room === fallbackRoom) || layout.placements[0];
    const animationFrames = simulation.frames.map((state) => {
      activePlacement = this.playerPlacement(state, layout)?.placement || activePlacement;
      return {
        room: activePlacement.room,
        state: this.projectState(state, activePlacement)
      };
    });
    activePlacement = this.playerPlacement(simulation.final, layout)?.placement || activePlacement;
    const connectedRooms = new Set(animationFrames.map(({ room }) => room.fileName));
    connectedRooms.add(activePlacement.room.fileName);
    return {
      ...simulation,
      room: activePlacement.room,
      final: this.projectState(simulation.final, activePlacement),
      frames: animationFrames.map(({ state }) => state),
      animationFrames,
      connectedRooms: [...connectedRooms]
    };
  }

  async simulateCommand(state, room, requestedDirection) {
    const direction = String(requestedDirection).toLowerCase();
    if (!DIRECTIONS[direction] || !this.activePlayer(state)) {
      return this.engine.simulateCommand(state, direction, this.definitions);
    }

    const visited = new Map([[roomKey(room), { room, state: cloneState(state) }]]);
    const blockedExits = new Set();
    let layout = this.buildLayout(visited, room);
    let simulation = await this.engine.simulateCommand(layout.state, direction, this.definitions);
    // Each attempt either attaches a room or rejects one of its four seams.
    for (let attempt = 0; attempt <= this.rooms.length * 4; attempt += 1) {
      const exit = this.exitIntent(simulation, layout, direction, blockedExits);
      if (!exit) return this.projectSimulation(simulation, layout, room);
      const { nextRoom } = exit;
      const nextKey = roomKey(nextRoom);
      visited.set(nextKey, {
        room: nextRoom,
        state: this.freshRoomState(nextRoom)
      });
      const expandedLayout = this.buildLayout(visited, room);
      const expandedSimulation = await this.engine.simulateCommand(
        expandedLayout.state, direction, this.definitions
      );
      const projected = this.projectSimulation(expandedSimulation, expandedLayout, room);
      if (!projected.connectedRooms.includes(nextRoom.fileName)) {
        // A real obstruction still wins. Keep the original trace, but allow a
        // later edge contact in that trace to try a different neighboring room.
        visited.delete(nextKey);
        blockedExits.add(exit.key);
        continue;
      }
      layout = expandedLayout;
      simulation = expandedSimulation;
    }
    throw new Error("Connected world crossed too many rooms in one command.");
  }
}
