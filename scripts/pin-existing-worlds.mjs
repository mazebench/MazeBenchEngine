import { readdir, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pinRunWorld } from '../benchmarking/world-pinning.mjs';

const root = await realpath(path.resolve(import.meta.dirname, '..'));
const results = [];
for (const folder of ['mazebench-benchmark', 'mazebench-prime-benchmark', 'mazebench-vision']) {
  const records = path.join(os.homedir(), 'records', folder);
  for (const entry of await readdir(records, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!entry.isDirectory() || !/^run-[\dTZ-]+-[a-f0-9]{6}$/.test(entry.name)) continue;
    const directory = path.join(records, entry.name);
    try { await access(path.join(directory, 'world-updates/head.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    results.push({ id: entry.name, ...await pinRunWorld(directory, root) });
  }
}
console.log(JSON.stringify(results, null, 2));
