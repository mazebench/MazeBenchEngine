import { CurrentVersions } from './current-version.mjs';
import { createServer } from 'node:http';
import { access, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { trustedVisionRequest } from './vision/server.mjs';
import { PlaybackReplay } from './playback-replay.mjs';
import { ReportReader } from './report-reader.mjs';
import { gzipSync } from 'node:zlib';
import { PricingService } from './pricing-service.mjs';
import { RunLibrary } from './run-library.mjs';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { LegacyArchive, videoRange } from './legacy-archive.mjs';
import { releaseOwner, releaseRecordRoots } from './runtime-release-store.mjs';

export function createPlaybackServer(root, options = {}) {
  const port = options.port ?? 8085, mainPort = options.mainPort || 8080;
  const recordsRoot = options.recordsRoot || process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-vision');
  const recordsRoots = options.recordsRoots || [recordsRoot, process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(),'records/mazebench-benchmark'),path.join(os.homedir(),'records/mazebench-prime-benchmark')];
  const replays = options.replays || new PlaybackReplay(root);
  const releasedReplays = new Map();
  const reports = options.reports || new ReportReader();
  const pricing = options.pricing || new PricingService();
  const library = options.library || new RunLibrary();
  const archive = options.archive || new LegacyArchive(root);
  const versions = options.versions || new CurrentVersions(root);
  const autoVersions = options.watchVersions ?? (!options.replays && !options.reports && !options.library && !options.archive);
  const runnerActive = options.runnerActive || (async id => {
    // Only the owner knows whether a saved "running" record still has a process.
    // An overview read cannot resume a run, and avoids a recursive charts read.
    for (const ownerPort of [8092, 8090, mainPort]) {
      if (ownerPort === server.address()?.port) continue;
      try {
        const response = await fetch(`http://127.0.0.1:${ownerPort}/api/benchmark/v1/runs/${id}?view=overview`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { const run = await response.json(); if (run.id === id) return run.runner_active === true; }
      } catch { /* Try the older owner; never infer liveness from saved status. */ }
    }
    return false;
  });
  const server = createServer(async (req, res) => {
    const reply = (status, value, type = 'application/json') => {
      if (res.destroyed) return;
      let data = Buffer.from(JSON.stringify(value));
      if (data.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { data = gzipSync(data); res.setHeader('Content-Encoding', 'gzip'); }
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
    };
    if (!trustedVisionRequest(req, server.address()?.port || port, mainPort)) return reply(403, { error: 'Only trusted localhost requests are accepted.' });
    if (req.headers.origin) { res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); return reply(204, ''); }
    if (req.method !== 'GET') return reply(405, { error: 'Playback is read-only.' });
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (url.pathname === '/api/versions/current') {
      try { return reply(200, versions.read()); } catch (error) { return reply(503, { error: error.message }); }
    }
    if (url.pathname.startsWith('/api/benchmark/archive/')) {
      try {
        if (url.pathname === '/api/benchmark/archive/runs') return reply(200, await archive.list());
        const archived = /^\/api\/benchmark\/archive\/runs\/([\dT-]+-[a-f0-9]{6})(?:\/(frames|heatmap|video))?$/.exec(url.pathname);
        if (!archived) return reply(404, { error: 'Unknown archive path.' });
        const [, id, kind] = archived;
        if (kind === 'video') {
          const file = await archive.file(id, 'maze_replay.mp4'), { size } = await stat(file);
          if (!size) return reply(404, { error: 'Recorded video is empty.' });
          let range;
          try { range = videoRange(req.headers.range, size); }
          catch { res.setHeader('Content-Range', `bytes */${size}`); return reply(416, { error: 'Invalid video byte range.' }); }
          res.writeHead(range.partial ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': range.end - range.start + 1,
            'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
            ...(range.partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}) });
          const stream = createReadStream(file, { start: range.start, end: range.end });
          stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res); return;
        }
        return reply(200, kind === 'frames' ? await archive.frames(id, Number(url.searchParams.get('from') || 0), Number(url.searchParams.get('limit') || 64))
          : kind === 'heatmap' ? await archive.heatmap(id) : await archive.detail(id));
      } catch (error) { return reply(error.code === 'ENOENT' ? 404 : 400, { error: error.message }); }
    }
    if (url.pathname === '/api/benchmark/playback/status') return reply(200, { available: true, token_pricing: true });
    if (url.pathname === '/api/benchmark/playback/library') {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.flushHeaders();
      try {
        for await (const event of library.stream([...recordsRoots, ...releaseRecordRoots()], controller.signal)) {
          if (res.destroyed) return;
          if (autoVersions && event.run?.benchmark_version) event.run.benchmark_version = versions.registerRun(event.run.benchmark_version);
          res.write(JSON.stringify(event) + '\n');
          // Flush each real completion before the next synchronous verification.
          await yieldToIO();
        }
      } catch (error) { if (!res.destroyed) res.write(JSON.stringify({ type: 'error', error: error.message }) + '\n'); }
      if (!res.destroyed) res.end();
      return;
    }
    if (url.pathname === '/api/benchmark/v1/pricing') {
      try { return reply(200, await pricing.refresh(url.searchParams.get('force') === '1')); }
      catch (error) { return reply(503, { error: error.message }); }
    }
    // Read-only reports can be updated independently of processes owning agents.
    const match = /^\/api\/benchmark\/playback\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/(movie|chunk)$/.exec(url.pathname)
      || /^\/api\/benchmark\/v1\/runs\/(run-[\dTZ-]+-[a-f0-9]{6})\/(tokens|comparison|charts)$/.exec(url.pathname);
    if (!match) return reply(404, { error: 'Unknown playback path.' });
    try {
      let directory = path.join(recordsRoot, match[1]);
      if (!options.replays) {
        directory = null;
        for (const root of [...recordsRoots, ...releaseRecordRoots()]) { const candidate=path.join(root,match[1]);try{await access(path.join(candidate,'run.json'));directory=candidate;break;}catch(error){if(error.code!=='ENOENT')throw error;} }
        if (!directory) return reply(404,{error:'Run not found.'});
      }
      const owner = releaseOwner(match[1]);
      if (owner && !releasedReplays.has(owner.root)) releasedReplays.set(owner.root, new PlaybackReplay(owner.root));
      const player = owner ? releasedReplays.get(owner.root) : replays;
      return reply(200, match[2] === 'charts' ? await reports.read(directory, 'charts', await runnerActive(match[1]))
        : ['tokens', 'comparison'].includes(match[2]) ? await reports.read(directory, match[2])
        : match[2]==='chunk' ? await player.chunk(directory,Object.fromEntries(url.searchParams)) : await player.movie(directory));
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.on('close', () => { reports.close(); pricing.close(); versions.close(); });
  server.on('listening', () => { if (autoVersions) versions.start(); if (options.refreshPricing ?? (!options.replays && !options.reports)) pricing.start(); });
  return { server, replays, reports, pricing };
}
if (process.argv[1] === import.meta.filename) {
  const port = Number(process.env.MAZEBENCH_PLAYBACK_PORT || 8085);
  const { server, replays } = createPlaybackServer(path.resolve(import.meta.dirname, '..'), { port });
  server.listen(port, '127.0.0.1', () => console.log(`MazeBench tween replay ready on localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { server.close(); server.closeAllConnections(); await replays.close(); process.exit(); });
}
