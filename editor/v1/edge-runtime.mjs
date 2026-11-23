import { engineRoleIdForObject } from "../../engine/current/adapter.mjs";
import { ConnectedWorldSessionV1 } from "../../play/current/connected-world-session.mjs";

function cloneState(state) {
  return { width: state.width, height: state.height, objects: state.objects.map((object) => ({ ...object })) };
}

function stateKey(roomFileName, state, collectedGemIds = []) {
  return JSON.stringify({ roomFileName, state, collectedGemIds: [...collectedGemIds].sort() });
}

export function tagEdgeFinderObjectsV1(world, overrideRoom = null) {
  const rooms = world.rooms.map((room) => {
    const source = room.fileName === overrideRoom?.fileName ? overrideRoom : room;
    return {
      ...room,
      width: source.width,
      height: source.height,
      objects: source.objects.map((object, index) => ({
        ...object,
        edgeFinderObjectId: `${room.fileName}:${index}`
      }))
    };
  });
  return { ...world, rooms };
}

function activePlayer(state, definitions) {
  return state.objects.find((object) => object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height &&
    engineRoleIdForObject(object, definitions) === "player") || null;
}

function activeGoals(state, definitions) {
  return new Set(state.objects.filter((object) => object.x >= 0 && object.y >= 0 &&
    object.x < state.width && object.y < state.height &&
    engineRoleIdForObject(object, definitions) === "goal")
    .map((object) => object.edgeFinderObjectId));
}

function collectFrameGoals(activeByRoom, collected, room, state, definitions) {
  const current = activeGoals(state, definitions);
  const previous = activeByRoom.get(room.fileName) || activeGoals(room, definitions);
  for (const id of previous) if (!current.has(id)) collected.add(id);
  activeByRoom.set(room.fileName, current);
}

async function replayWitness(engine, definitions, connected, startRoom, startState, solution) {
  let room = startRoom;
  let state = cloneState(startState);
  let lastPlayer = activePlayer(state, definitions);
  const collected = new Set();
  const activeByRoom = new Map([[room.fileName, activeGoals(state, definitions)]]);
  for (let step = 0; step < solution.length; step += 1) {
    const simulation = await connected.simulateCommand(state, room, solution[step]);
    const trace = simulation.animationFrames?.length
      ? simulation.animationFrames
      : [{ room: simulation.room || room, state: simulation.final }];
    const hops = [];
    let traceRoom = room;
    for (const frame of trace) {
      collectFrameGoals(activeByRoom, collected, frame.room, frame.state, definitions);
      const player = activePlayer(frame.state, definitions);
      if (frame.room.fileName !== traceRoom.fileName) {
        hops.push({
          fromRoomFileName: traceRoom.fileName,
          toRoomFileName: frame.room.fileName,
          exit: lastPlayer ? { x: lastPlayer.x, y: lastPlayer.y, z: lastPlayer.z } : null,
          entry: player ? { x: player.x, y: player.y, z: player.z } : null
        });
      }
      traceRoom = frame.room;
      if (player) lastPlayer = player;
    }
    state = simulation.final;
    if (simulation.room.fileName !== room.fileName) {
      return {
        solution: solution.slice(0, step + 1),
        destinationRoom: simulation.room,
        destinationState: state,
        collectedGemIds: [...collected].sort(),
        hops
      };
    }
    room = simulation.room;
  }
  return null;
}

export async function findRoomTransitionsV1(engine, definitions, world, node, options = {}) {
  const room = world.rooms.find((candidate) => candidate.fileName === node.roomFileName);
  if (!room) throw new Error(`Unknown edge-finder room: ${node.roomFileName}`);
  const search = engine.findEdges(node.state, definitions, options);
  const connected = new ConnectedWorldSessionV1(engine, definitions, world.rooms);
  const outcomes = new Map();
  for (const edge of search.edges) {
    const outcome = await replayWitness(engine, definitions, connected, room, node.state, edge.solution);
    if (!outcome?.hops.length) continue;
    const key = `${stateKey(outcome.destinationRoom.fileName, outcome.destinationState, outcome.collectedGemIds)}\n${JSON.stringify(outcome.hops)}`;
    const previous = outcomes.get(key);
    if (!previous || outcome.solution.length < previous.solution.length) outcomes.set(key, outcome);
  }
  return { search: { ...search, edges: undefined }, transitions: [...outcomes.values()] };
}
