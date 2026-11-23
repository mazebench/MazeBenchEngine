import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestDigest, recoverPriorManifest } from '../benchmarking/manifest-recovery.mjs';

test('reconstructs exact bytes across main and provider inventories; rejects altered evidence', () => {
  const before = 'a'.repeat(64), after = 'b'.repeat(64), added = 'c'.repeat(64);
  const original = Buffer.from(JSON.stringify({ files: { a: before }, configuration: { vision_runtime: { a: before } } }) + '\n');
  const successor = Buffer.from(JSON.stringify({ files: { a: after, b: added }, configuration: { vision_runtime: { a: after } } }) + '\n');
  const plan = { files: { a: { before, after }, b: { before: null, after: added } } };
  assert.deepEqual(recoverPriorManifest(successor, plan, manifestDigest(original)), original);
  assert.throws(() => recoverPriorManifest(successor, plan, 'd'.repeat(64)), /does not match/);
  assert.throws(() => recoverPriorManifest(successor, { files: { a: { before, after: added } } }, manifestDigest(original)), /Unexpected/);
  assert.equal(JSON.parse(successor).files.a, after);
});
