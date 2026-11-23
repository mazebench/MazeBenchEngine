import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { heapEnvironment, withoutHeapArguments, startReaderService } from '../benchmarking/server-resources.mjs';

test('increased server heap remains compatible with Worker execArgv', () => {
  const code = `const {Worker}=require('node:worker_threads');const v8=require('node:v8');
    new Worker('require("node:worker_threads").parentPort.postMessage("ready")',{eval:true,execArgv:process.execArgv})
      .on('message',message=>console.log(JSON.stringify({message,limit:v8.getHeapStatistics().heap_size_limit})));`;
  // The fixture must be a file: node -e puts the fixture code into execArgv.
  const result = spawnSync(process.execPath, ['-'], { input: code, encoding: 'utf8',
    env: heapEnvironment(8192, { ...process.env, NODE_OPTIONS: '--max_old_space_size=4096 --no-warnings' }) });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.message, 'ready'); assert(value.limit >= 8192 * 1024 ** 2);
  assert.deepEqual(withoutHeapArguments(['--max-old-space-size', '4096', '--no-warnings', '--max_old_space_size=2048']), ['--no-warnings']);
});

test('normal startup replaces a lower explicit heap flag with the configured server limit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maze-server-heap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, 'start.mjs');
  const helper = pathToFileURL(path.resolve(import.meta.dirname, '../benchmarking/server-resources.mjs')).href;
  await writeFile(entry, `import {ensureServerHeap} from ${JSON.stringify(helper)};import {getHeapStatistics} from 'node:v8';
    await ensureServerHeap();console.log(getHeapStatistics().heap_size_limit);`);
  const result = spawnSync(process.execPath, ['--max-old-space-size=2048', entry], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '', MAZEBENCH_HEAP_MB: '8192' },
  });
  assert.equal(result.status, 0, result.stderr); assert(Number(result.stdout.trim()) >= 8192 * 1024 ** 2);
});

test('a crashed read-only service restarts without terminating its owner', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maze-reader-isolation-'));
  await mkdir(path.join(root, 'benchmarking'));
  await writeFile(path.join(root, 'benchmarking', 'playback-server.mjs'), `import {createServer} from 'node:http';
    createServer((req,res)=>res.end(JSON.stringify({pid:process.pid}))).listen(Number(process.env.MAZEBENCH_PLAYBACK_PORT),'127.0.0.1');`);
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const reader = await startReaderService(root, 'playback', port);
  t.after(async () => { reader.close(); await rm(root, { recursive: true, force: true }); });
  const waitFor = async previous => {
    for (let i = 0; i < 100; i++) {
      try { const value = await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(100) })).json(); if (value.pid !== previous) return value.pid; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Reader did not become available.');
  };
  const first = await waitFor(null); assert.notEqual(first, process.pid);
  assert.equal(await startReaderService(root, 'playback', port), null, 'Existing reader remains untouched.');
  process.kill(first, 'SIGKILL');
  const second = await waitFor(first); assert.notEqual(second, first); assert.equal(second, reader.pid);
});
