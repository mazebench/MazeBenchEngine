import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './providers/claude-runner.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';

export const transientCodexError = error => /(?:last status:|status[=:]?)\s*(?:429|500|502|503|504)\b/i.test(String(error || ''));
export class CodexTransientRecovery {
  constructor({ ownerRoot, active, forRun, now = Date.now, delays = [15000, 30000, 60000, 120000, 300000] }) {
    Object.assign(this, { ownerRoot, active, forRun, now, delays });
    this.busy = false; this.closed = false;
  }
  start() { this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref(); void this.tick(); }
  close() { this.closed = true; clearInterval(this.timer); }
  async tick() {
    if (this.closed || this.busy) return;
    this.busy = true;
    try {
      for (const name of await readdir(this.ownerRoot).catch(() => [])) {
        if (!/^run-[\dTZ-]+-[a-f0-9]{6}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        if (this.active.has(id)) continue;
        try { await this.check(id); } catch (error) { console.error('Codex recovery:', id, error.message); }
      }
    } finally { this.busy = false; }
  }
  async check(id) {
    const owner = this.forRun(id), directory = owner.runDirectory(id), file = path.join(directory, 'run.json');
    const before = await readFile(file, 'utf8'), run = JSON.parse(before);
    if (run.status !== 'failed' || !transientCodexError(run.error) || !run.codex_thread_id) return;
    const summary = await readCheckpointJson(directory, 'summary.json');
    if (['won', 'action-limit'].includes(summary.game_status)) return;
    const prior = run.auto_recovery?.policy === 'codex-transient-service-v1' ? run.auto_recovery : {};
    if (prior.enabled === false) return;
    const attempts = summary.action_count > (prior.last_progress ?? -1) ? 0 : (prior.attempts || 0);
    const recent = (prior.recent_retries || []).filter(at => this.now() - at < 3600000);
    const state = { ...prior, managed: true, enabled: true, policy: 'codex-transient-service-v1',
      attempts, max_attempts: this.delays.length, total_retries: prior.total_retries || 0,
      last_progress: summary.action_count, recent_retries: recent };
    if (attempts >= this.delays.length || recent.length >= 8) {
      await atomicJson(file, { ...run, auto_recovery: { ...state, enabled: false, state: 'blocked', next_retry_at: null, reason: 'Provider retry limit reached; resume manually after service recovers.' } }); return;
    }
    if (!prior.next_retry_at) {
      await atomicJson(file, { ...run, auto_recovery: { ...state, state: 'waiting', reason: 'Provider temporarily unavailable; retrying the same run.', next_retry_at: new Date(this.now() + this.delays[attempts]).toISOString() } }); return;
    }
    if (this.now() < Date.parse(prior.next_retry_at)) return;
    const runtime = owner.base || owner;
    await runtime.verifyRunCapabilityBoundary(run, directory);
    if (this.closed || this.active.has(id) || await readFile(file, 'utf8') !== before) return;
    const at = new Date(this.now()).toISOString();
    const audit = { at, reason: 'codex-transient-service-v1', previous_status: run.status, previous_error: run.error,
      action_count: summary.action_count, codex_thread_id: run.codex_thread_id };
    // Only the lifecycle status changes. Normal resume rechecks the signed
    // runtime, model, speed, tool condition and checkpoint before execution.
    await atomicJson(file, { ...run, status: 'paused', paused_at: at,
      recoveries: [...(run.recoveries || []), audit], auto_recovery: { ...state, state: 'watching',
        reason: null, next_retry_at: null, attempts: attempts + 1, total_retries: state.total_retries + 1, recent_retries: [...recent, this.now()] } });
    try { await owner.resume(id); }
    catch (error) {
      const current = JSON.parse(await readFile(file, 'utf8'));
      await atomicJson(file, { ...current, auto_recovery: { ...current.auto_recovery, enabled: false, state: 'blocked', reason: error.message } });
    }
  }
}
