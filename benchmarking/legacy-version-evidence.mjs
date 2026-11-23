// Observational compatibility is deliberately separate from source provenance.
// Even one surviving candidate does not rule out an unsaved working-tree edit.
export function classifyLegacyEvidence(initial, metadata, signatures, records = []) {
  const boardMatches = initial?.board_state_hash ? signatures.filter(s => s.hash && s.hash === initial.board_state_hash && s.room === initial.current_room) : [];
  const initialMatches = boardMatches.filter(s => metadata.gem_total == null || s.gem_total == null || metadata.gem_total === s.gem_total);
  const candidates = initialMatches.filter(s => records.every(r => s.room_hashes?.[r.room] === r.hash));
  const changingRooms = [...new Set(records.map(r => r.room))].filter(room => new Set(records.filter(r => r.room === room).map(r => r.hash)).size > 1);
  return {
    exact_version: null,
    classification: changingRooms.length ? 'multiple-recorded-states' : candidates.length ? 'recorded-state-compatible' : 'unresolved',
    initial_state_candidates: initialMatches.map(s => s.version), board_only_candidates: boardMatches.map(s => s.version),
    recorded_state_candidates: candidates.map(s => s.version), changing_rooms: changingRooms,
    explanation: changingRooms.length ? 'The same authored room has different recorded board hashes during this run. A single fixed version cannot explain all saved states; the run may span world/runtime edits.'
      : candidates.length ? 'These Git snapshots match the starting board, world gem total, and all comparable recorded room-command states. They are compatible candidates, not proof of the engine code or unobserved rooms.'
      : initialMatches.length ? 'The starting board and world totals match historical snapshots, but later recorded room states differ. No single catalogued snapshot explains this run.'
      : boardMatches.length ? 'The starting board matches historical code, but the recorded world gem total differs from those Git snapshots. The run may have used uncommitted world edits; an exact version is unresolved.'
      : 'No comparable initial board hash matched a catalogued Git snapshot. An exact engine/world version is not recoverable from this evidence.'
  };
}
