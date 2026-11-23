// Independent geometry and expectations: no engine output is used as an oracle.
export function interlockedFixture({ remote = null, blocked = false, passenger = false, ids = [17, 39] } = {}) {
  const world = { width: 8, height: 10, floorLayer: 0 };
  const terrain = Array.from({ length: 80 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), z: 0, blockId: 'floor' }));
  for (let x = 1; x <= 3; ++x) for (let y = 2; y <= 4; ++y) terrain.push({ x, y, z: 1, blockId: 'wall' });
  terrain.push({ x: 5, y: 3, z: 1, blockId: 'wall' }, { x: 5, y: 4, z: 1, blockId: 'wall' });
  if (remote) terrain.push({ x: 7, y: 9, z: 1, blockId: 'ice-slope', orientation: remote });
  if (blocked) terrain.push({ x: 1, y: 1, z: 4, blockId: 'wall' });
  const dynamic = [];
  const box = (x, y, z, genericId) => ({ x, y, z, genericId, blockId: 'weightless-pushbox-1826' });
  // A horizontal bar passes through a rigid tunnel. Its far foot loses the
  // raised platform on the push, but the tunnel still supports the bar.
  for (let x = 1; x <= 3; ++x) for (let y = 2; y <= 4; ++y) for (let z = 2; z <= 4; ++z) {
    if (y !== 3 || z !== 3) dynamic.push(box(x, y, z, ids[0]));
  }
  for (let x = 1; x <= 5; ++x) dynamic.push(box(x, 3, 3, ids[1]));
  dynamic.push(box(5, 3, 2, ids[1]), { x: 5, y: 4, z: 2, blockId: 'player' });
  if (passenger) dynamic.push(box(2, 3, 5, 91));
  return { world, start: [...terrain, ...dynamic], expected: [...terrain, ...dynamic.map(v => ({ ...v, y: v.y - Number(!blocked) }))] };
}
