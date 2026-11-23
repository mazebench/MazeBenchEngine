import { objectIdentity, presentationIdentities } from "../../play/current/presentation-identity.mjs";
// Human presentation only. Never write interpolated values into engine states.
export const DEFAULT_STEP_MS = 100;
export const SLIDE_TILE_MS = 40;
export const ROOM_TRANSITION_MS = 250;
export const RESET_TRANSITION_MS = 250;
export const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const clamp = t => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-8);
const delta = (a, b) => a.map((v, i) => b[i] - v);
const length = v => Math.max(...v.map(Math.abs));
const unit = v => v.map(n => n / (length(v) || 1));
const visible = (object, state) => object && !object.connectedWorldBoundary && !object.engineHidden &&
  object.x >= 0 && object.y >= 0 && object.x < state.width && object.y < state.height &&
  Number.isFinite(object.z) && object.z > -1e6;

// Coalesce uninterrupted collinear motion. Stops, reversals and turns start
// another segment; single-cell segments ease, longer ones cruise.
export function motionSegments(values, times) {
  const segments = [];
  for (let i = 1; i < values.length; i++) {
    const from = values[i - 1], to = values[i];
    const movement = delta(from, to);
    if (!length(movement)) continue;
    const direction = unit(movement);
    const previous = segments.at(-1);
    if (previous && previous.end === times[i - 1] && same(previous.direction, direction)) {
      previous.to = to;
      previous.end = times[i];
      previous.distance += length(movement);
    } else {
      const segment = { from, to, start: times[i - 1], end: times[i], direction, distance: length(movement) };
      // A straight slide over a ramp keeps cruising through the change in
      // elevation, while retaining the ramp's actual piecewise path.
      if (movement.length === 3 && previous?.end === segment.start &&
          length(movement.slice(0, 2)) && same(unit(previous.direction.slice(0, 2)), unit(movement.slice(0, 2)))) {
        previous.linear = segment.linear = true;
      }
      segments.push(segment);
    }
  }
  return segments;
}

export function sampleSegments(segments, initial, time, { alwaysEase = false } = {}) {
  // Later transitions retarget from the displayed value. Do not shorten the
  // previous easing curve: that would retroactively change its earlier frames.
  const segment = segments.findLast(segment => time >= segment.start);
  if (!segment) return initial;
  if (time >= segment.end) return segment.to;
  const progress = clamp((time - segment.start) / (segment.end - segment.start));
  const t = alwaysEase || segment.ease || (!segment.linear && segment.distance < 2) ? easeInOut(progress) : progress;
  return segment.from.map((v, i) => lerp(v, segment.to[i], t));
}

export function sampleTrack(track, time) {
  const position = sampleSegments(track.motion, track.positions[0], time);
  return {
    x: position[0], y: position[1], z: position[2],
    phase: sampleSegments(track.phases, [track.initialPhase], time, { alwaysEase: true })[0],
    opacity: sampleSegments(track.fades, [track.initialOpacity], time, { alwaysEase: true })[0]
  };
}

// A replay room jump crossfades the departing and arriving player. Camera
// truncation follows the more visible pose, including when scrubbing backward.
export function sampleTimelinePlayer(timeline, time) {
  let player = null;
  for (const track of timeline.tracks) if (track.block.roleId === "player") {
    const pose = sampleTrack(track, time);
    if (!player || pose.opacity >= player.opacity) player = pose;
  }
  return player;
}

