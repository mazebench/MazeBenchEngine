import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingFolderIds } from '../app/testSuite.mjs';

const folders = Object.freeze([
  { id: 'box', name: 'Box slopes' },
  { id: 'box-rigid', name: 'Rigid bodies', parentId: 'box' },
  { id: 'box-ice', name: 'Riders and Ice', parentId: 'box' },
  { id: 'clone', name: 'Clone slopes' },
  { id: 'clone-rigid', name: 'Rigid bodies', parentId: 'clone' },
].map(Object.freeze));
const visible = query => [...matchingFolderIds(folders, query)].sort();

test('folder search keeps matching children and their parent paths', () => {
  assert.deepEqual(visible('rigid'), ['box', 'box-rigid', 'clone', 'clone-rigid']);
  assert.deepEqual(visible('ice'), ['box', 'box-ice']);
});
test('matching a parent reveals its complete contents, case-insensitively', () => {
  assert.deepEqual(visible(' BOX '), ['box', 'box-ice', 'box-rigid']);
  assert.deepEqual(visible('slopes'), folders.map(folder => folder.id).sort());
});
test('clearing folder search restores all folders without mutating navigation data', () => {
  assert.deepEqual(visible('missing'), []);
  assert.deepEqual(visible(''), folders.map(folder => folder.id).sort());
  assert.equal(folders[1].parentId, 'box');
  assert.equal(folders[0].name, 'Box slopes');
});
test('folder search tolerates orphaned and cyclic imported paths', () => {
  const malformed = [
    { id: 'orphan', name: 'Ice', parentId: 'gone' },
    { id: 'a', name: 'Slopes', parentId: 'b' },
    { id: 'b', name: 'Bodies', parentId: 'a' },
  ];
  assert.deepEqual([...matchingFolderIds(malformed, 'ice')], ['orphan']);
  assert.deepEqual([...matchingFolderIds(malformed, 'slopes')].sort(), ['a', 'b']);
});
