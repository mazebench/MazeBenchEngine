// Read-only audit. Usage: node scripts/catalogue-run-versions.mjs <records-root>
// <output.json> [additional records roots] [--legacy-repo /path/to/MazeBenchEngine]
// [--register] writes ONLY the append-only, run-free version registry in this repo.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { RunLibrary } from '../benchmarking/run-library.mjs';
import { readLiveWorld, readWorldRevision } from '../benchmarking/storage/live-world.mjs';
import { snapshotIdentity, inventoryHash, sha256, registerVersions, engineFilesAt } from '../benchmarking/version-catalogue.mjs';
import { readVersionRegistry, updateVersionRegistry } from '../benchmarking/version-store.mjs';

const args = process.argv.slice(2), register = args.includes('--register');
let legacyRepo;
const position = args.indexOf('--legacy-repo');
if (position >= 0) { legacyRepo = args[position + 1]; args.splice(position, 2); }
if (args.includes('--register')) args.splice(args.indexOf('--register'), 1);
const [root, output, ...extraRoots] = args;
if (!root || !output) throw new Error('Usage: <records-root> <output.json> [additional roots] [--legacy-repo path] [--register]');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async file => { try { return await json(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
const entries = async folder => readdir(folder, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
const library = new RunLibrary(), runs = [], snapshots = new Map(), warnings = [], manifests = [], sources = [];
function addSnapshot(generation, identity, evidence) {
  const key = `${generation}:${identity.engine}:${identity.world}`;
  let row = snapshots.get(key);
  if (!row) { row = { generation, ...identity, first_seen: evidence.at || null, evidence: [] }; snapshots.set(key, row); }
  if (evidence.at && (!row.first_seen || evidence.at < row.first_seen)) row.first_seen = evidence.at;
  row.evidence.push(evidence);
  return key;
}
async function manifestAt(file, run, current = false) {
  const bytes = await readFile(file), manifest = JSON.parse(bytes), hash = sha256(bytes);
  if (!manifest.files || !manifest.configuration) return;
  const suffix = path.basename(file).includes('.before.') ? '.before' : '';
  const meta = await optional(path.join(path.dirname(file), `run${suffix}.json`));
  if (current ? hash !== run.metadata.integrity?.manifest_sha256 : hash !== meta?.integrity?.manifest_sha256 && !run.pinnedHashes.has(hash)) {
    warnings.push({ run: run.id, file, reason: 'Archive manifest is not linked to a recorded integrity hash; excluded.' }); return;
  }
  if (run.manifests.some(m => m.sha256 === hash)) return;
  const identity = snapshotIdentity(manifest.files, null, manifest.configuration);
  const at = current ? run.metadata.updated_at : meta?.updated_at || meta?.created_at;
  const evidence = { run: run.id, kind: current ? 'current-manifest' : 'archived-manifest', at, file, manifest_sha256: hash };
  const key = addSnapshot('1.1', identity, evidence);
  const item = { sha256: hash, snapshot: key, at, file, current,
    runtime_sha256: identity.inventory, configuration_runtime: Object.fromEntries(Object.entries(manifest.configuration).filter(([k,v]) => /runtime$/.test(k) && v && typeof v === 'object').map(([k,v]) => [k, inventoryHash(v)])) };
  run.manifests.push(item); manifests.push(item);
  if (current) { run.manifest = manifest; run.current_manifest = hash; run.pinned_snapshot = key; }
}
async function findManifests(folder, output = []) {
  for (const entry of await entries(folder)) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory() && !['prepared', 'workspace', 'agent-cwd', 'node_modules', 'vision-source', 'source', 'sandbox-state', 'world-updates', 'journal'].includes(entry.name)) await findManifests(file, output);
    else if (entry.isFile() && /^integrity(?:\.before)?\.json$/.test(entry.name)) output.push(file);
  }
  return output;
}
function recordedHashes(value, result = new Set()) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/manifest/.test(key) && typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)) result.add(item);
    else if (item && typeof item === 'object') recordedHashes(item, result);
  }
  return result;
}
for (const recordsRoot of [root, ...extraRoots]) {
  sources.push({ type: 'current-run-root', path: path.resolve(recordsRoot) });
  for (const entry of await entries(recordsRoot)) {
    if (!entry.isDirectory() || !/^run-[\w-]+$/.test(entry.name) || runs.some(r => r.id === entry.name)) continue;
    const directory = path.join(recordsRoot, entry.name), metadata = await json(path.join(directory, 'run.json'));
    const run = { id: metadata.id, directory, metadata, pinnedHashes: recordedHashes(metadata), manifests: [], world_revisions: [], transitions: [], issues: [] };
    runs.push(run);
    try {
      await manifestAt(path.join(directory, 'integrity.json'), run, true);
      if (!run.manifest) throw new Error('Current integrity manifest is not verified');
      const { summary } = await library.snapshot(directory); run.actions = summary.action_count;
      const events = [...(metadata.runtime_repairs || []), ...(metadata.operator_changes || [])];
      run.transitions = events.map(e => ({ at: e.at, action: e.action_count ?? null, kind: e.kind || e.policy || 'runtime-repair',
        reason: e.reason || null, files: e.files || e.plan?.files || {},
        manifest_hashes: [...recordedHashes(e)], backup: e.backup || null }));
      const archives = new Set(await findManifests(path.join(directory, 'repairs')));
      for (const file of await findManifests(path.resolve('.mazebench/recovered-manifests', run.id))) archives.add(file);
      for (const e of events) if (e.backup) for (const f of await findManifests(e.backup)) archives.add(f);
      for (const file of archives) await manifestAt(file, run);
      run.unresolved_manifest_hashes = [...run.pinnedHashes].filter(hash => !run.manifests.some(m => m.sha256 === hash));
      if (run.unresolved_manifest_hashes.length) warnings.push({ run: run.id,
        reason: 'Some recorded full-runtime manifest hashes have no linked archived file; retained as unresolved evidence.',
        manifest_sha256: run.unresolved_manifest_hashes });
      const config = run.manifest.configuration;
      if (config.world_updates === 'next-entry-v1') {
        const { base, head } = readLiveWorld(directory, config.world_base_sha256);
        const observed = new Map([['pinned:0', { revision: 0, files: run.manifest.files, kind: 'pinned-world-base', first_action: null, last_action: null }]]);
        // Only read action state when the run actually reports an edited world.
        // Hundreds of edits published AFTER an old run stopped are not run versions.
        if (Number.isSafeInteger(summary.world_revision) && summary.world_revision > 0) {
          const state = await readCheckpointJson(directory, 'game-state.json');
          for (const action of state.actions || []) if (Number.isSafeInteger(action.worldRevision)) {
            const files = engineFilesAt(run.manifest.files, events, action.at);
            const key = `${snapshotIdentity(files).engine}:${action.worldRevision}`;
            const old = observed.get(key);
            observed.set(key, { revision: action.worldRevision, files, kind: 'observed-world', first_action: old?.first_action ?? action.index, last_action: action.index,
              first_at: old?.first_at || action.at, last_at: action.at });
          }
        }
        if (Number.isSafeInteger(summary.world_revision)) observed.set('checkpoint', { revision: summary.world_revision, files: run.manifest.files, kind: 'checkpoint-world', first_action: null, last_action: summary.action_count });
        for (const { revision, files, ...usage } of observed.values()) {
          if (revision < 0 || revision > head.revision) throw new Error('Recorded world revision is beyond the signed head');
          const world = revision ? readWorldRevision(directory, revision) : base;
          const identity = snapshotIdentity(files, world.rooms);
          const key = addSnapshot('1.1', identity, { run: run.id, kind: usage.kind, at: world.at, revision,
            first_action: usage.first_action, last_action: usage.last_action });
          run.world_revisions.push({ revision, snapshot: key, ...usage });
          if (usage.kind === 'checkpoint-world' || usage.kind === 'pinned-world-base' && summary.world_revision == null) run.current_snapshot = key;
        }
        run.published_world_revisions = head.revision + 1;
        run.world_revision_at_checkpoint = summary.world_revision ?? null;
      }
      run.current_snapshot ||= run.pinned_snapshot;
      console.log(`Audited ${run.id}: ${run.manifests.length} recorded manifests, ${run.world_revisions.length} world snapshots`);
    } catch (error) { run.issues.push(error.message); warnings.push({ run: run.id, reason: error.message }); }
  }
}
// Older repositories did not pin engine/world files in run.json. Enumerate
// exact Git snapshots without pretending the nearest commit date proves use.
const legacyRuns = [];
if (legacyRepo) {
  legacyRepo = path.resolve(legacyRepo);
  sources.push({ type: 'legacy-repository', path: legacyRepo });
  const folder = path.join(legacyRepo, 'outputs/maze-local/site');
  for (const entry of await entries(folder)) if (entry.isDirectory()) {
    const file = path.join(folder, entry.name, 'run.json'), meta = await optional(file);
    if (!meta) continue;
    legacyRuns.push({ id: meta.id || entry.name, model: meta.model_name || meta.model, created_at: meta.created_at,
      source: file, metadata_sha256: sha256(await readFile(file)), harness: meta.harness || meta.model,
      harness_version: meta.harness_version || null, exact_version: null,
      evidence: 'No per-run engine/world fingerprint in saved metadata or session. Git snapshots are candidates, not proof of execution.' });
  }
  const git = args => execFileSync('git', ['-C', legacyRepo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const paths = ['public/maze-engine.js', 'public/author-play-data.js', 'public/play-core.js', 'public/play-gameplay.js', 'public/play-movement.js', 'public/play-rules.js', 'public/play-world-transitions.js', 'scripts/maze-bridge.js', 'scripts/maze-terminal.js', 'shared/board-state.js', 'shared/default-world-template.js', 'games/maze/levels', 'games/maze/world_map.json', 'games/maze/level_parsing.json', 'games/maze/world_parsing.json'];
  const dates = legacyRuns.map(r => r.created_at).filter(Boolean).sort(), first = dates[0], last = dates.at(-1);
  const history = git(['log', '--all', '--format=%H%x09%cI%x09%s', `--until=${last}`, '--', ...paths]).trim().split('\n').filter(Boolean);
  // Include all branches in the run era and one pre-era baseline on HEAD.
  const baseline = git(['log', '-1', '--format=%H', `--before=${first}`, 'HEAD', '--', ...paths]).trim();
  const selected = history.filter(line => Date.parse(line.split('\t')[1]) >= Date.parse(first) || line.startsWith(baseline + '\t'));
  const legacySnapshots = [];
  for (const line of selected) {
    const [commit, at, subject] = line.split('\t');
    const files = {};
    for (const line of git(['ls-tree', '-r', commit, '--', ...paths]).trim().split('\n')) {
      const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/);
      if (match && !/\.(png|jpe?g|webp|gif)$/.test(match[2])) files[match[2]] = match[1];
    }
    const engineFiles = Object.fromEntries(Object.entries(files).filter(([file]) => !file.startsWith('games/maze/')));
    const worldFiles = Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith('games/maze/')));
    if (!Object.keys(engineFiles).length || !Object.keys(worldFiles).length) continue;
    const identity = { engine: inventoryHash(engineFiles), world: inventoryHash(worldFiles), wasm: null,
      engine_files: engineFiles, world_files: worldFiles, file_hash_algorithm: 'git-blob-sha1' };
    const key = addSnapshot('1.0', identity, { kind: 'git-snapshot-candidate', at, commit, subject, repository: legacyRepo });
    legacySnapshots.push({ key, at, commit });
  }
  // Retain the raw date lead separately from the approved release assignment.
  for (const run of legacyRuns) {
    const candidates = legacySnapshots.filter(s => Date.parse(s.at) <= Date.parse(run.created_at)).sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
    run.date_hint = candidates[0] ? { snapshot: candidates[0].key, commit: candidates[0].commit, confidence: 'unverified-date-only' } : null;
  }
}
const registry = register ? updateVersionRegistry([...snapshots.values()]).versions : registerVersions(readVersionRegistry().versions, [...snapshots.values()]);
const names = new Map(registry.map(v => [`${v.generation}:${v.engine}:${v.world}`, v.version]));
const label = key => key ? `v${names.get(key)}` : null;
for (const row of snapshots.values()) row.version = label(`${row.generation}:${row.engine}:${row.world}`);
const projected = runs.map(({ metadata, pinnedHashes, manifest, ...run }) => ({ ...run,
  model: metadata.model, provider: metadata.provider || 'codex', observation_mode: metadata.observation_mode || 'ascii', created_at: metadata.created_at,
  current_version: label(run.current_snapshot), pinned_version: label(run.pinned_snapshot),
  manifests: run.manifests.map(m => ({ ...m, version: label(m.snapshot) })),
  world_revisions: run.world_revisions.map(r => ({ ...r, version: label(r.snapshot) })) }));
