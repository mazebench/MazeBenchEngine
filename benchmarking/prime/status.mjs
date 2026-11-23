import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { credentials, pythonPath, PROVIDER, VERSION } from './policy.mjs';

export function catalogModels(result) {
  return (Array.isArray(result?.data) ? result.data : []).flatMap(model =>
    typeof model.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model.id)
      ? [{ id: model.id, name: model.display_name || model.id, provider: PROVIDER,
        efforts: ['default'], default_effort: 'default', pricing: model.pricing }] : []);
}

export async function primeInstallationStatus(root, python = pythonPath()) {
  try {
    const { stdout } = await promisify(execFile)(python, [path.join(root, 'benchmarking/prime/agent_runner.py'), '--check'], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const installation = JSON.parse(stdout);
    const { key, team } = await credentials();
    const response = await fetch('https://api.pinference.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${key}`, ...(team ? { 'X-Prime-Team-ID': team } : {}) },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Prime model catalog returned HTTP ${response.status}. Check prime login.`);
    const models = catalogModels(await response.json());
    if (!models.length) throw new Error('Prime did not return any models.');
    return { available: true, tested: true, authenticated: true, launch_ready: true,
      version: VERSION, verifiers_version: installation.version, fingerprint: installation.fingerprint,
      models, error: null };
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'Install the Prime runtime using benchmarking/prime/README.md.' : error.message;
    return { available: false, tested: false, authenticated: false, launch_ready: false, models: [], error: message };
  }
}
