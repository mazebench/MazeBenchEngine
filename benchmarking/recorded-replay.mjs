// Presentation-only bridge from authenticated run poses to the same
// sampled curves and retained scene format used by the Replays page.
import { createCommandTimeline, createResetTimeline, captureTimeline, sampleSegments, DEFAULT_STEP_MS, ROOM_TRANSITION_MS } from '../animations/v1/timeline.mjs';
import { rememberPresentationIdentities } from '../play/current/presentation-identity.mjs';
import { TimelinePool } from '../replays/v1/timeline-pool.mjs';
import { roomCenter } from '../replays/v1/movie.mjs';

const movingRoles = new Set(['player', 'clone', 'pushable', 'weightless-pushable', 'floating-floor']);
const movement = action => ['up', 'down', 'left', 'right'].includes(action);
const label = room => room.position.join('x');

// Projection preserves the ordering of each rigid body's cells. Position keys
// keep disappearing fixtures from shifting the identities of their neighbours.
function keyedObjects(room, objects, definitions, separatePlayer = false) {
  const counts = new Map(), result = new Map();
  for (const object of objects) {
    const role = definitions.get(object.blockId)?.roleId;
    const descriptor = JSON.stringify([object.blockId, object.genericId, object.groupId, object.orientation, object.variantId, object.instanceId]);
    const ordinal = counts.get(descriptor) || 0; counts.set(descriptor, ordinal + 1);
    const identity = role === 'player' ? (separatePlayer ? `${room.fileName}:player` : 'player')
      : `${room.fileName}:${descriptor}:${movingRoles.has(role) ? ordinal : [object.x, object.y, object.z].join(',')}`;
    result.set(identity, { ...object, x: object.x + room.columnIndex * room.width, y: object.y + room.rowIndex * room.height });
  }
  return result;
}

export function recordedTimeline(world, action, recorded, { cycle = false, authoredRooms = world.rooms } = {}) {
  const definitions = world.blockDefinitions || new Map(world.blocks.map(block => [block.id, block]));
  const byLabel = new Map(world.rooms.map(room => [label(room), room]));
  const frameRooms = recorded.map(frame => byLabel.get(frame.room));
  if (frameRooms.some(room => !room)) throw new Error('Recorded replay names an unknown room.');
  const rooms = [...new Map(frameRooms.map(room => [room.fileName, room])).values()];
  const jump = !movement(action) && rooms.length > 1;
  const maps = recorded.map((frame, i) => keyedObjects(frameRooms[i], frame.objects, definitions, jump));
  const scenery = new Map();
  rooms.forEach(room => scenery.set(room.fileName, maps[frameRooms.findIndex(r => r === room)]));
  const combined = maps.map((map, i) => {
    scenery.set(frameRooms[i].fileName, map);
    return new Map(rooms.flatMap(room => [...scenery.get(room.fileName)].filter(([key, object]) =>
      definitions.get(object.blockId)?.roleId !== 'player' || room === frameRooms[i])));
  });
  const templates = new Map(combined.flatMap(map => [...map]));
  const keys = [...templates.keys()];
  const state = map => rememberPresentationIdentities({ width: world.columns.length * world.roomWidth,
    height: world.rows.length * world.roomHeight, objects: keys.map(key => map.get(key) || { ...templates.get(key), engineHidden: true }) }, keys);
  const states = combined.map(state);
  const origin = { ...frameRooms[0], columnIndex: 0, rowIndex: 0 };
  let timeline;
  if (!movement(action) && recorded.length > 1) {
    timeline = createResetTimeline({ state: states[0], resetState: states.at(-1), room: origin, definitions });
    timeline.ticks = [0, recorded.length - 1]; timeline.times = [0, timeline.duration || 250];
  } else {
    timeline = createCommandTimeline({ state: states[0], room: origin, definitions,
      simulation: { frames: states.slice(1, cycle ? -1 : undefined), direction: action } });
  }
  timeline.rooms = rooms;
  timeline.camera = []; timeline.lighting = [];
  timeline.initialLight = rooms.map(room => Number(room === frameRooms[0]));
  let previous = frameRooms[0];
  for (let i = 1; i < timeline.ticks.length; i++) {
    const next = frameRooms[timeline.ticks[i]];
    if (previous === next) continue;
    const start = jump ? 0 : timeline.times[i - 1], end = start + ROOM_TRANSITION_MS;
    timeline.camera.push({ from: sampleSegments(timeline.camera, [0, 0], start, { alwaysEase: true }),
      to: [(next.columnIndex - frameRooms[0].columnIndex) * world.roomWidth, (next.rowIndex - frameRooms[0].rowIndex) * world.roomHeight], start, end, distance: 1 });
    timeline.lighting.push({ from: sampleSegments(timeline.lighting, timeline.initialLight, start, { alwaysEase: true }),
      to: rooms.map(room => Number(room === next)), start, end, distance: 1 });
    previous = next;
  }
  // Restore departed scenery with the same 250 ms reset curves as Replays.
  const departed = rooms.filter(room => room !== frameRooms.at(-1));
  if ((movement(action) && departed.length) || cycle) {
    const resetMap = new Map(combined.at(-1));
    for (const room of departed) {
      for (const [key, object] of resetMap) if (key.startsWith(room.fileName + ':')) resetMap.delete(key);
      const authored = authoredRooms.find(candidate => candidate.fileName === room.fileName) || room;
      for (const [key, object] of keyedObjects(room, authored.objects, definitions)) {
        const role = definitions.get(object.blockId)?.roleId;
        if (role !== 'player' && (role !== 'goal' || combined.at(-1).has(key))) resetMap.set(key, object);
      }
    }
    const start = timeline.times.at(-1) || 0;
    const reset = createResetTimeline({ state: states[0], resetState: state(resetMap), room: origin, definitions,
      snapshot: captureTimeline(timeline, start) });
    const targets = new Map(reset.tracks.map(track => [track.key, track]));
    for (const track of timeline.tracks) {
      const target = targets.get(track.key);
      for (const name of ['motion', 'phases', 'fades']) track[name].push(...target[name].map(segment => ({ ...segment, start: segment.start + start, end: segment.end + start })));
      track.changed ||= target.changed;
    }
    timeline.duration = Math.max(timeline.duration, start + reset.duration);
  }
  timeline.duration = Math.max(DEFAULT_STEP_MS, timeline.duration, timeline.camera.at(-1)?.end || 0);
  return { timeline, from: frameRooms[0], to: frameRooms.at(-1) };
}

