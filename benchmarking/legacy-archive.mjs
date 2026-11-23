import { readFile, realpath, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { versionPresentation } from './run-version-label.mjs';

const ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[a-f0-9]{6}$/;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async file => { try { return await json(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
export function videoRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !size || (!match[1] && !match[2])) throw new Error('Invalid byte range.');
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || start >= size || end < start) throw new Error('Invalid byte range.');
  return { start, end, partial: true };
}

export function recordedFrame(action, index) {
  const s = action.status || action;
  return { index, action: action.turn ?? s.action_count ?? index, at: action.timestamp || null,
    command: action.command_text || s.action || '', room: s.current_room || null,
    gems: s.gem_count ?? null, rooms: s.visited_levels?.length ?? null,
    ascii: typeof s.level === 'string' ? s.level : null,
    observation: s.json_observation || s.observation || null, hash: s.board_state_hash || null };
}

export class LegacyArchive {
  constructor(root, options = {}) {
    this.root = root;
    this.recordsRoot = options.recordsRoot || process.env.MAZEBENCH_LEGACY_RECORDS_ROOT || path.join(os.homedir(), 'code/GitHub/MazeBenchEngine/outputs/maze-local/site');
    this.importsRoot = options.importsRoot || path.join(root, 'benchmarking/imports');
    this.evidenceFile = options.evidenceFile || path.join(root, 'outputs/version-audit/legacy-matches.json');
    this.indexes = new Map();
  }
  async file(id, name) {
    if (!ID.test(id) || !['run.json', 'initial-status.json', 'actions.jsonl', 'maze_replay.mp4', 'favorite.json'].includes(name)) throw new Error('Unknown archive record.');
    const root = await realpath(this.recordsRoot), directory = await realpath(path.join(root, id));
    if (directory !== path.join(root, id)) throw new Error('Archive symlinks are not accepted.');
    const file = await realpath(path.join(directory, name));
    if (path.dirname(file) !== directory) throw new Error('Archive file escapes the run.');
    return file;
  }
  async list() {
    const [index, evidence] = await Promise.all([json(path.join(this.importsRoot, 'index.json')), optional(this.evidenceFile)]);
    const matches = new Map((evidence?.runs || []).map(r => [r.id, r]));
    const runs = await Promise.all(index.runs.filter(r => ID.test(r.source?.run_id || '')).map(async r => {
      const id = r.source.run_id, version = matches.get(id);
      const favorite = await this.file(id, 'favorite.json').then(optional).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const metadata = await this.file(id, 'run.json').then(optional).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const presentation = versionPresentation(r.benchmark_version || { evidence: 'legacy-archive' });
      const assignment = presentation.assigned_version ? r.benchmark_version.assignment : null;
      return { id, import_id: r.id, model: r.model, provider: r.provider, harness: r.harness_label || r.harness,
        created_at: r.created_at, observation_mode: metadata?.mode === 'json' ? 'json' : r.observation_mode, tools_enabled: r.tools_enabled,
        effort: r.effort, action_count: r.action_count, gems_collected: r.gems_collected, rooms_visited: r.rooms_visited,
        favorite: Boolean(favorite && favorite.favorite !== false), heatmap_available: r.heatmap_available,
        recorded_video: Boolean(version?.recorded_video), version: presentation.label,
        version_evidence: { ...(version || { classification: 'unresolved', explanation: 'Historical release has not been assigned.' }),
          ...(assignment ? { assignment, assigned_version: presentation.label, explanation: presentation.detail } : {}) } };
    }));
    return { runs, read_only: true };
  }
  async run(id) {
    if (!ID.test(id)) throw new Error('Unknown archive record.');
    const run = (await this.list()).runs.find(r => r.id === id);
    if (!run) throw new Error('Archived run not found.');
    return run;
  }
  async frameIndex(id) {
    const file = await this.file(id, 'actions.jsonl').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!file) return { file: null, spans: [] };
    const info = await stat(file), key = `${id}:${info.size}:${info.mtimeMs}`;
    if (this.indexes.has(key)) return this.indexes.get(key);
    const pending = (async () => {
      const spans = []; let offset = 0, start = 0;
      for await (const chunk of createReadStream(file)) {
        let at = -1;
        while ((at = chunk.indexOf(10, at + 1)) !== -1) {
          const end = offset + at;
          if (end > start) spans.push([start, end - start]);
          start = end + 1;
        }
        offset += chunk.length;
      }
      if (start < offset) spans.push([start, offset - start]);
      return { file, spans };
    })();
    this.indexes.set(key, pending);
    if (this.indexes.size > 8) this.indexes.delete(this.indexes.keys().next().value);
    try { return await pending; } catch (error) { this.indexes.delete(key); throw error; }
  }
  async detail(id) {
    const run = await this.run(id);
    const [meta, initial, index] = await Promise.all([
      json(await this.file(id, 'run.json')),
      this.file(id, 'initial-status.json').then(json).catch(e => { if (e.code === 'ENOENT') return null; throw e; }),
      this.frameIndex(id)
    ]);
    const video = await this.file(id, 'maze_replay.mp4').then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; });
    return { ...run, recorded_status: meta.status, recorded_video: video, frame_count: index.spans.length + (initial ? 1 : 0),
      has_initial_frame: Boolean(initial), initial_frame: initial ? recordedFrame(initial, 0) : null };
  }
  async frames(id, from = 0, limit = 64) {
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error('Invalid frame range.');
    const initial = await this.file(id, 'initial-status.json').then(json).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    const { file, spans } = await this.frameIndex(id), shift = initial ? 1 : 0, frames = [];
    const total = spans.length + shift, end = Math.min(total, from + limit);
    if (initial && from === 0) frames.push(recordedFrame(initial, 0));
    if (file && end > shift) {
      const handle = await open(file, 'r');
      try {
        for (let i = Math.max(from, shift); i < end; i++) {
          const [offset, size] = spans[i - shift];
          if (size > 16 * 1024 * 1024) throw new Error('Recorded frame exceeds the supported size.');
          const bytes = Buffer.alloc(size); await handle.read(bytes, 0, size, offset);
          frames.push(recordedFrame(JSON.parse(bytes), i));
        }
      } finally { await handle.close(); }
    }
    return { frames, total, from };
  }
  async heatmap(id) {
    const run = await this.run(id);
    if (!/^import-[a-f0-9]+-[\dT-]+-[a-f0-9]{6}$/.test(run.import_id)) throw new Error('Invalid imported heatmap.');
    const report = await json(path.join(this.importsRoot, run.import_id + '.json'));
    return { heatmap: report.heatmap, action_count: report.action_count };
  }
}