export function createCommandTimeline({ state, room, simulation, definitions, stepMs = DEFAULT_STEP_MS, slideMs = stepMs * SLIDE_TILE_MS / DEFAULT_STEP_MS, cameraMs = ROOM_TRANSITION_MS }) {
  const blocks = definitions instanceof Map ? definitions : new Map(definitions.map(block => [block.id, block]));
  const trace = simulation.presentation || {
    initial: state, frames: simulation.frames, rooms: [room],
    originX: (room.columnIndex || 0) * state.width,
    originY: (room.rowIndex || 0) * state.height
  };
  // A cycle's last frame is a rollback, not travel across the board.
  const frames = simulation.cycle ? trace.frames.slice(0, -1) : trace.frames;
  const states = [trace.initial, ...frames];
  const frameRooms = [room, ...(simulation.animationFrames || frames.map(() => ({ room })))
    .slice(0, frames.length).map(frame => frame.room)];
  const tracks = [], moving = [];
  const identities = trace.identities || presentationIdentities(state, room);
  const direction = { up: [0, -1, 0], right: [1, 0, 0], down: [0, 1, 0], left: [-1, 0, 0] }[simulation.direction];
  for (let index = 0; index < trace.initial.objects.length; index++) {
    const object = trace.initial.objects[index];
    if (object.connectedWorldBoundary || !blocks.has(object.blockId)) continue;
    const block = blocks.get(object.blockId);
    const mechanism = ["gate", "lift", "puncher"].includes(block.visual?.kind);
    const active = visible(object, trace.initial);
    const phase = mechanism && object.stateId === 1 ? 1 : 0;
    // Most of a room is unchanged terrain. Detect it without allocating a
    // position/phase/opacity array for every physics tick, or visiting it again
    // in each timing and curve pass. Keep object metadata on the track as before.
    if (states.every(snapshot => {
      const current = snapshot.objects[index];
      return current && current.x === object.x && current.y === object.y && current.z === object.z &&
        visible(current, snapshot) === active && (!mechanism || Number(current.stateId === 1) === phase);
    })) {
      tracks.push({ index, key: identities[index], object, block,
        positions: [[object.x + trace.originX, object.y + trace.originY, active ? object.z : Math.max(-1, object.z)]],
        motion: [], phases: [], fades: [], initialPhase: phase, initialOpacity: active ? 1 : 0, changed: false });
      continue;
    }
    const positions = [], phases = [], opacities = [];
    let heading = null;
    for (let tick = 0; tick < states.length; tick++) {
      const current = states[tick].objects[index];
      const active = visible(current, states[tick]);
      let position = active ? [current.x + trace.originX, current.y + trace.originY, current.z]
        : positions.at(-1) || [object.x + trace.originX, object.y + trace.originY, Math.max(-1, object.z)];
      if (!active && opacities.at(-1)?.[0] === 1) {
        const continuation = heading || (blocks.get(object.blockId).roleId === "player" ? direction : null);
        if (continuation) position = position.map((n, axis) => n + continuation[axis]);
        else if (current?.z < -1e6) position = [position[0], position[1], position[2] - 1];
      }
      if (active && positions.length && opacities.at(-1)?.[0] === 1) {
        const movement = delta(positions.at(-1), position);
        if (length(movement)) heading = unit(movement);
        else heading = null; // a stationary collectible must not fly off later
      }
      positions.push(position);
      phases.push([["gate", "lift", "puncher"].includes(blocks.get(object.blockId).visual?.kind) && current?.stateId === 1 ? 1 : 0]);
      opacities.push([active ? 1 : 0]);
    }
    const track = { index, key: identities[index], object, block, positions, phaseValues: phases, opacityValues: opacities };
    tracks.push(track); moving.push(track);
  }

  // Drop empty physics ticks, but preserve every changed position/mechanism.
  const ticks = [0];
  for (let tick = 1; tick < states.length; tick++) {
    const previous = ticks.at(-1);
    if (!moving.some(track => !same(track.positions[previous], track.positions[tick]) ||
      !same(track.phaseValues[previous], track.phaseValues[tick]) || !same(track.opacityValues[previous], track.opacityValues[tick]))) continue;
    ticks.push(tick);
  }
  const slideIntervals = new Set();
  for (const track of moving) {
    const segments = motionSegments(ticks.map(tick => track.positions[tick]), ticks.map((_, i) => i));
    for (const segment of segments) if (segment.distance >= 2 || segment.linear) {
      for (let i = segment.start + 1; i <= segment.end; i++) slideIntervals.add(i);
    }
  }
  const times = [0];
  for (let i = 1; i < ticks.length; i++) {
    const distance = Math.max(1, ...moving.map(track => length(delta(track.positions[ticks[i - 1]], track.positions[ticks[i]]))));
    times.push(times.at(-1) + Math.max(0, slideIntervals.has(i) ? slideMs : stepMs) * distance);
  }
  for (const track of moving) {
    track.positions = ticks.map(tick => track.positions[tick]);
    const phases = ticks.map(tick => track.phaseValues[tick]);
    const opacities = ticks.map(tick => track.opacityValues[tick]);
    track.motion = motionSegments(track.positions, times);
    track.phases = motionSegments(phases, times);
    track.fades = motionSegments(opacities, times);
    track.initialPhase = phases[0][0];
    track.initialOpacity = opacities[0][0];
    track.changed = Boolean(track.motion.length || track.phases.length || track.fades.length);
    delete track.phaseValues;
    delete track.opacityValues;
  }

  // Camera follows room centres, smoothly from its current offset when a second
  // boundary is crossed before the previous transition has finished.
  const camera = [], lighting = [];
  const initialLight = trace.rooms.map(candidate => Number(candidate.fileName === room.fileName));
  const startCenter = [(room.columnIndex || 0) * state.width, (room.rowIndex || 0) * state.height];
  let currentRoom = room;
  for (let i = 1; i < ticks.length; i++) {
    const nextRoom = frameRooms[ticks[i]] || currentRoom;
    if (nextRoom.fileName === currentRoom.fileName) continue;
    const start = times[i - 1];
    const from = sampleSegments(camera, [0, 0], start, { alwaysEase: true });
    const to = [(nextRoom.columnIndex || 0) * state.width - startCenter[0], (nextRoom.rowIndex || 0) * state.height - startCenter[1]];
    camera.push({ from, to, start, end: start + cameraMs, distance: 1 });
    lighting.push({
      from: sampleSegments(lighting, initialLight, start, { alwaysEase: true }),
      to: trace.rooms.map(candidate => Number(candidate.fileName === nextRoom.fileName)),
      start, end: start + cameraMs, distance: 1
    });
    currentRoom = nextRoom;
  }
  const timeline = {
    tracks, times, ticks, frames: states, frameRooms, rooms: trace.rooms,
    originX: trace.originX, originY: trace.originY,
    camera, lighting, initialLight, duration: Math.max(times.at(-1), camera.at(-1)?.end || 0)
  };
  if (simulation.presentation && !simulation.cycle) {
    const finalRoom = simulation.room || room;
    for (const departed of trace.rooms) {
      if (departed.fileName === finalRoom.fileName) continue;
      // Reset after this room's last physical change, overlapping the camera
      // transition and any remaining travel through subsequent rooms.
      const targets = roomTargets(departed, departed, blocks, false);
      const keys = new Set(targets.map(target => target.key));
      let start = 0;
      for (let i = 1; i < ticks.length; i++) {
        if (frameRooms[ticks[i - 1]]?.fileName === departed.fileName) start = times[i];
      }
      for (const track of tracks) if (keys.has(track.key)) {
        start = Math.max(start, track.motion.at(-1)?.end || 0,
          track.phases.at(-1)?.end || 0, track.fades.at(-1)?.end || 0);
      }
      appendReset(timeline, targets, start);
    }
  }
  return timeline;
}