for (const run of legacyRuns) if (run.date_hint) run.date_hint.version = label(run.date_hint.snapshot);
const legacyResearch = await optional(path.join(path.dirname(path.resolve(output)), 'legacy-matches.json'));
const legacyMatches = new Map((legacyResearch?.runs || []).map(run => [run.id, run]));
const legacyAssignments = await optional(path.join(path.dirname(path.resolve(output)), 'legacy-assignments.json'));
const assignedRuns = new Map((legacyAssignments?.runs || []).map(run => [run.id, run]));
for (const run of legacyRuns) {
  const match = legacyMatches.get(run.id);
  if (match) run.matching = match;
  run.archive_url = `/benchmarking/ui/archive.html?id=${encodeURIComponent(run.id)}`;
  const assigned = assignedRuns.get(run.id);
  if (assigned) { run.assigned_version = assigned.assigned_version; run.assignment = assigned.assignment; }
}
// The former v1.0 candidate numbers were research IDs, not run releases.
// Give them a separate visible namespace now that chronological releases exist.
for (const row of snapshots.values()) if (row.generation === '1.0') {
  row.research_snapshot = row.version; row.version = row.version.replace(/^v1\.0\./, 'snapshot-');
}
const report = { schema_version: 3, generated_at: new Date().toISOString(), sources,
  definition: 'v1.0.N groups legacy runs by their assigned engine inventory, numbered by first run date. Saved-state evidence is preferred; Git chronology resolves ambiguity under the owner-approved policy. World snapshots remain in provenance. v1.1.N identifies pinned engine/adapter and world inventories from the current repository. Model, effort, speed and harness remain separate.',
  limitations: ['Legacy release assignments reconstruct the starting engine from historical Git snapshots and run dates; they do not claim old runs had signed manifests.', 'Historical manifests prove recorded snapshots, not uninterrupted use from run creation.', 'A live world revision identifies the published inventory observed at an action; individual rooms can retain older entry revisions.', 'Only discovered local runs, linked repair archives, and the supplied legacy repository are covered.'],
  counts: { current_runs: projected.length, legacy_runs: legacyRuns.length,
    current_versions: [...snapshots.values()].filter(s => s.generation === '1.1').length,
    legacy_candidate_versions: [...snapshots.values()].filter(s => s.generation === '1.0').length,
    current_engine_binaries: new Set(projected.flatMap(r => r.manifests.filter(m => m.current).map(m => snapshots.get(m.snapshot)?.wasm)).filter(Boolean)).size,
    recorded_engine_binaries: new Set([...snapshots.values()].map(s => s.wasm).filter(Boolean)).size,
    historical_manifests: manifests.filter(m => !m.current).length,
    unresolved_manifest_hashes: projected.reduce((n,r) => n + (r.unresolved_manifest_hashes?.length || 0), 0),
    legacy_assigned_runs: legacyRuns.filter(r => r.assigned_version).length,
    legacy_engine_versions: legacyAssignments?.releases.length || 0 },
  versions: [...snapshots.values()].sort((a,b) => a.version.localeCompare(b.version, undefined, { numeric: true })),
  legacy_releases: legacyAssignments?.releases || [], runs: projected, legacy_runs: legacyRuns, warnings };
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
// Old running HTTP owners intentionally omit numbered-world hashes. Their
// already-verified manifest hash can still resolve those exact inventories.
const manifestVersions = Object.fromEntries(projected.flatMap(r => r.manifests.filter(m => snapshots.get(m.snapshot)?.world_name && snapshots.get(m.snapshot).world_name !== 'main-world').map(m => [m.sha256, names.get(m.snapshot)])));
if (register) updateVersionRegistry([], { manifests: manifestVersions });
const escape = v => String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const table = (headers, rows) => `<table><thead><tr>${headers.map(h=>`<th>${escape(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const cell = v => `<td>${escape(v)}</td>`;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MazeBench version inventory</title><style>body{font:15px system-ui;background:#0c0e13;color:#dce1ec;max-width:1500px;margin:auto;padding:32px}h1{margin-bottom:8px}p{color:#9ca8ba;line-height:1.6}input{width:320px;max-width:90%;padding:12px;border:1px solid #394455;border-radius:12px;background:#171b24;color:inherit}table{width:100%;border-collapse:collapse;font-size:13px;margin:18px 0 32px}th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid #252b35}th{color:#8aabdd}code{font-size:12px;overflow-wrap:anywhere}summary{cursor:pointer;color:#98b8e8}details{margin:12px 0}small{color:#9ca8ba}.stats{display:flex;gap:24px;flex-wrap:wrap}.stats b{font-size:26px;display:block;color:white}td:first-child{white-space:nowrap;color:#a4c9ff}</style><h1>MazeBench versions</h1><p>Generated ${escape(report.generated_at)} · Engine release history and snapshot fingerprints</p><div class="stats">${Object.entries(report.counts).map(([k,v])=>`<div><b>${v}</b><small>${escape(k.replaceAll('_',' '))}</small></div>`).join('')}</div><p>${escape(report.definition)}</p><details open><summary>Evidence and limits</summary><ul>${report.limitations.map(v=>`<li>${escape(v)}</li>`).join('')}</ul><p>Legacy runs have concrete chronological release labels; each assignment retains its Git commit and date-based provenance.</p></details><input id="search" type="search" placeholder="Find a version, model, run, or hash" aria-label="Filter inventory"><h2>Legacy engine releases</h2>${table(['Release','First run','Last run','Runs','Engine fingerprint'],report.legacy_releases.map(v=>`<tr>${cell('v'+v.version)}${cell(v.first_run_at)}${cell(v.last_run_at)}${cell(v.run_count)}<td><code>${v.engine}</code></td></tr>`))}<h2>Pinned and historical research snapshots</h2>${table(['Version','Engine fingerprint','World fingerprint','Evidence'], report.versions.map(v=>`<tr>${cell(v.version)}<td><code>${v.engine}</code>${v.wasm?`<br><small>WASM ${v.wasm}</small>`:''}</td><td><code>${v.world}</code></td><td><details><summary>${v.evidence.length} records · ${escape(v.evidence[0]?.kind)}</summary>${v.evidence.map(e=>`<p>${escape(e.run||e.commit)}<br>${escape(e.at)} · ${escape(e.kind)}${e.revision!=null?` · world revision ${e.revision}`:''}${e.first_action!=null?` · moves ${e.first_action}–${e.last_action}`:''}${e.subject?`<br>${escape(e.subject)}`:''}</p>`).join('')}</details></td></tr>`))}<h2>Current repository runs</h2>${table(['Run / model','Current snapshot','Recorded history','World revisions'], projected.map(r=>`<tr><td>${escape(r.model)}<br><small>${escape(r.id)}</small></td>${cell(r.current_version||'Unverified')}${cell([...new Set(r.manifests.map(m=>m.version))].join(', '))}<td>${escape(r.world_revisions.map(w=>`${w.version} (r${w.revision})`).join(', ')||'Frozen')}${r.issues.length?`<br>${escape(r.issues.join('; '))}`:''}</td></tr>`))}<h2>Earlier repository runs</h2><p>All ${legacyRuns.length} runs are included. Open a run to view its original recording and provenance. Each run has an assigned release based on recorded state evidence and Git history, with run dates resolving ambiguity.</p>${table(['Run / model','Assigned release','Git history / provenance','Recorded harness'],legacyRuns.map(r=>`<tr><td><a href="${escape(r.archive_url)}" style="color:#a4c9ff">${escape(r.model)}</a><br><small>${escape(r.id)}</small></td>${cell(r.assigned_version||'Awaiting assignment')}<td><details><summary>${escape(r.assignment?.method||'Not assigned')}</summary><p>${escape(r.assignment?.notes?.join(' ')||r.evidence)}</p>${r.assignment?`<p>${r.assignment.github_url?`<a style="color:#a4c9ff" href="${escape(r.assignment.github_url)}">${escape(r.assignment.commit.slice(0,12))}</a>`:escape(r.assignment.commit.slice(0,12))+' (local Git)'} · ${escape(r.assignment.commit_at)}<br>${escape(r.assignment.commit_subject)}</p>`:''}</details></td>${cell([r.harness,r.harness_version].filter(Boolean).join(' '))}</tr>`))}<script>document.querySelector('#search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const row of document.querySelectorAll('tbody tr'))row.hidden=!row.textContent.toLowerCase().includes(q)})</script></html>`;
await writeFile(output.replace(/\.json$/, '') + '.html', html);
console.log(JSON.stringify({ output: path.resolve(output), ...report.counts, warnings: warnings.length }, null, 2));
