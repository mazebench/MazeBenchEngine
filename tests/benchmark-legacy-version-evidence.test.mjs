import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLegacyEvidence } from '../benchmarking/legacy-version-evidence.mjs';

const initial = { board_state_hash: 'initial', current_room: 'HxI' }, metadata = { gem_total: 90 };
const signatures = [
  { version: 'v1.0.1', hash: 'initial', room: 'HxI', gem_total: 90, room_hashes: { AxA: 'a' } },
  { version: 'v1.0.2', hash: 'initial', room: 'HxI', gem_total: 90, room_hashes: { AxA: 'b' } },
  { version: 'v1.0.3', hash: 'initial', room: 'HxI', gem_total: 91, room_hashes: { AxA: 'a' } }
];
test('room hashes and world totals narrow versions without converting compatibility into exact provenance', () => {
  const result = classifyLegacyEvidence(initial, metadata, signatures, [{ room: 'AxA', hash: 'a' }]);
  assert.deepEqual(result.initial_state_candidates, ['v1.0.1', 'v1.0.2']);
  assert.deepEqual(result.recorded_state_candidates, ['v1.0.1']);
  assert.equal(result.exact_version, null);
});
test('changing room hashes are disclosed instead of choosing a single version', () => {
  const result = classifyLegacyEvidence(initial, metadata, signatures, [{ room: 'AxA', hash: 'a' }, { room: 'AxA', hash: 'b' }]);
  assert.equal(result.classification, 'multiple-recorded-states');
  assert.deepEqual(result.changing_rooms, ['AxA']); assert.deepEqual(result.recorded_state_candidates, []);
});
test('missing evidence and contradictory observations stay unresolved', () => {
  assert.equal(classifyLegacyEvidence(null,metadata,signatures).classification, 'unresolved');
  assert.deepEqual(classifyLegacyEvidence(initial,metadata,signatures,[{room:'BxB',hash:'x'}]).recorded_state_candidates, []);
  assert.deepEqual(classifyLegacyEvidence(initial,{gem_total:100},signatures).initial_state_candidates, []);
});
