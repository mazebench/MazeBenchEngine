// Imports repair individual actions. Normal autosave restoration stays strict.
// Everything here runs against a temporary model until replay has finished.
export async function replaySolutionImport(model, saved, progress, {directions, rebaseLedger}) {
  const warnings = {count: 0, examples: []};
  const warn = message => {
    warnings.count++;
    if (warnings.examples.length < 5) warnings.examples.push(message);
  };
  const spawns = new Map();
  for (const spawn of Array.isArray(saved.spawnSetups) ? saved.spawnSetups : []) {
    if (spawn && typeof spawn.id === 'string') spawns.set(spawn.id, spawn);
  }
  const aliases = new Map(), positions = new Map(), checkedSpawns = new Set();
  const available = new Set([`start:${model.root.fileName}`]), collected = new Set();
  let idsReliable = true;
  const positionKey = (room, position) => JSON.stringify([room, position?.x, position?.y, position?.z]);
  const matches = (spot, expected) => spot &&
    positionKey(spot.room, model.position(spot.state)) === positionKey(expected.room, expected.position);
  const indexSpot = spot => {
    if (!spot || !['start', 'entrance'].includes(spot.kind)) return;
    const key = positionKey(spot.room, model.position(spot.state));
    if (!positions.has(key)) positions.set(key, new Set());
    positions.get(key).add(spot.id);
  };
  for (const spot of model.spots.values()) indexSpot(spot);
  const matchingSpawn = expected => [...(positions.get(positionKey(expected.room, expected.position)) || [])]
    .map(id => model.spots.get(id)).find(spot => available.has(spot.id));
  const resolveSource = segment => {
    const expected = spawns.get(segment.from);
    // Once actions change, generated numeric IDs can refer to different spots.
    // Use explicit endpoint mappings, or an actually reached reset entrance.
    const id = aliases.get(segment.from) ||
      (idsReliable || segment.from?.startsWith('start:') ? segment.from : null);
    let spot = model.spots.get(id);
    if (expected && !matches(spot, expected)) {
      spot = segment.start?.reset ? matchingSpawn(expected) : null;
    }
    if (!spot || !available.has(spot.id)) return null;
    if (segment.start?.reset && !['start', 'entrance'].includes(spot.kind)) return null;
    return spot;
  };
  const replay = async (segment, label, draft = false) => {
    if (!segment || typeof segment !== 'object' || !Array.isArray(segment.actions)) {
      warn(`${label}: invalid run removed.`); idsReliable = false; return;
    }
    if (segment.actions.length > 100000) throw new Error(`${label} exceeds the 100,000-move limit.`);
    const validStart = segment.start == null ||
      (typeof segment.start === 'object' && !Array.isArray(segment.start) &&
       (segment.start.reset === undefined || typeof segment.start.reset === 'boolean') &&
       (segment.start.collected === undefined || Array.isArray(segment.start.collected)));
    const spot = typeof segment.from === 'string' && validStart ? resolveSource(segment) : null;
    if (spot) {
      const start = segment.start ? {...segment.start} : null;
      if (start?.collected) start.collected = rebaseLedger ? [...collected]
        : start.collected.filter(id => collected.has(id));
      model.restoreSpot(spot.id, start);
    } else {
      warn(`${label}: invalid saved spawn skipped; continued from the last valid position.`);
      checkedSpawns.add(segment.from); idsReliable = false;
    }
    const retainedMoves = new Map();
    for (const [i, direction] of segment.actions.entries()) {
      if (!directions.includes(direction)) {
        warn(`${label}, move ${i + 1}: unknown action removed.`); idsReliable = false; continue;
      }
      const step = await model.step(model.current, direction);
      if (!step.changed) {
        warn(`${label}, move ${i + 1}: ${step.rejected || 'Blocked move removed.'}`);
        idsReliable = false; continue;
      }
      model.current = step; model.pending.push(direction); model.pendingSteps.push(step);
      retainedMoves.set(i + 1, model.pending.length);
    }
    if (draft) return;
    const route = model.commit(typeof segment.label === 'string' ? segment.label : 'Imported route');
    // New exports include explicit references; old files can still continue
    // from the current board when a deleted action makes a source ambiguous.
    if (typeof segment.to === 'string' && !segment.to.startsWith('start:')) aliases.set(segment.to, model.source);
    if (route) {
      for (const crossing of route.crossings) available.add(`start:${crossing.room}`);
      for (const gem of route.gems) collected.add(gem);
      for (const spawn of route.spawns) {available.add(spawn.id);indexSpot(model.spots.get(spawn.id));}
      const byMove = new Map(route.spawns.map(spawn => [spawn.move, spawn.id]));
      for (const spawn of Array.isArray(segment.spawns) ? segment.spawns : []) {
        const actual = spawn && byMove.get(retainedMoves.get(spawn.move));
        if (actual && typeof spawn.id === 'string' && !spawn.id.startsWith('start:')) aliases.set(spawn.id, actual);
      }
    }
    // A changed crossing may allocate fewer or different spot IDs even when
    // every direction still succeeds. Stop trusting numeric identity then.
    for (const spawn of route?.spawns || []) {
      const expected = spawns.get(spawn.id);
      if (expected && !matches(model.spots.get(spawn.id), expected)) idsReliable = false;
    }
  };
  for (const [i, route] of saved.routes.entries()) {
    await replay(route, `Run ${i + 1}`);
    progress(i + 1, saved.routes.length);
  }
  if (saved.draft !== undefined) await replay(saved.draft, 'Unfinished run', true);
  for (const spawn of spawns.values()) {
    if (!checkedSpawns.has(spawn.id) && !matchingSpawn(spawn)) {
      warn('An outdated saved spawn was removed.');
    }
  }
  return warnings;
}