export class RecordedReplayBuilder {
  constructor(world) {
    Object.assign(this, {world, pool: new TimelinePool(), clips: [], visits: [], gems: [], visited: new Set(), duration: 0, previousGems: 0});
  }
  append(move, {action, frames, cycle}, authoredRooms = this.world.rooms) {
    const {world, pool, clips, visits, gems, visited} = this;
    let {duration, startRoom, previousGems} = this;
    const { timeline, from, to } = recordedTimeline(world, action.action, frames, { cycle, authoredRooms });
    const cameraPose = frame => frame.camera && ({ ...frame.camera, top: Math.max(1, ...frame.objects.map(object => object.z + 1)) });
    const firstCamera = cameraPose(frames[0]), lastCamera = cameraPose(frames.at(-1));
    const agentCamera = firstCamera && lastCamera ? { from: firstCamera, to: lastCamera, duration: ROOM_TRANSITION_MS } : null;
    if (agentCamera && (firstCamera.yaw !== lastCamera.yaw || firstCamera.pitch !== lastCamera.pitch)) {
      timeline.duration = Math.max(timeline.duration, ROOM_TRANSITION_MS);
    }
    startRoom ||= from.fileName;
    const settledAt = timeline.times.at(-1) || timeline.duration;
    clips.push({ ...pool.pack(timeline), start: duration, duration: timeline.duration, settledAt, center: roomCenter(world, from),
      room: from.fileName, from: from.fileName, to: to.fileName, label: action.action, type: 'recorded', move, agentCamera,
      asciiFrames: timeline.ticks.map((tick, i) => ({at: timeline.times[i], room: frames[tick].room, camera: frames[tick].camera})).concat({at: timeline.duration, room: frames.at(-1).room, camera: frames.at(-1).camera}),
      gemsBefore: previousGems, gemsAfter: action.totalGems || 0 });
    // Follow the signed count so historical runs keep their original rule.
    const earnedVisit = Number.isInteger(action.roomsVisited) ? action.roomsVisited > visited.size : !action.died;
    if (earnedVisit && !visited.has(to.fileName)) {
      visited.add(to.fileName);
      visits.push({ room: to.fileName, at: duration + (move ? settledAt : 0) });
    }
    // Background gem identities use authored indices; foreground tracks always
    // come from recorded geometry, including gems removed by undo/reset rules.
    if ((action.totalGems || 0) > previousGems) {
      for (const track of timeline.tracks.filter(track => track.block.roleId === 'goal' && track.fades.some(fade => fade.to[0] === 0))) {
        const [x, y, z] = track.positions[0];
        const room = world.rooms.find(room => Math.floor(x / world.roomWidth) === room.columnIndex && Math.floor(y / world.roomHeight) === room.rowIndex);
        const index = room?.objects.findIndex(object => object.blockId === track.object.blockId && object.x === x % world.roomWidth && object.y === y % world.roomHeight && object.z === z);
        if (index >= 0 && !gems.some(gem => gem.id === `${room.fileName}:${index}`)) gems.push({ id: `${room.fileName}:${index}`, room: room.fileName,
          at: duration + track.fades.find(fade => fade.to[0] === 0).end, command: move });
      }
    }
    previousGems = action.totalGems || 0; duration += timeline.duration;
    Object.assign(this, {duration, startRoom, previousGems});
  }
  movie() {
    return {startRoom: this.startRoom, duration: this.duration, clips: this.clips.slice(), visits: this.visits.slice(), gems: [...this.gems].sort((a,b) => a.at-b.at),
      templates: this.pool.templates.slice(), layouts: this.pool.layouts.map(layout => Array.from(layout))};
  }
}

export async function compileRecordedReplay(world, count, readMove, authoredFor = () => world.rooms) {
  const builder = new RecordedReplayBuilder(world);
  for (let move = 0; move <= count; move++) {
    const record = await readMove(move); builder.append(move, record, authoredFor(record.action));
    if (move % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return builder.movie();
}
