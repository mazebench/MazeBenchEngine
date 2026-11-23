import test from 'node:test';
import assert from 'node:assert/strict';
import { assignLegacyVersions, assignedLegacyMetadata } from '../benchmarking/legacy-version-assignment.mjs';

const snapshot = (version, engine, world, at, commit) => ({ version, engine, world, evidence: [{ at, commit, subject: 'Engine change' }] });
const snapshots = [snapshot('old-0','engine-a','world-1','2026-07-01T00:00Z','a'),snapshot('old-1','engine-a','world-2','2026-07-02T00:00Z','b'),snapshot('old-2','engine-b','world-2','2026-07-03T00:00Z','c')];
test('numbers engines by first run date, groups world-only changes and ignores input order',()=>{
  const runs=[{id:'last',created_at:'2026-07-04T00:00Z'},{id:'middle',created_at:'2026-07-02T01:00Z'},{id:'first',created_at:'2026-07-01T01:00Z'}];
  const result=assignLegacyVersions(runs,snapshots);
  assert.deepEqual(result.runs.map(r=>[r.id,r.assigned_version]),[['first','v1.0.0'],['middle','v1.0.0'],['last','v1.0.1']]);
  assert.equal(result.releases.length,2);assert.deepEqual(result.releases[0].worlds,['world-1','world-2']);
  assert.deepEqual(assignLegacyVersions(runs.toReversed(),snapshots.toReversed()),result);
});
test('state-compatible history wins before date fallback, never using a future commit',()=>{
  const runs=[{id:'a',created_at:'2026-07-03T01:00Z'},{id:'b',created_at:'2026-07-02T01:00Z'}];
  const result=assignLegacyVersions(runs,snapshots,[{id:'a',recorded_state_candidates:['old-0']},{id:'b',recorded_state_candidates:['old-2']}]);
  assert.equal(result.runs[0].assignment.commit,'b');assert.equal(result.runs[1].assignment.commit,'a');
  assert.equal(result.runs[0].assignment.method,'git-date');assert.equal(result.runs[1].assignment.method,'recorded-state-and-git-date');
  assert.equal(result.releases.length,1);
  const metadata=assignedLegacyMetadata(result.runs[0]);assert.equal(metadata.exact_version,null);assert.equal(metadata.label,'v1.0.0');
});
test('timezone offsets use actual time and missing historical evidence cannot silently assign a release',()=>{
  const result=assignLegacyVersions([{id:'a',created_at:'2026-07-02T19:00:00-06:00'}],snapshots);
  assert.equal(result.runs[0].assignment.commit,'c');
  assert.throws(()=>assignLegacyVersions([{id:'a',created_at:'bad'}],snapshots),/Missing run date/);
  assert.throws(()=>assignLegacyVersions([],[]),/snapshots are required/);
});
