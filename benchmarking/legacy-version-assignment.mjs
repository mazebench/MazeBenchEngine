// User-approved historical reconstruction policy. These are concrete release
// assignments, not claims that old runs had cryptographically pinned manifests.
export const LEGACY_ASSIGNMENT_POLICY = 'git-run-chronology-v1';

export function assignLegacyVersions(runs, snapshots, matches = []) {
  const evidence = new Map(matches.map(row => [row.id, row]));
  const timeline = snapshots.flatMap(snapshot => snapshot.evidence.filter(e => e.commit && Number.isFinite(Date.parse(e.at)))
    .map(e => ({ snapshot, ...e, time: Date.parse(e.at) })))
    .sort((a,b) => b.time-a.time || a.commit.localeCompare(b.commit));
  if (!timeline.length) throw new Error('Historical Git snapshots are required.');
  const releases = [], byEngine = new Map(), assigned = [];
  const ordered = [...runs].sort((a,b) => Date.parse(a.created_at)-Date.parse(b.created_at) || a.id.localeCompare(b.id));
  for (const run of ordered) {
    const started = Date.parse(run.created_at);
    if (!Number.isFinite(started)) throw new Error(`Missing run date: ${run.id}`);
    const before = timeline.filter(snapshot => snapshot.time <= started);
    const compatible = evidence.get(run.id)?.recorded_state_candidates || [];
    // Prefer state-compatible snapshots that existed when the run started.
    // Where saved states cannot distinguish an engine, the run-date Git
    // timeline is the deciding evidence, as explicitly requested by the owner.
    const matched = before.find(row => compatible.includes(row.snapshot.version));
    const selected = matched || before[0] || timeline.at(-1);
    let release = byEngine.get(selected.snapshot.engine);
    if (!release) {
      release = { version: `1.0.${releases.length}`, engine: selected.snapshot.engine,
        first_run_at: run.created_at, last_run_at: run.created_at, run_count: 0, worlds: [], commits: [] };
      byEngine.set(release.engine, release); releases.push(release);
    }
    release.run_count++; release.last_run_at = run.created_at;
    if (!release.worlds.includes(selected.snapshot.world)) release.worlds.push(selected.snapshot.world);
    if (!release.commits.includes(selected.commit)) release.commits.push(selected.commit);
    const method = matched ? 'recorded-state-and-git-date' : before.length ? 'git-date' : 'earliest-git-baseline';
    const notes = [
      matched ? 'Selected the latest preceding Git snapshot compatible with the saved board-state evidence.'
        : before.length ? 'Selected the latest engine/world Git snapshot preceding the run start; run-date reconstruction was authorized by the owner.'
          : 'No preceding Git snapshot survives; assigned the earliest available baseline.',
      'Runs sharing the selected engine inventory share a release number, ordered by first recorded use. World-only changes remain in provenance.',
      evidence.get(run.id)?.changing_rooms?.length && 'Recorded room states changed during this run; this label identifies its reconstructed starting engine.'
    ].filter(Boolean);
    const assignment = { policy: LEGACY_ASSIGNMENT_POLICY, method, version: release.version,
      run_started_at: run.created_at, commit: selected.commit, commit_at: selected.at,
      commit_subject: selected.subject, github_url: `https://github.com/mazebench/MazeBenchEngine/commit/${selected.commit}`,
      engine: selected.snapshot.engine, world: selected.snapshot.world,
      research_snapshot: selected.snapshot.version.replace(/^v1\.0\./, 'snapshot-'), notes };
    assigned.push({ id: run.id, assigned_version: `v${release.version}`, assignment });
  }
  return { schema_version: 1, policy: LEGACY_ASSIGNMENT_POLICY,
    definition: 'v1.0.N numbers the engines assigned to saved runs by their first run date. State evidence is preferred; Git commit chronology resolves ambiguity. Different world inventories can share an engine release.',
    releases, runs: assigned };
}

export function assignedLegacyMetadata(row, original = {}) {
  const a = row.assignment;
  return { ...original, schema_version: 1, evidence: 'legacy-git-timeline', benchmark_release: '1.0',
    assigned_version: a.version, assignment: a, exact_version: null, classification: 'historical-reconstruction',
    engine: { ...original.engine, version: a.version, runtime_sha256: a.engine, provenance: 'git-reconstruction' },
    world: { ...original.world, version: '1.0', sha256: a.world, policy: 'legacy', provenance: 'git-reconstruction' },
    label: row.assigned_version, detail: `${row.assigned_version}\n${a.notes.join('\n')}\nGit commit: ${a.commit}\nRun started: ${a.run_started_at}` };
}