// Rigid bodies with the same complete motion share joined cube/slope geometry.
export function groupMovingTracks(tracks) {
  const groups = new Map();
  for (const track of tracks.filter(track => track.changed)) {
    const mechanism = ["gate", "lift", "puncher"].includes(track.block.visual?.kind);
    const first = track.positions[0];
    const key = mechanism ? `mechanism:${track.index}` : JSON.stringify([
      track.motion.map(segment => ({ ...segment,
        from: delta(first, segment.from), to: delta(first, segment.to) })),
      track.fades, track.initialOpacity
    ]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(track);
  }
  return [...groups.values()];
}


function roomTargets(state, room, blocks, includePlayer = true) {
  const keys = state === room ? state.objects.map((_, index) => objectIdentity(room, index))
    : presentationIdentities(state, room);
  return state.objects.flatMap((object, index) => {
    const block = blocks.get(object.blockId);
    if (!block || (!includePlayer && block.roleId === "player")) return [];
    return [{ key: keys[index], object, block,
      position: [object.x + (room.columnIndex || 0) * state.width,
        object.y + (room.rowIndex || 0) * state.height, object.z],
      phase: ["gate", "lift", "puncher"].includes(block.visual?.kind) && object.stateId === 1 ? 1 : 0,
      opacity: visible(object, state) ? 1 : 0 }];
  });
}

function appendReset(timeline, targets, start) {
  const byKey = new Map(timeline.tracks.map(track => [track.key, track]));
  const end = start + RESET_TRANSITION_MS;
  for (const target of targets) {
    let track = byKey.get(target.key);
    if (!track) {
      track = { index: timeline.tracks.length, key: target.key, object: target.object, block: target.block,
        positions: [target.position], motion: [], phases: [], fades: [],
        initialOpacity: 0, initialPhase: target.phase, changed: false };
      timeline.tracks.push(track);
    }
    const from = sampleTrack(track, start);
    // An absent object reappears at its restored location, never at the engine's
    // off-board sentinel. Existing objects return from their displayed pose.
    if (!from.opacity && !track.motion.length) {
      track.positions[0] = target.position;
      from.x = target.position[0]; from.y = target.position[1]; from.z = target.position[2];
      track.object = target.object;
    }
    for (const [segments, a, b] of [
      [track.motion, [from.x, from.y, from.z], target.opacity ? target.position : [from.x, from.y, from.z]],
      [track.phases, [from.phase], [target.phase]], [track.fades, [from.opacity], [target.opacity]]
    ]) {
      if (same(a, b)) continue;
      segments.push({ from: a, to: b, start, end, distance: length(delta(a, b)), ease: true });
      track.changed = true;
      timeline.duration = Math.max(timeline.duration, end);
    }
  }
}

// Capture interpolated poses before aborting an in-flight command/reset. This
// snapshot stays entirely in presentation space, including fractional phases.
export function captureTimeline(timeline, time) {
  return { rooms: timeline.rooms, tracks: timeline.tracks.map(track => {
    const value = sampleTrack(track, time);
    return { ...track, positions: [[value.x, value.y, value.z]],
      motion: [], phases: [], fades: [], initialPhase: value.phase,
      initialOpacity: value.opacity, changed: false };
  }) };
}

export function createResetTimeline({ state, resetState, room, definitions, snapshot }) {
  const blocks = definitions instanceof Map ? definitions : new Map(definitions.map(block => [block.id, block]));
  const base = createCommandTimeline({ state, room, definitions: blocks,
    simulation: { frames: [], final: state } });
  const timeline = snapshot ? { ...base, ...captureTimeline(snapshot, 0) } : base;
  const targets = timeline.rooms.flatMap(candidate => candidate.fileName === room.fileName
    ? roomTargets(resetState, room, blocks)
    : roomTargets(candidate, candidate, blocks, false));
  const keys = new Set(targets.map(target => target.key));
  for (const track of timeline.tracks) if (!keys.has(track.key)) {
    targets.push({ ...track, position: track.positions[0], phase: track.initialPhase, opacity: 0 });
  }
  appendReset(timeline, targets, 0);
  return timeline;
}
