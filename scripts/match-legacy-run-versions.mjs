import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { classifyLegacyEvidence } from '../benchmarking/legacy-version-evidence.mjs';

// Saved observations narrow the possibilities, but cannot prove which code
// produced them (especially changes in rooms a run never visited).
const [catalogueFile, repository, output = 'outputs/version-audit/legacy-matches.json'] = process.argv.slice(2);
if (!catalogueFile || !repository) throw new Error('Usage: <catalogue.json> <legacy repository> [output.json]');
const catalogue = JSON.parse(await readFile(catalogueFile));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 64 * 1024 * 1024 });
const cache = path.resolve('.mazebench/legacy-version-research');
await mkdir(cache, { recursive: true });
const roomEvidence = new Map(), roomsToProbe = new Set();
for (const run of catalogue.legacy_runs) {
  const records = [], hash = createHash('sha256');
  let sourceHash = null;
  try {
    const input = createReadStream(path.join(path.dirname(run.source), 'actions.jsonl'));
    input.on('data', bytes => hash.update(bytes));
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.includes('goto_level')) continue;
      const row = JSON.parse(line), s = row.status;
      // Hash v3 deliberately excludes already-collected gems. Earlier hash
      // formats cannot compare a fresh room with the run's collection ledger.
      if (row.valid !== false && s?.action === 'goto_level' && s.board_state_hash && s.board_state_hash_version === 3) {
        roomsToProbe.add(s.current_room);
        records.push({ action: row.turn, at: row.timestamp, room: s.current_room, hash: s.board_state_hash });
      }
    }
    sourceHash = hash.digest('hex');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  roomEvidence.set(run.id, { records, source_sha256: sourceHash });
}
await writeFile(path.join(cache, 'room-entry-evidence.json'), JSON.stringify([...roomEvidence].map(([id, evidence]) => ({ id, ...evidence }))) + '\n');
const signatures = [];
for (const version of catalogue.versions.filter(v => v.generation === '1.0')) {
  const commit = version.evidence.find(e => e.commit)?.commit;
  if (!commit) continue;
  const folder = path.join(cache, commit), resultFile = path.join(folder, 'research-signature.json');
  let result;
  try { result = JSON.parse(await readFile(resultFile)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!result || result.error) {
    await mkdir(folder, { recursive: true });
    const files = git(['ls-tree', '-r', '--name-only', commit, '--', 'package.json', 'scripts', 'server', 'shared', 'public', 'games/maze', 'environments/mazebench']).toString().trim().split('\n')
      .filter(file => /\.(?:js|json|txt)$/.test(file));
    execFileSync('tar', ['-xf', '-', '-C', folder], { input: git(['archive', commit, '--', ...files]), maxBuffer: 64 * 1024 * 1024 });
    // No HTTP service or agent is launched. Each historical runtime is loaded
    // in its own process and only observes the original starting board.
    try {
      const raw = execFileSync(process.execPath, ['scripts/maze-bridge.js', '--hide-names', '--hide-names-seed', '1'], {
        cwd: folder, input: '{"command":"observe"}\n{"command":"close"}\n', timeout: 20000,
        maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: folder }
      }).toString();
      const observed = JSON.parse(raw.trim().split('\n')[0]);
      if (!observed.ok) throw new Error(observed.error || 'Observation unavailable');
      result = { hash: observed.board_state_hash || null, hash_version: observed.board_state_hash_version || 1,
        room: observed.current_room, ascii_sha256: digest(observed.level || '') };
    } catch (error) { result = { error: String(error.stderr || error.message).slice(0,1000) }; }
  }
  if (!result.error && result.gem_total == null) {
    const probe = `const {getGame,getLevelState}=require('./server/app');const game=getGame('maze');const levels=game.worldMap?.levels||game.levels;const total=levels.reduce((sum,l)=>sum+getLevelState(game,l).actors.filter(a=>a.type==='gem').length,0);process.stdout.write(JSON.stringify({gem_total:total,room_total:levels.length}));process.exit(0);`;
    try { Object.assign(result, JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: folder, timeout: 20000, maxBuffer: 1024*1024,
      stdio: ['pipe','pipe','pipe'], env: { PATH: process.env.PATH, HOME: folder } }).toString())); }
    catch { result.world_total_unavailable = true; }
  }
  if (result.hash_version === 3 && [...roomsToProbe].some(room => !result.room_hashes?.[room])) {
    // Expose the original module's internal session functions for research.
    // No gameplay code changes; the HxI control must equal the CLI observation.
    const probe = `const fs=require('fs'),path=require('path'),Module=require('module');const file=path.resolve('scripts/maze-bridge.js');const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(fs.readFileSync(file,'utf8')+'\\nmodule.exports={createSession,handleCommand,parseArgs};',file);const {createSession,handleCommand,parseArgs}=m.exports;const rooms=JSON.parse(fs.readFileSync(0,'utf8'));const out={};for(const room of rooms){const s=createSession(parseArgs(['--level',room,'--hide-names','--hide-names-seed','1']));out[room]=handleCommand(s,{command:'observe'}).board_state_hash;}process.stdout.write(JSON.stringify(out));process.exit(0);`;
    try {
      const hashes = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: folder,
        input: JSON.stringify([...new Set(['level_HxI', ...roomsToProbe])]), timeout: 60000, maxBuffer: 1024*1024,
        stdio: ['pipe','pipe','pipe'], env: { PATH: process.env.PATH, HOME: folder } }).toString());
      if (hashes.level_HxI !== result.hash) throw new Error('Instrumented control does not match the original CLI.');
      result.room_hashes = hashes;
    } catch (error) { result.room_probe_error = String(error.stderr || error.message).slice(0, 1000); }
  }
  await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n');
  signatures.push({ version: version.research_snapshot || version.version, commit, ...result });
  console.log(`${version.version}: ${result.hash?.slice(0,12) || 'no comparable hash'}`);
}
const runs = [];
for (const run of catalogue.legacy_runs) {
  const file = path.join(path.dirname(run.source), 'initial-status.json');
  let bytes;
  try { bytes = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const initial = bytes ? JSON.parse(bytes) : null;
  const meta = JSON.parse(await readFile(run.source));
  const rooms = roomEvidence.get(run.id);
  const matching = classifyLegacyEvidence(initial, meta, signatures, rooms.records);
  const hasVideo = await access(path.join(path.dirname(run.source), 'maze_replay.mp4')).then(() => true, () => false);
  runs.push({ id: run.id, ...matching,
    recorded_gem_total: meta.gem_total ?? null, initial_state_sha256: bytes ? digest(bytes) : null,
    room_entry_checks: rooms.records.length, actions_sha256: rooms.source_sha256,
    board_state_hash: initial?.board_state_hash || null, board_state_hash_version: initial?.board_state_hash_version || null,
    recorded_video: hasVideo });
}
const result = { schema_version: 1, generated_at: new Date().toISOString(), repository: path.resolve(repository),
  method: 'Comparison of initial board hashes, global gem totals, and every recorded v3 goto_level board hash against independent historical Git runtimes. These observations do not prove source-code identity; no date-only assignments.',
  counts: { runs: runs.length, exact: 0, initial_state_compatible: runs.filter(r => r.initial_state_candidates.length).length,
    no_initial_match: runs.filter(r => !r.initial_state_candidates.length).length, snapshots_probed: signatures.length,
    snapshot_errors: signatures.filter(s => s.error || s.room_probe_error).length, recorded_videos: runs.filter(r => r.recorded_video).length,
    recorded_state_compatible: runs.filter(r => r.recorded_state_candidates.length).length,
    unique_compatible_candidate: runs.filter(r => r.recorded_state_candidates.length === 1).length,
    changing_room_states: runs.filter(r => r.changing_rooms.length).length }, signatures, runs };
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(result.counts);
