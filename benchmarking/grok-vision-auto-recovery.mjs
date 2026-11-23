import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexVisionAutoRecovery } from './codex-vision-auto-recovery.mjs';
import { GrokVisionResumeSupervisor, adoptGrokVisionResume, GROK_RESUME_POLICY, GROK_CATALOG_ERROR } from './grok-vision-resume.mjs';
import { readJsonLinesTail } from './storage/tail-jsonl.mjs';
import { resumeExclusively } from './storage/resume-lock.mjs';

export const grokVisionRetryable = error => ['error_during_execution', GROK_CATALOG_ERROR].includes(String(error || '').trim());
const identity = run => Object.fromEntries(['id', 'provider', 'world', 'observation_mode', 'model', 'effort', 'tools_enabled', 'coding_mode', 'effective_prompt_sha256'].map(key => [key, run[key]]));
export function grokRetryResult(event, session) {
  if (event?.type !== 'result' || event.subtype !== 'error_during_execution' || event.is_error !== true || event.session_id !== session || !event.errors?.length) return false;
  return event.errors.every(error => {
    try {
      if (typeof error !== 'string' || !error.startsWith('Internal error: ')) return false;
      const detail = JSON.parse(error.slice('Internal error: '.length));
      return [400, 408, 425, 429, 500, 502, 503, 504].includes(detail.http_status) &&
        /^API error \(status \d{3} [^)]+\): Request failed \(HTTP \d{3}\)\.$/.test(detail.message) &&
        detail.message.includes(`HTTP ${detail.http_status}`);
    } catch { return false; }
  });
}
export class GrokVisionAutoRecovery extends CodexVisionAutoRecovery {
  constructor(root, options = {}) {
    const owner = options.owner || new GrokVisionResumeSupervisor(root, options);
    super(root, { ...options, visionPort: options.providerVisionPort || 8086,
      stateRoot: options.stateRoot || path.join(os.homedir(), '.mazebench/grok-vision-recovery'), delays: options.delays || [15000, 60000, 180000],
      policy: { name: 'grok-vision-normal-resume-v1', identity, retryable: grokVisionRetryable,
        eligible: run => run?.provider === 'grok-build' && run.world === 'main-world' && run.observation_mode === 'vision' && run.tools_enabled === false && run.coding_mode === 'off' && Boolean(run.grok_session_id),
        waitingReason: 'Grok stopped with a provider execution error. Retrying its preserved conversation and checkpoint.',
        limitReason: 'Grok repeatedly failed without new moves. Needs attention.', hourlyLimit: 8 },
    });
    this.owner = owner; this.adopt = options.adopt || adoptGrokVisionResume;
    const originalRequest = this.request;
    if (!options.request) this.request = async (id, action) => {
      const metadata = JSON.parse(await readFile(path.join(this.directory(id), 'run.json'), 'utf8'));
      if (metadata.grok_resume_owner !== GROK_RESUME_POLICY) return originalRequest(id, action);
      if (!action) return owner.get(id, { details: false });
      return action === 'resume' ? resumeExclusively(owner, id) : owner[action](id);
    };
  }
  decorate(run) {
    // Compact overview/list reports omit extension metadata and the previous
    // owner calls these runs interrupted. Our live process is authoritative.
    return super.decorate(this.owner.active.has(run.id) ? { ...run, runner_active: true,
      status: run.status === 'interrupted' ? 'continuing' : run.status } : run);
  }
  async recoverAndResume(value, run) {
    if (this.closed || !value.enabled) return;
    const assertInactive = async metadata => {
      if (this.closed || !value.enabled) throw new Error('Retry cancelled by pause/stop.');
      const current = await this.request(value.id);
      assert(!current.runner_active && current.status === 'failed', 'Run changed or is active; retry cancelled.');
      assert.equal(current.grok_session_id, metadata.grok_session_id);
      assert.equal(String(current.error || '').trim(), String(metadata.error || '').trim());
      assert.deepEqual(identity(current), value.identity);
    };
    await assertInactive(run);
    const directory = this.directory(value.id);
    if (run.error.trim() !== GROK_CATALOG_ERROR) {
      const event = (await readJsonLinesTail(path.join(directory, 'grok-events.jsonl'), 1))[0];
      assert(grokRetryResult(event, run.grok_session_id), 'This Grok execution error requires review.');
    }
    await this.adopt({ root: this.root, directory, assertInactive });
    if (this.closed || !value.enabled) return;
    await appendFile(path.join(this.stateRoot, 'retry-audit.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), run_id: value.id,
      parent_session: run.grok_session_id, error: run.error, attempt: value.attempts, action: 'normal-resume' }) + '\n', { mode: 0o600 });
    if (this.closed || !value.enabled) return;
    const resumed = await this.request(value.id, 'resume');
    if (value.enabled) { Object.assign(value, { state: 'watching', reason: null, next_retry_at: null }); await this.save(value); }
    return this.decorate(resumed);
  }
  async close() {
    await super.close();
    for (const id of this.owner.active.keys()) await this.owner.pause(id);
    const deadline = Date.now() + 10000;
    while (this.owner.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    for (const control of this.owner.active.values()) control.child?.kill('SIGKILL');
  }
}
