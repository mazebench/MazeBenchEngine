import { ConnectedWorldSessionV1 } from "../../play/current/connected-world-session.mjs";
import { presentationIdentities, rememberPresentationIdentities } from "../../play/current/presentation-identity.mjs";
import { engineRoleIdForObject } from "../../engine/current/adapter.mjs";
import { createCommandTimeline, createResetTimeline, sampleSegments, ROOM_TRANSITION_MS, DEFAULT_STEP_MS } from "../../animations/v1/timeline.mjs";
import { resolveRoom } from "./import.mjs";
import { TimelinePool } from "./timeline-pool.mjs";

const inside = (o, state) => o.x >= 0 && o.y >= 0 && o.x < state.width && o.y < state.height && o.z > -1e6;
export const gemId = (room, index) => `${room.fileName}:${index}`;
export const roomCenter = (world, room) => [
  (room.columnIndex + .5 - world.columns.length / 2) * world.roomWidth,
  (room.rowIndex + .5 - world.rows.length / 2) * world.roomHeight
];

class ReplayPhysics extends ConnectedWorldSessionV1 {
  collected = new Set();
  filterGems(state, room) {
    const identities = presentationIdentities(state, room);
    const keep = state.objects.map(o => !this.collected.has(o.solutionObjectId));
    const result = { ...state, objects: state.objects.filter((_, index) => keep[index]) };
    rememberPresentationIdentities(result, identities.filter((_, index) => keep[index]));
    return result;
  }
  freshRoomState(room) { return this.filterGems(super.freshRoomState(room), room); }
  projectSimulation(simulation, layout, room) {
    const result = super.projectSimulation(simulation, layout, room);
    result.gained = simulation.cycle ? [] : [...new Set([...simulation.frames, simulation.final].flatMap(state =>
      state.objects.filter(o => engineRoleIdForObject(o, this.definitionMap) === "goal" && !inside(o, state)).map(o => o.solutionObjectId)))];
    return result;
  }
}

