import assert from 'node:assert/strict';
import test from 'node:test';
import { sortTestCases } from '../app/testSuite.mjs';
const cases = Object.freeze([
  Object.freeze({ id: 'test-10', name: 'Box 10', folderId: 'boxes', intermediate: [], hidden: true }),
  Object.freeze({ id: 'test-2', name: 'box 2', folderId: 'boxes', intermediate: [1, 2] }),
  Object.freeze({ id: 'test-1', name: 'Walk', folderId: 'movement', intermediate: [] }),
  Object.freeze({ id: 'test-3', name: 'Box 3', folderId: 'boxes', intermediate: [] }),
]);
const groups = new Map([['movement', 0], ['boxes', 1]]);
const ids = mode => sortTestCases(cases, mode, groups, { 'test-2': { pass: false }, 'test-1': { pass: true } }).map(t => t.id);
test('suite groups follow the curriculum and names use natural numeric sorting', () => {
  assert.deepEqual(ids('group'), ['test-1', 'test-2', 'test-3', 'test-10']);
  assert.deepEqual(ids('name'), ['test-2', 'test-3', 'test-10', 'test-1']);
});
test('suite IDs sort numerically and long timelines appear first', () => {
  assert.deepEqual(ids('id'), ['test-1', 'test-2', 'test-3', 'test-10']);
  assert.equal(ids('frames')[0], 'test-2');
});
test('attention sorting distinguishes failing, pending, passing, and hidden cases', () => {
  assert.deepEqual(ids('status'), ['test-2', 'test-3', 'test-1', 'test-10']);
});
test('switching sort orders never mutates the saved manual order', () => {
  ids('group'); ids('status');
  assert.deepEqual(ids('manual'), ['test-10', 'test-2', 'test-1', 'test-3']);
  assert.notEqual(sortTestCases(cases, 'manual'), cases);
});
test('equal titles use stable natural IDs, and orphaned groups sort last', () => {
  const tests = [{ id: 'c10', name: 'Same', folderId: 'missing' }, { id: 'c2', name: 'Same', folderId: 'missing' }, { id: 'c3', name: 'Zebra', folderId: 'boxes' }];
  assert.deepEqual(sortTestCases(tests, 'group', groups).map(t => t.id), ['c3', 'c2', 'c10']);
});
