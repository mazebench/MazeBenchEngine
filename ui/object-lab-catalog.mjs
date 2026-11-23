import { V2_WORLD_FORMAT, V2_COORDINATE_SYSTEM } from '../render/v1/voxel-world-v2.mjs';

export const DIRECTIONS = ['up', 'right', 'down', 'left'];
export const FACES = ['top', 'north', 'east', 'south', 'west'];
export const LABELS = { up: 'North', right: 'East', down: 'South', left: 'West',
  top: 'Floor', north: 'North', east: 'East', south: 'South', west: 'West', bottom: 'Ceiling' };
const vector = { up: [0, -1], north: [0, -1], right: [1, 0], east: [1, 0],
  down: [0, 1], south: [0, 1], left: [-1, 0], west: [-1, 0] };

const descriptions = {
  floor: 'The ordinary walking surface. Top and side faces use different characters.',
  'ice-floor': 'A slippery surface. Enter it to continue sliding until something stops or redirects you.',
  exit: 'An exit marker on a walking surface. Room crossings in the full world are handled at room boundaries.',
  wall: 'Fixed solid terrain. It blocks movement and can support objects and mounted mechanisms.',
  'ice-block': 'A solid ice cube. Its upper surface is slippery.',
  'ice-slope': 'A fixed icy ramp. Its direction changes the slope and the text symbols used for its faces.',
  'wall-slope': 'A dark icy ramp. It has its own directional symbols, distinct from the blue ice ramp.',
  'orange-slope': 'An orange icy ramp. Compare its directional symbols and raised or retracted appearance; see the benchmark behavior note below.',
  player: 'The character you control. A full occupant hides a button or other face fixture at the same position.',
  clone: 'Moves with your directional commands. Pieces with the same body ID belong to the same rigid body.',
  gem: 'A collectible. Walk onto it to collect it; it then disappears from the room.',
  gate: 'A gate that changes between a flat plate and a solid cube as the player approaches and leaves.',
  lift: 'A reversible lift. Entering it can raise or lower a rider. Side-mounted lifts move the rider outward or inward.',
  'orange-wall': 'Orange buttons in the same room retract this wall. Releasing the button lets it rise again.',
  'orange-button': 'Contact with its mounted face controls the room’s orange walls. It can be mounted on a floor, wall or ceiling.',
  puncher: 'A directional spring that launches an entering body away from its supporting face. Inspect all four directions and both states.',
  crate: 'A pushable box affected by gravity. Push it with the player to see it move in both views.',
  'floating-floor': 'A movable platform that can support an actor. Its thin shape has its own text symbols.',
  'weightless-box': 'A pushable body that does not fall like an ordinary box. Matching body IDs join its pieces.',
  'weightless-slope': 'A pushable, weightless icy ramp. Its text identity includes both its body ID and slope direction.',
  'clone-slope': 'A clone shaped as an icy ramp. It responds to directional commands and has separate symbols for each direction and body identity.',
};

export function objectCatalog(blocks) {
  // Exit is retired; its E/e glyphs remain reserved for historical data.
  return blocks.filter(block => block.id !== 'exit').map(block => {
    const slope = block.visual?.kind === 'slope';
    const orientations = slope || block.id === 'puncher' ? DIRECTIONS
      : block.id === 'lift' ? FACES
      : block.id === 'orange-button' ? [...FACES, 'bottom'] : [];
    const states = ['lift', 'gate'].includes(block.id) ? ['Lowered', 'Raised']
      : block.id === 'puncher' ? ['Resting', 'Sprung']
      : block.roleId === 'orange-wall' ? ['Raised', 'Retracted']
      : block.id === 'orange-button' ? ['Visible', 'Hidden'] : [];
    const group = slope ? 'Slopes' : ['lift', 'gate', 'puncher', 'orange-wall', 'orange-button'].includes(block.id)
      ? 'Mechanisms' : block.visual?.kind === 'model' && block.id !== 'gem' ? 'Scenery'
      : block.category === 'actor' ? 'Actors' : 'Terrain';
    return { ...block, group, orientations, states,
      numbered: ['clone', 'weightless-pushable'].includes(block.roleId),
      description: descriptions[block.id] || (block.visual?.kind === 'model'
        ? 'A solid scenery model. The text view represents its object family rather than reproducing every detail of the mesh.'
        : 'Inspect this object’s actual 3D and text rendering from each camera angle.') };
  });
}

const at = (blockId, x, y, z = 0, extra = {}) => ({ blockId, x, y, z, ...extra });

