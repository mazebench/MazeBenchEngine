import { appendFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexVisionAutoRecovery } from './codex-vision-auto-recovery.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { recoverGeminiImageRead, missingObservationRead } from './recover-gemini-image-read.mjs';

// Retry the unmodified maze continuation through the provider's normal owner.
// Rejected image reads have a separate audited recovery; conversations, prompts
// and provider filter settings stay unchanged.
function geminiFilterError(error) {
  const message = String(error || '').trim();
  return /^This request was blocked by Gemini's filters\. They can occasionally trigger by mistake on safe coding, security, or biology-related queries\. Please try rephrasing your prompt\.(?: You can \[send feedback\].*)?$/.test(message);
}
export const geminiVisionRetryable = error => geminiFilterError(error) || Boolean(missingObservationRead(String(error || '').trim()));
const identity = run => Object.fromEntries(['id', 'provider', 'observation_mode', 'model', 'effort', 'tools_enabled', 'coding_mode', 'antigravity_session_id', 'effective_prompt_sha256'].map(key => [key, run[key]]));
export function geminiVisionEligible(run) {
  return run?.provider === 'antigravity' && run.observation_mode === 'vision' && run.world === 'main-world' &&
    run.tools_enabled === false && run.coding_mode === 'off' && Boolean(run.antigravity_session_id) &&
    run.capability_policy?.name === 'subscription-vision-coding-off-v1';
}
function geminiAsciiEligible(run) {
  if (run?.provider !== 'antigravity' || run.observation_mode !== 'ascii' || run.world !== 'main-world' || !run.antigravity_session_id) return false;
  const mode = run.coding_mode ?? (run.tools_enabled ? 'python' : 'off');
  const policy = run.capability_policy?.name;
  if (['antigravity-mcp-only-v1', 'antigravity-catalog-mcp-v2'].includes(policy)) {
    return mode === 'off' && run.tools_enabled === false || mode === 'python' && run.tools_enabled === true;
  }
  return ['antigravity-any-language-v2', 'antigravity-catalog-any-language-v3'].includes(policy) && mode === 'any' && run.tools_enabled === true;
}

class GeminiAutoRecovery extends CodexVisionAutoRecovery {
  constructor(root, options, mode, eligible, retryable) {
    super(root, { ...options,
      visionPort: options.providerVisionPort || 8086,
      stateRoot: options.stateRoot || path.join(os.homedir(), `.mazebench/gemini-${mode}-recovery`),
      delays: options.delays || [15000, 60000, 180000],
      policy: { name: `gemini-${mode}-normal-resume-v1`, eligible, identity, retryable,
        waitingReason: 'Recovering the interrupted Gemini turn from its last valid checkpoint; valid moves are preserved.',
        limitReason: 'Gemini repeatedly blocked the same maze continuation without progress. Needs attention.', hourlyLimit: 8 },
    });
    this.imageReadRepair = options.imageReadRepair || recoverGeminiImageRead;
  }
  async recoverAndResume(value, run) {
    if (this.closed || !value.enabled) return;
    const current = await this.request(value.id);
    // Reports trim display errors; the saved provider response can end in a newline.
    if (!this.policy.eligible(current) || current.runner_active || current.status !== 'failed' || String(current.error || '').trim() !== String(run.error || '').trim() ||
        JSON.stringify(identity(current)) !== JSON.stringify(value.identity)) throw new Error('Run changed or is active; retry cancelled.');
    const directory = this.directory(value.id);
    const invalidated = await access(path.join(directory, 'integrity-violation.json')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    });
    if (invalidated) {
      if (current.observation_mode !== 'vision' || !missingObservationRead(run.error)) throw new Error('This integrity violation is not a rejected observation read.');
      const assertInactive = async metadata => {
        if (this.closed || !value.enabled) throw new Error('Recovery cancelled by pause/stop.');
        const latest = await this.request(value.id);
        if (latest.runner_active || latest.status !== 'failed' || latest.error !== metadata.error ||
            JSON.stringify(identity(latest)) !== JSON.stringify(value.identity)) throw new Error('Run changed or is active; recovery cancelled.');
      };
      await this.imageReadRepair({ root: this.root, directory, assertInactive, apply: true });
    }
    const summary = await readCheckpointJson(directory, 'summary.json');
    if (['won', 'action-limit'].includes(summary.game_status)) throw new Error('Run is complete.');
    if (this.closed || !value.enabled) return;
    const audit = { at: new Date(this.now()).toISOString(), run_id: value.id, action: invalidated ? 'rejected-image-read-resume' : 'normal-resume',
      conversation_id: run.antigravity_session_id, action_count: summary.action_count, error: run.error, attempt: value.attempts };
    const record = entry => appendFile(path.join(this.stateRoot, 'retry-audit.jsonl'), JSON.stringify({ ...audit, ...entry }) + '\n', { mode: 0o600 });
    await record({ status: 'requested' });
    if (this.closed || !value.enabled) { await record({ status: 'cancelled' }); return; }
    // The original owner performs its full signed runtime/checkpoint validation
    // and exclusive resume lock before it can launch the same conversation.
    let resumed;
    try { resumed = await this.request(value.id, 'resume'); }
    catch (error) { await record({ status: 'rejected', reason: error.message }); throw error; }
    await record({ status: 'resumed' });
    if (value.enabled) { Object.assign(value, { state: 'watching', reason: null, next_retry_at: null }); await this.save(value); }
    return this.decorate(resumed);
  }
}

export class GeminiVisionAutoRecovery extends GeminiAutoRecovery {
  constructor(root, options = {}) {
    super(root, options, 'vision', geminiVisionEligible, geminiVisionRetryable);
  }
}

export class GeminiAsciiAutoRecovery extends GeminiAutoRecovery {
  constructor(root, options = {}) {
    const recordsRoot = options.recordsRoot || process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), 'records/mazebench-benchmark');
    super(root, { ...options, recordsRoot }, 'ascii', geminiAsciiEligible, geminiFilterError);
  }
}
