import { spawn } from 'node:child_process';
import { runtimeHome, VERSION } from '../benchmarking/deepseek/policy.mjs';

const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', runtimeHome(), '--save-exact', `@deepseek-ai/dsh@${VERSION}`], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', async code => {
  if (code !== 0) { process.exitCode = code || 1; return; }
  await import('./check-deepseek.mjs');
});
