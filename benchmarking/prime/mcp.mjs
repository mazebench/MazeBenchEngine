// Evaluator-only gate. No generic host execution, files, or Python tool may
// pass through to the remote Prime Agent, even if requested by name.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { safeReadFile } from '../v1/safe-files.mjs';
import { verifyIntegrity, allowedRequest, TOOLS } from './policy.mjs';

const root = process.env.MAZEBENCH_PROJECT_ROOT, directory = process.env.MAZEBENCH_RUN_DIRECTORY;
if (!root || !directory) throw new Error('Missing benchmark paths.');
const metadata = JSON.parse(safeReadFile(directory, 'run.json'));
await verifyIntegrity(root, directory, metadata);
const child = spawn(process.execPath, [path.join(root, 'benchmarking/v1/mcp-server.mjs')], {
  env: { PATH: '/usr/bin:/bin', MAZEBENCH_PROJECT_ROOT: root, MAZEBENCH_RUN_DIRECTORY: directory,
    MAZEBENCH_PYTHON_ENABLED: '1', MAZEBENCH_CAPABILITY_POLICY: 'os-isolated-v4' },
  stdio: ['pipe', 'pipe', 'inherit']
});
let pending, queue = Promise.resolve();
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const response = JSON.parse(line);
    if (response.result?.tools) response.result.tools = response.result.tools.filter(tool => TOOLS.includes(tool.name)).map(tool => ({
      ...tool, description: tool.description.replace('Direct-only tool. ', '').replace(' Never call or orchestrate it from a code executor.', '')
    }));
    reply(response);
    if (pending?.id === response.id) { pending.resolve(); pending = null; }
  } catch { child.kill('SIGKILL'); }
});
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  queue = queue.then(async () => {
    const request = JSON.parse(line);
    if (!allowedRequest(request)) {
      if (request.id !== undefined) reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Only the three MazeBench game tools are available.' } });
      return;
    }
    await verifyIntegrity(root, directory, metadata);
    const response = request.id === undefined ? Promise.resolve() : new Promise(resolve => { pending = { id: request.id, resolve }; });
    child.stdin.write(line + '\n');
    await response;
  }).catch(error => {
    writeFileSync(path.join(directory, 'integrity-violation.json'), JSON.stringify({ error: error.message, at: new Date().toISOString() }), { mode: 0o600 });
    child.kill('SIGKILL'); lines.close(); process.stdin.destroy(); process.exitCode = 1;
  });
});
lines.on('close', () => { void queue.finally(() => child.stdin.end()); });
child.on('exit', code => { pending?.resolve(); process.exit(code || 0); });
child.on('error', () => process.exit(1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.exit(); });