// Separate bodies, spaced apart so each ID can be inspected without occlusion.
// These fixtures exist only in memory; they never become authored world rooms.
export function makeGenericLabRoom(entry, { count = 20, orientation = entry.orientations[0] } = {}) {
  if (!entry.numbered) throw new Error(`${entry.id} does not use numbered bodies.`);
  if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('Choose 1–40 bodies.');
  const columns = Math.ceil(Math.sqrt(count)), width = columns * 2 + 1, height = Math.ceil(count / columns) * 2 + 1;
  const objects = Array.from({ length: width * height }, (_, index) => at('floor', index % width, Math.floor(index / width)));
  for (let id = 0; id < count; id++) objects.push(at(entry.id, (id % columns) * 2 + 1,
    Math.floor(id / columns) * 2 + 1, 0, { genericId: id, groupId: id, ...(orientation ? { orientation } : {}) }));
  return { width, height, position: ['Lab', 'Lab'], fileName: `lab-${entry.id}-bodies.json`, objects };
}

export function makeLabRoom(entry, { orientation = entry.orientations[0], state = 0, bodyId = 0, play = false } = {}) {
  const size = play ? 7 : 3, center = Math.floor(size / 2);
  const objects = Array.from({ length: size * size }, (_, index) => at('floor', index % size, Math.floor(index / size)));
  const subject = at(entry.id, center, center, 0, {
    ...(orientation ? { orientation } : {}),
    ...(entry.numbered ? { genericId: bodyId, groupId: bodyId } : {}),
    ...(['lift', 'gate', 'puncher'].includes(entry.id) ? { stateId: state } : {}),
    ...(entry.id === 'orange-button' && state === 1 ? {
      engineHidden: true, engineGenericId: [...FACES, 'bottom'].indexOf(orientation) * 2 + 1
    } : {}),
    ...(entry.roleId === 'orange-wall' ? state === 1
      ? { z: -1, mechanismDepth: 1, stateId: 0 }
      : { mechanismDepth: 0, stateId: 0 } : {})
  });
  // Face fixtures live in the free voxel just outside their support.
  if (['lift', 'orange-button', 'puncher'].includes(entry.id) && vector[orientation]) {
    const [dx, dy] = vector[orientation];
    objects.push(at('wall', center - dx, center - dy));
  }
  if (orientation === 'bottom') objects.push(at('wall', center, center, 1));
  if (['floor', 'ice-floor', 'exit'].includes(entry.id)) {
    objects.splice(objects.findIndex(o => o.x === center && o.y === center), 1);
  }
  objects.push(subject);
  if (play) {
    // Each room is independent. No authored room, run checkpoint or world is written.
    if (entry.id !== 'player') {
      let x = center, y = center + 1;
      if (['lift', 'orange-button', 'puncher'].includes(entry.id) && vector[orientation]) {
        const [dx, dy] = vector[orientation];
        x = center - dy; y = center + dx; // Approach across the mounted face.
        if (entry.id === 'lift' && state === 1) { x = center + dx; y = center + dy; }
      }
      const onRaisedLiftApproach = entry.id === 'lift' && orientation === 'top' && state === 1;
      if (onRaisedLiftApproach) objects.push(at('wall', x, y));
      objects.push(at('player', x, y, onRaisedLiftApproach ? 1 : 0));
    }
    if (entry.roleId === 'orange-wall') objects.push(at('orange-button', center, center + 2, 0, { orientation: 'top' }));
    if (entry.id === 'orange-button') objects.push(at('orange-wall', center + 2, center));
    if (entry.id !== 'gem') objects.push(at('gem', center, 0));
  }
  return { width: size, height: size, position: ['Lab', 'Lab'], fileName: `lab-${entry.id}.json`, objects };
}

export function labWorld(room, blocks) {
  return { storageFormat: V2_WORLD_FORMAT, coordinateSystem: V2_COORDINATE_SYSTEM,
    columns: ['Lab'], rows: ['Lab'], roomWidth: room.width, roomHeight: room.height,
    rooms: [{ ...room, columnIndex: 0, rowIndex: 0 }], blocks,
    blockDefinitions: new Map(blocks.map(block => [block.id, block])) };
}

export function labHint(entry, orientation) {
  if (entry.id === 'orange-slope') return 'Walk into the ramp to slide. The benchmark engine currently treats it as a fixed icy ramp.';
  if (entry.roleId === 'orange-wall') return 'Step backward onto the orange button, then step off to release it.';
  if (entry.id === 'orange-button' && orientation === 'bottom') return 'The button is on the underside of the overhead block. Walk underneath it.';
  if (entry.id === 'orange-button') return 'Walk onto the button and watch the orange wall. Step off to release it.';
  if (entry.id === 'puncher') return 'Step sideways onto the spring’s face to be launched along its direction.';
  if (entry.id === 'lift') return 'Walk onto the lift. Undo or reset to repeat the contact.';
  return 'Use the arrow keys or direction pad. Both views follow the same engine state.';
}
