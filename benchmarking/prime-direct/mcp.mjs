import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { safeReadFile } from '../v1/safe-files.mjs';
import { verifyIntegrity, TOOLS } from './policy.mjs';

const root = process.env.MAZEBENCH_PROJECT_ROOT, directory = process.env.MAZEBENCH_RUN_DIRECTORY;
if (!root || !directory) throw new Error('Missing benchmark paths.');
const metadata = () => JSON.parse(safeReadFile(directory, 'run.json'));
await verifyIntegrity(root, directory, metadata());
const child = spawn(process.execPath, [path.join(root, 'benchmarking/v1/mcp-server.mjs')], {
  env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory,
    MAZEBENCH_PYTHON_ENABLED: '0', MAZEBENCH_CAPABILITY_POLICY: 'os-isolated-v4' }, stdio: ['pipe', 'pipe', 'inherit']
});
let pending, queue = Promise.resolve();
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const response = JSON.parse(line);
    if (response.result?.tools && JSON.stringify(response.result.tools.map(t => t.name)) !== JSON.stringify(TOOLS))
      throw new Error('Unexpected game tool catalog.');
    reply(response);
    if (pending?.id === response.id) { pending.resolve(); pending = null; }
  } catch (error) { invalidate(error); }
});
const lines = readline.createInterface({ input: process.stdin });
function invalidate(error) {
  writeFileSync(path.join(directory, 'integrity-violation.json'), JSON.stringify({ error: error.message }), { mode: 0o600 });
  child.kill('SIGKILL'); pending?.resolve(); pending = null; lines.close(); process.stdin.destroy(); process.exitCode = 1;
}
lines.on('line', line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line);
    await verifyIntegrity(root, directory, metadata());
    const allowed = request.method === 'tools/call' ? TOOLS.includes(request.params?.name)
      : ['initialize', 'notifications/initialized', 'notifications/cancelled', 'ping', 'tools/list'].includes(request.method);
    if (!allowed) {
      if (request.id !== undefined) reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Only the three MazeBench game tools are available.' } });
      return;
    }
    const response = request.id === undefined ? Promise.resolve() : new Promise(resolve => { pending = { id: request.id, resolve }; });
    child.stdin.write(line + '\n'); await response;
  }).catch(invalidate);
});
lines.on('close', () => { void queue.finally(() => child.stdin.end()); });
child.on('exit', code => { pending?.resolve(); process.exit(process.exitCode || code || 0); });
child.on('error', () => process.exit(1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.exit(); });
