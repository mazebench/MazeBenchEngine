import { spawn } from 'node:child_process';
import { getHeapStatistics } from 'node:v8';
import { createConnection } from 'node:net';
import path from 'node:path';

export function heapEnvironment(megabytes, environment = process.env) {
  const options = (environment.NODE_OPTIONS || '').replace(/--max[-_]old[-_]space[-_]size(?:=|\s+)\d+/g, '').trim();
  return { ...environment, NODE_OPTIONS: `${options} --max-old-space-size=${megabytes}`.trim() };
}

export function withoutHeapArguments(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (/^--max[-_]old[-_]space[-_]size=/.test(args[i])) continue;
    if (/^--max[-_]old[-_]space[-_]size$/.test(args[i])) { i++; continue; }
    result.push(args[i]);
  }
  return result;
}

// NODE_OPTIONS is inherited safely by workers; passing V8 heap flags through
// Worker.execArgv instead makes worker construction fail.
export async function ensureServerHeap() {
  const megabytes = Number(process.env.MAZEBENCH_HEAP_MB || 8192);
  if (!Number.isSafeInteger(megabytes) || megabytes < 1024) throw new Error('Invalid MAZEBENCH_HEAP_MB.');
  if (getHeapStatistics().heap_size_limit >= megabytes * 1024 * 1024) return;
  const args = withoutHeapArguments(process.execArgv);
  const child = spawn(process.execPath, [...args, ...process.argv.slice(1)], { stdio: 'inherit', env: heapEnvironment(megabytes) });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', error => { console.error(error); process.exit(1); });
  await new Promise(resolve => child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }));
  process.exit(process.exitCode);
}

const occupied = port => new Promise(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  socket.setTimeout(1000, () => done(true));
});

// Read-only replay/report work has its own heap and may restart independently.
// A reader failure must never terminate the process that owns model sessions.
export async function startReaderService(root, kind, port) {
  if (await occupied(port)) return null;
  let child, timer, closed = false;
  const start = () => {
    const variable = kind === 'playback' ? 'MAZEBENCH_PLAYBACK_PORT' : 'MAZEBENCH_REPORT_PORT';
    child = spawn(process.execPath, [path.join(root, 'benchmarking', `${kind}-server.mjs`)], {
      cwd: root, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...heapEnvironment(4096), [variable]: String(port) },
    });
    child.on('error', error => console.error(`${kind} reader:`, error.message));
    child.once('exit', (code, signal) => {
      if (closed) return;
      console.error(`${kind} reader stopped (${signal || code}); restarting without interrupting runs.`);
      timer = setTimeout(() => void occupied(port).then(inUse => { if (!closed && !inUse) start(); }), 1000);
      timer.unref();
    });
  };
  start();
  return { get pid() { return child?.pid; }, close() { closed = true; clearTimeout(timer); child?.kill('SIGTERM'); } };
}
