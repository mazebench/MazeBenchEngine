import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runtimeHome, installationInfo } from '../benchmarking/deepseek/policy.mjs';

const root = path.resolve(import.meta.dirname, '..'), installation = installationInfo();
const report = path.join(runtimeHome(), 'boundary-report.json');
await rm(report, { force: true });
const child = spawn(process.execPath, ['--test', 'tests/benchmark-deepseek-wire.test.mjs', 'tests/benchmark-deepseek-openai-wire.test.mjs', 'tests/benchmark-deepseek-connected-wire.test.mjs', 'tests/benchmark-deepseek-chatgpt-auth.test.mjs'], { cwd: root, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', async code => {
  if (code !== 0) { process.exitCode = code || 1; return; }
  if (installationInfo().sha256 !== installation.sha256) throw new Error('Harness installation changed during validation.');
  await writeFile(report, JSON.stringify({ version: installation.version, sha256: installation.sha256, passed: true,
    routes: ['deepseek-official', 'deepseek-account', 'anthropic', 'openai'],
    protocols: ['anthropic-messages', 'openai-responses', 'openai-completions', 'google-generative-ai'], at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  console.log('DeepSeek Harness tool boundary and session resume verified.');
});