export async function compileReplay(engine, sourceWorld, imported, { onProgress = () => {}, cancelled = () => false } = {}) {
  const world = { ...sourceWorld, rooms: sourceWorld.rooms.map(room => ({ ...room,
    objects: room.objects.map((object, index) => ({ ...object, solutionObjectId: gemId(room, index) })) })) };
  const definitions = sourceWorld.blockDefinitions || new Map(sourceWorld.blocks.map(block => [block.id, block]));
  const physics = new ReplayPhysics(engine, definitions, world.rooms, { presentation: true });
  let room = resolveRoom(world, imported.start), state = engine.createState(room);
  if (!physics.activePlayer(state)) throw new Error(`${room.position.join("×")} has no player start.`);
  const startRoom = room.fileName, clips = [], visits = [{ room: startRoom, at: 0 }], gems = [], pool = new TimelinePool();
  const visited = new Set([startRoom]);
  let duration = 0, lastYield = 0;
  for (const [index, command] of imported.commands.entries()) {
    if (cancelled()) throw new Error("Import cancelled.");
    const from = room, center = roomCenter(world, from);
    let timeline, label, finalRoom = from;
    const gemsBefore = physics.collected.size;
    if (command.type === "room") {
      const previousState = state;
      room = resolveRoom(world, command.room);
      state = physics.filterGems(engine.createState(room), room);
      if (!physics.activePlayer(state)) throw new Error(`Command ${index + 1}: ${room.position.join("×")} has no player start.`);
      finalRoom = room;
      if (from.fileName === room.fileName) {
        timeline = createResetTimeline({ state: previousState, resetState: state, room, definitions });
      } else {
        // Explicit room jumps restore the departed room too. Fade the player
        // between starts while the camera travels, instead of snapping boxes
        // and mechanisms back beneath a still-moving camera.
        const resetState = physics.freshRoomState(from);
        const departure = createResetTimeline({ state: previousState, resetState, room: from, definitions });
        timeline = createCommandTimeline({ state, room, definitions, simulation: { frames: [], final: state } });
        for (const track of timeline.tracks) if (track.block.roleId === "player") {
          track.initialOpacity = 0;
          track.changed = true;
          track.fades = [{ from: [0], to: [1], start: 0, end: ROOM_TRANSITION_MS, distance: 1, ease: true }];
        }
        timeline.tracks = [...departure.tracks, ...timeline.tracks].map((track, index) => ({ ...track, index }));
        timeline.rooms = [from, room];
      }
      const to = roomCenter(world, room).map((n, axis) => n - center[axis]);
      timeline.camera = [{ from: [0, 0], to, start: 0, end: ROOM_TRANSITION_MS, distance: 1 }];
      timeline.duration = ROOM_TRANSITION_MS;
      label = `Room ${room.position.join("×")}`;
    } else {
      let simulation;
      try { simulation = await physics.simulateCommand(state, room, command.direction); }
      catch (error) { throw new Error(`Command ${index + 1}: ${error.message}`); }
      for (const id of simulation.gained || []) if (id && !physics.collected.has(id)) {
        physics.collected.add(id); gems.push({ id, command: index });
      }
      // Reset-on-leave should not animate a collected gem back into the world.
      if (simulation.presentation) simulation.presentation.rooms = simulation.presentation.rooms.map(candidate => ({ ...candidate,
        objects: candidate.objects.map(o => physics.collected.has(o.solutionObjectId) ? { ...o, engineHidden: true } : o) }));
      timeline = createCommandTimeline({ state, room, simulation, definitions });
      timeline.duration = Math.max(DEFAULT_STEP_MS, timeline.duration);
      state = simulation.final;
      finalRoom = simulation.room || room;
      room = finalRoom;
      label = command.direction[0].toUpperCase();
    }
    // Camera travel and departed-room resets can outlast the actual command.
    // Events belong to the physics tween, not the end of that extra animation.
    const settledAt = command.type === "room" ? timeline.duration : timeline.times.at(-1);
    for (const gem of gems.slice(gemsBefore)) {
      const track = timeline.tracks.find(track => track.object.solutionObjectId === gem.id);
      const fade = track?.fades.find(segment => segment.from[0] > 0 && segment.to[0] === 0);
      gem.at = duration + (fade?.end ?? settledAt);
      gem.room = gem.id.slice(0, gem.id.lastIndexOf(":"));
    }
    const asciiFrames = command.type === "room"
      ? [{ at: 0, room: from.fileName }, { at: timeline.duration, room: finalRoom.fileName }]
      : timeline.times.map((at, index) => ({ at, room: (timeline.frameRooms[timeline.ticks[index]] || from).fileName }));
    const clip = { ...pool.pack(timeline), asciiFrames, start: duration, duration: timeline.duration, settledAt, center,
      room: command.type === "room" ? finalRoom.fileName : from.fileName, from: from.fileName, to: finalRoom.fileName,
      label, type: command.type, gemsBefore, gemsAfter: physics.collected.size };
    clips.push(clip);
    duration += timeline.duration;
    // Award the visit on the first move that settles here with a living player.
    if (!visited.has(finalRoom.fileName) && physics.activePlayer(state)) {
      visited.add(finalRoom.fileName);
      visits.push({ room: finalRoom.fileName, at: clip.start + settledAt });
    }
    if (performance.now() - lastYield > 40 || index === imported.commands.length - 1) {
      onProgress(index + 1, imported.commands.length);
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  gems.sort((a, b) => a.at - b.at);
  return { name: imported.name, notice: imported.notice || "", startRoom, duration, clips, visits, gems,
    templates: pool.templates, layouts: pool.layouts };
}

export function locateReplay(movie, requested) {
  const time = Math.max(0, Math.min(movie.duration, Number(requested) || 0));
  let low = 0, high = movie.clips.length;
  while (low + 1 < high) { const mid = (low + high) >>> 1; if (movie.clips[mid].start <= time) low = mid; else high = mid; }
  const clip = movie.clips[low];
  return { index: low, clip, time, local: Math.min(clip.duration, time - clip.start) };
}

export function replayCamera(clip, time) {
  return sampleSegments(clip.camera, [0, 0], time, { alwaysEase: true }).map((offset, axis) => clip.center[axis] + offset);
}

export function unpackTimeline(movie, clip, world) {
  const definitions = world.blockDefinitions, rooms = new Map(world.rooms.map(room => [room.fileName, room]));
  const tracks = [...movie.layouts[clip.layout]].map(id => movie.templates[id]).concat(clip.moving)
    .map(track => ({ ...track, block: definitions.get(track.block) }));
  // Camera and lighting are sampled independently, preserving a user's orbit
  // and pan when seeking in either direction or pausing halfway through a move.
  return { tracks, rooms: clip.rooms.map(id => rooms.get(id)), duration: clip.duration, camera: [], lighting: [] };
}
