// Compatibility adapter for immutable supervisors whose resume methods accept
// paused/stopped but not orphaned-running or transient-failed lifecycle states.
// Only run.json lifecycle metadata changes; owner.resume still verifies all
// signed assets, settings, checkpoint and saved conversation before execution.
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseOwner } from './runtime-release-store.mjs';
import { atomicJson } from './providers/claude-runner.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { ACTIVE_STATES, runIdentity, finished } from './auto-resume-policy.mjs';
import { needsRejectedMcpRepair, recoverAntigravityRejectedCall } from './recover-antigravity-rejected-call.mjs';
import { needsClaudeUsageRecovery, recoverClaudeUsageReport } from './recover-claude-usage-report.mjs';
import { needsAntigravityStartupRecovery, recoverAntigravityStartup } from './recover-antigravity-startup.mjs';
const execute = promisify(execFile);
const processListing = async () => (await execute('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 * 1024 * 1024 })).stdout;
export function runDirectory(id) {
  if (!/^run-[\dTZ-]+-[a-f0-9]{6}$/.test(id)) throw new Error('Invalid run ID.');
  const owner = releaseOwner(id); if (owner) return owner.directory;
  return null;
}
export async function directoryFor(run, directory) {
  if (!directory) {
    directory = runDirectory(run.id);
    if (!directory) for (const folder of ['mazebench-benchmark', 'mazebench-vision']) {
      const candidate = path.join(os.homedir(), 'records', folder, run.id);
      if (await access(path.join(candidate, 'run.json')).then(() => true, () => false)) { directory = candidate; break; }
    }
  }
  if (!directory) throw new Error('Run record not found.');
  return directory;
}
export async function cancelLegacyRecovery(run, { get, directory }) {
  if (run.runner_active || run.auto_recovery?.policy !== 'codex-transient-service-v1') return;
  directory = await directoryFor(run, directory);
  const file = path.join(directory, 'run.json'), before = await readFile(file, 'utf8'), metadata = JSON.parse(before);
  if (metadata.auto_recovery?.policy !== 'codex-transient-service-v1') return;
  const current = await get(run.id);
  if (current.runner_active || await readFile(file, 'utf8') !== before) return;
  await atomicJson(file, { ...metadata, auto_recovery: { ...metadata.auto_recovery, enabled: false, state: 'paused', next_retry_at: null, reason: null } });
}
export async function prepareNormalResume(run, { get, allowed, directory, processes = processListing }) {
  if (needsAntigravityStartupRecovery(run)) {
    directory = await directoryFor(run, directory);
    try {
      return await recoverAntigravityStartup({ directory, root: releaseOwner(run.id)?.root || path.resolve(import.meta.dirname, '..'), apply: true,
        assertInactive: async metadata => {
          const current = await get(run.id);
          if (!allowed() || current.runner_active || current.status !== 'failed' || metadata.id !== run.id ||
              JSON.stringify(runIdentity(current)) !== JSON.stringify(runIdentity(run))) throw new Error('Run changed or is active; recovery cancelled.');
          if ((await processes()).split('\n').some(line => [metadata.id, metadata.antigravity_session_id].some(id => id && line.includes(id))))
            throw new Error('The original runner is still alive; waiting before resuming.');
        } });
    } catch (error) { throw new Error('Integrity recovery refused: ' + error.message, { cause: error }); }
  }
  if (needsClaudeUsageRecovery(run)) {
    directory = await directoryFor(run, directory);
    try {
      return await recoverClaudeUsageReport({ directory, root: releaseOwner(run.id)?.root || path.resolve(import.meta.dirname, '..'), apply: true,
        assertInactive: async metadata => {
          const current = await get(run.id);
          if (!allowed() || current.runner_active || current.status !== 'failed' || metadata.id !== run.id ||
              JSON.stringify(runIdentity(current)) !== JSON.stringify(runIdentity(run))) throw new Error('Run changed or is active; recovery cancelled.');
        } });
    } catch (error) { throw new Error('Integrity recovery refused: ' + error.message, { cause: error }); }
  }
  if (needsRejectedMcpRepair(run)) {
    directory = await directoryFor(run, directory);
    try {
      return await recoverAntigravityRejectedCall({ directory, root: releaseOwner(run.id)?.root || path.resolve(import.meta.dirname, '..'), apply: true,
        assertInactive: async metadata => {
          const current = await get(run.id);
          if (!allowed() || current.runner_active || current.status !== 'failed' || metadata.id !== run.id ||
              JSON.stringify(runIdentity(current)) !== JSON.stringify(runIdentity(run))) throw new Error('Run changed or is active; recovery cancelled.');
          const identifiers = [metadata.id, metadata.antigravity_session_id].filter(Boolean);
          if ((await processes()).split('\n').some(line => identifiers.some(value => line.includes(value)))) throw new Error('The original runner is still alive; waiting before resuming.');
        } });
    } catch (error) {
      // An unproven repair must not fall through to ordinary failed-run resume.
      throw new Error('Integrity recovery refused: ' + error.message, { cause: error });
    }
  }
  if (!['interrupted', ...ACTIVE_STATES].includes(run.status) && !((run.provider || 'codex') === 'codex' && run.observation_mode !== 'vision' && run.status === 'failed')) return false;
  directory = await directoryFor(run, directory);
  const file = path.join(directory, 'run.json'), before = await readFile(file, 'utf8'), metadata = JSON.parse(before);
  const orphan = ACTIVE_STATES.includes(metadata.status);
  const legacyCodex = (metadata.provider || 'codex') === 'codex' && metadata.observation_mode !== 'vision' && metadata.status === 'failed';
  if (!orphan && !legacyCodex) return false;
  // Do not let lifecycle normalization bypass the older supervisor's orphan
  // process guard. A surviving model/MCP child may still be writing history.
  if (orphan) {
    const identifiers = Object.entries(metadata).filter(([key, value]) => (key === 'id' || /(?:session|thread)_id$/.test(key)) && typeof value === 'string' && value.length > 0).map(([, value]) => value);
    const listing = await processes();
    if (listing.split('\n').some(line => identifiers.some(value => line.includes(value)))) throw new Error('The original runner is still alive; waiting before resuming.');
  }
  if (await access(path.join(directory, 'integrity-violation.json')).then(() => true, () => false)) throw new Error('Run has an integrity violation; automatic resume stopped.');
  const summary = await readCheckpointJson(directory, 'summary.json');
  if (finished({ ...metadata, ...summary })) throw new Error('Run has reached its terminal state.');
  const current = await get(run.id);
  if (!allowed() || current.runner_active || JSON.stringify(runIdentity(current)) !== JSON.stringify(runIdentity(run)) || current.status !== run.status) throw new Error('Run changed or is active; recovery cancelled.');
  if (await readFile(file, 'utf8') !== before || !allowed()) throw new Error('Run changed during recovery; retry later.');
  const at = new Date().toISOString();
  await atomicJson(file, { ...metadata, status: 'paused', paused_at: at, updated_at: at,
    recoveries: [...(metadata.recoveries || []), { at, reason: 'all-agents-normal-resume-v1', previous_status: metadata.status,
      previous_error: metadata.error, action_count: summary.action_count }] });
  return true;
}
