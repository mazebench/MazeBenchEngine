import assert from 'node:assert/strict';
import test from 'node:test';
import { voxelColumns } from '../app/voxelColumns.mjs';

test('columns match the previous scene scan including stacked and overlapping objects', () => {
  const voxels = Array.from({ length: 2000 }, (_, i) => Object.freeze({
    x: (i * 17) % 23 - 1, y: (i * 7) % 19 - 1, z: i % 11 - 4, id: i,
  }));
  voxels.push(Object.freeze({ x: 0.5, y: 0, z: 1, id: 2000 }));
  const original = [...voxels];
  const indexed = voxelColumns(Object.freeze(voxels), 20, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 20; x++) {
      const expected = voxels.filter(v => v.x === x && v.y === y).sort((a, b) => a.z - b.z);
      assert.deepEqual(indexed[y * 20 + x], expected);
    }
  }
  assert.deepEqual(voxels, original);
});

test('empty columns are independent and coordinate reads scale with objects, not board area', () => {
  let coordinateReads = 0;
  const voxel = { get x() { coordinateReads++; return 1; }, get y() { coordinateReads++; return 2; }, z: -3 };
  const columns = voxelColumns([voxel], 256, 256);
  assert.equal(columns.length, 65536);
  assert.equal(columns[513][0], voxel);
  assert.ok(coordinateReads < 12, `${coordinateReads} coordinate reads`);
  assert.notEqual(columns[0], columns[1]);
  assert.deepEqual(voxelColumns([], 0, 0), []);
});
