// Local collision expectations for command-controlled actors sharing a lane.
export function cloneVacancyFixture({ obstacle = 'wall', remote = false } = {}) {
  const world = { width: 6, height: 6, floorLayer: 0 };
  const terrain = Array.from({ length: 36 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), z: 0, blockId: 'floor' }));
  if (remote) terrain.push({ x: 5, y: 5, z: 1, blockId: 'ice-slope', orientation: 'right' });
  const actors = [{ x: 2, y: 3, z: 1, blockId: 'player' }, { x: 2, y: 4, z: 1, blockId: 'clone', genericId: 7 }];
  if (obstacle === 'wall') terrain.push({ x: 2, y: 2, z: 1, blockId: 'wall' });
  if (obstacle === 'two-crates' || obstacle === 'two-floors') {
    const blockId = obstacle === 'two-crates' ? 'crate' : 'floating-floor';
    terrain.push({ x: 2, y: 2, z: 1, blockId }, { x: 2, y: 1, z: 1, blockId });
  }
  if (obstacle === 'ramp' || obstacle === 'ramp-ceiling') {
    terrain.push({ x: 2, y: 2, z: 1, blockId: 'ice-slope', orientation: 'up' }, { x: 2, y: 1, z: 1, blockId: 'wall' });
    if (obstacle === 'ramp-ceiling') terrain.push({ x: 2, y: 2, z: 2, blockId: 'wall' });
  }
  const start = [...terrain, ...actors];
  let expected = [start];
  if (obstacle === 'clear') expected = [[...terrain, ...actors.map(v => ({ ...v, y: v.y - 1 }))]];
  if (obstacle === 'ramp') expected = [2, 1].map(y => [...terrain, { ...actors[0], y, z: 2 }, { ...actors[1], y: 3 }]);
  return { world, start, expected };
}
