import { mkdir, readdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './providers/claude-runner.mjs';
import { ACTIVE_STATES, finished, runIdentity, failurePolicy } from './auto-resume-policy.mjs';
import { needsRejectedMcpRepair } from './recover-antigravity-rejected-call.mjs';
import { needsClaudeUsageRecovery } from './recover-claude-usage-report.mjs';
import { needsAntigravityStartupRecovery } from './recover-antigravity-startup.mjs';
const ID = /^run-[\dTZ-]+-[a-f0-9]{6}$/;
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export class AutoResume {
  constructor({ stateRoot, list, get, command, prepare = async () => {}, cancel = async () => {}, now = Date.now, interval = 5000,
    delays = [15000, 30000, 60000, 120000, 300000, 900000, 1800000], orphanGrace = 30000, maxPerHour = 12 }) {
    Object.assign(this, { stateRoot, list, get, dispatch: command, prepare, cancel, now, interval, delays, orphanGrace, maxPerHour });
    this.records = new Map(); this.pending = new Map(); this.closed = false; this.ticking = false; this.ready = this.load();
  }
  async load() {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const policy = path.join(this.stateRoot, 'policy.json');
    try { this.enabledAt = (await json(policy)).enabled_at; }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.enabledAt = new Date(this.now()).toISOString(); await atomicJson(policy, { version: 1, enabled_at: this.enabledAt }); }
    for (const file of await readdir(this.stateRoot)) if (ID.test(file.slice(0, -5)) && file.endsWith('.json')) {
      const value = await json(path.join(this.stateRoot, file));
      if (value.version !== 1 || value.id + '.json' !== file) throw new Error('Invalid auto-resume state.');
      this.records.set(value.id, value);
    }
  }
  serial(id, work) {
    const task = (this.pending.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.pending.set(id, task); void task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id); }).catch(() => {}); return task;
  }
  async save(value, event) {
    await atomicJson(path.join(this.stateRoot, value.id + '.json'), value);
    if (event) await appendFile(path.join(this.stateRoot, 'events.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), id: value.id, event, ...this.status(value.id) }) + '\n', { mode: 0o600 });
  }
  status(id) {
    const v = this.records.get(id); if (!v) return null;
    return { managed: true, policy: 'all-agents-normal-resume-v1', enabled: v.enabled, state: v.state, attempts: v.attempts,
      max_attempts: v.failure_kind === 'unknown' ? 3 : null, total_retries: v.total_retries, reason: v.reason, next_retry_at: v.next_retry_at };
  }
  decorate(run) {
    const v = this.records.get(run.id); if (!v) return run;
    // Specialized audited repairs remain authoritative while they are working.
    const specialized = run.auto_recovery?.enabled && ['waiting', 'retrying'].includes(run.auto_recovery.state);
    const status = specialized && v.enabled && v.state === 'watching' ? run.auto_recovery : this.status(run.id);
    return { ...run, auto_recovery: status, ...(!v.enabled && v.state === 'paused' && !run.runner_active && !finished(run) ? { status: v.operator_status || 'paused' } : {}) };
  }
  async enroll(run, { explicit = false } = {}) {
    await this.ready; if (!ID.test(run.id)) throw new Error('Invalid run ID.');
    let v = this.records.get(run.id);
    if (v && !explicit) return v;
    v = { version: 1, id: run.id, identity: runIdentity(run), enabled: true, state: 'watching', attempts: 0,
      total_retries: v?.total_retries || 0, last_progress: run.action_count || 0, recent_retries: [], next_retry_at: null, reason: null };
    this.records.set(run.id, v); await this.save(v, explicit ? 'operator-resume' : 'enrolled'); return v;
  }
  async command(id, action, payload) {
    await this.ready;
    // Cancellation is synchronous before joining the per-run queue. A pause
    // racing an in-flight resume waits, then pauses that newly started runner.
    let v = this.records.get(id);
    if (['pause', 'stop', 'delete'].includes(action)) {
      v ||= await this.enroll(await this.get(id));
      Object.assign(v, { enabled: false, state: 'paused', operator_status: action === 'stop' ? 'stopped' : 'paused', next_retry_at: null, reason: null });
      await this.save(v, 'operator-' + action);
    }
    return this.serial(id, async () => {
      const before = await this.get(id);
      if (action === 'resume') {
        if (before.runner_active) throw new Error('This benchmark is already running.');
        v = await this.enroll(before, { explicit: true });
      }
      try {
        if (['pause', 'stop', 'delete'].includes(action)) await this.cancel(before);
        if (action === 'resume') {
          v.prepared = true; await this.save(v);
          await this.prepare(before, () => !this.closed && v.enabled);
          if (this.closed || !v.enabled) return this.decorate(await this.get(id));
        }
        const run = await this.dispatch(id, action, payload);
        if (action === 'delete') { v.state = 'deleted'; await this.save(v, 'deleted'); }
        if (action === 'resume' && v.enabled) {
          v.state = 'watching'; v.prepared = false;
          if (Number.isSafeInteger(run.action_count) && run.action_count < v.last_progress) v.last_progress = run.action_count;
          await this.save(v);
        }
        return this.decorate(run);
      } catch (error) {
        if (action === 'pause' && !before.runner_active && /Only an active benchmark can be paused/.test(error.message)) return this.decorate(before);
        if (action === 'resume' && v.enabled) await this.failedAttempt(v, error);
        throw error;
      }
    });
  }
  async block(v, reason) { Object.assign(v, { enabled: false, state: 'blocked', next_retry_at: null, reason }); await this.save(v, 'blocked'); }
  async wait(v, policy, reason) {
    v.failure_kind = policy.kind;
    const recent = (v.recent_retries || []).filter(at => this.now() - at < 3600000);
    const next = Math.max(this.now() + this.delays[Math.min(v.attempts, this.delays.length - 1)], policy.retryAt || 0,
      recent.length >= this.maxPerHour ? recent[0] + 3600000 : 0);
    Object.assign(v, { state: 'waiting', next_retry_at: new Date(next).toISOString(), reason }); await this.save(v, 'scheduled');
  }
  async failedAttempt(v, error) {
    const p = failurePolicy(error.message, this.now());
    if (p.kind === 'blocked' || p.kind === 'unknown' && v.attempts >= 3) return this.block(v, error.message);
    await this.wait(v, p, error.message);
  }
  async check(v) {
    if (this.closed || !v.enabled) return;
    const run = await this.get(v.id);
    if (JSON.stringify(runIdentity(run)) !== JSON.stringify(v.identity)) return this.block(v, 'Run identity changed; automatic resume stopped.');
    const progress = run.action_count > v.last_progress;
    if (progress) { v.attempts = 0; v.last_progress = run.action_count; await this.save(v); }
    if (finished(run)) { Object.assign(v, { enabled: false, state: 'completed', next_retry_at: null, reason: null }); return this.save(v, 'completed'); }
    if (['paused', 'pausing', 'stopped'].includes(run.status) && !v.prepared) {
      Object.assign(v, { enabled: false, state: 'paused', operator_status: run.status === 'stopped' ? 'stopped' : 'paused', next_retry_at: null, reason: null }); return this.save(v, 'owner-paused');
    }
    if (run.runner_active) {
      if (progress || v.state !== 'watching' || v.prepared || v.orphan_since) {
        Object.assign(v, { state: 'watching', next_retry_at: null, reason: null, prepared: false, orphan_since: null });
        await this.save(v);
      }
      return;
    }
    if (run.auto_recovery?.enabled && ['waiting', 'retrying'].includes(run.auto_recovery.state)) return;
    if (run.capability_boundary_verified === false && !needsRejectedMcpRepair(run) && !needsClaudeUsageRecovery(run) && !needsAntigravityStartupRecovery(run)) return this.block(v, 'Run capability/integrity validation failed; automatic resume stopped.');
    const orphan = ['interrupted', ...ACTIVE_STATES].includes(run.status);
    if (orphan) {
      if (!v.orphan_since) { v.orphan_since = this.now(); await this.save(v); }
      if (this.now() - v.orphan_since < this.orphanGrace) return;
    } else if (run.status !== 'failed' && !v.prepared) return;
    const failure = run.recovery_error || run.error;
    const policy = orphan || v.prepared && run.status === 'paused' ? { kind: 'transient' } : failurePolicy(failure, this.now());
    if (policy.kind === 'blocked') return this.block(v, failure);
    if (policy.kind === 'unknown' && v.attempts >= 3) return this.block(v, 'Repeated unrecognized failure without progress: ' + (run.error || 'No provider error was reported.'));
    if (!v.next_retry_at) return this.wait(v, policy, orphan ? 'The runner was interrupted; resuming its saved session.' : failure || 'The agent turn stopped unexpectedly.');
    if ((v.reason !== failure || v.failure_kind !== policy.kind) && policy.retryAt > Date.parse(v.next_retry_at) && policy.retryAt > this.now())
      return this.wait(v, policy, failure);
    if (this.now() < Date.parse(v.next_retry_at)) return;
    Object.assign(v, { state: 'retrying', attempts: v.attempts + 1, total_retries: v.total_retries + 1,
      recent_retries: [...(v.recent_retries || []).filter(at => this.now() - at < 3600000), this.now()] }); await this.save(v, 'retry');
    if (this.closed || !v.enabled) return;
    // Durable marker covers a crash between adapting legacy lifecycle status
    // and calling the original owner's normal, fully verified resume method.
    v.prepared = true; await this.save(v);
    await this.prepare(run, () => !this.closed && v.enabled);
    if (this.closed || !v.enabled) return;
    const resumed = await this.dispatch(v.id, 'resume');
    if (Number.isSafeInteger(resumed?.action_count) && resumed.action_count < v.last_progress) v.last_progress = resumed.action_count;
    if (v.enabled) { Object.assign(v, { state: 'watching', next_retry_at: null, reason: null, prepared: false, orphan_since: null }); await this.save(v, 'resumed'); }
  }
  async tick() {
    await this.ready; if (this.closed || this.ticking) return; this.ticking = true;
    try {
      for (const run of await this.list()) {
        if (this.records.has(run.id) || !ID.test(run.id)) continue;
        if (run.runner_active || ACTIVE_STATES.includes(run.status) || ['failed', 'interrupted'].includes(run.status) && run.created_at >= this.enabledAt) {
          await this.serial(run.id, async () => { if (!this.records.has(run.id)) await this.enroll(await this.get(run.id)); }).catch(error => console.error('Auto-resume enrollment:', run.id, error.message));
        }
      }
      // One provider's slow resume must not hold up every other agent.
      await Promise.allSettled([...this.records.values()].filter(v => v.enabled && !this.pending.has(v.id)).map(v => this.serial(v.id, async () => {
        try { await this.check(v); } catch (error) { if (v.enabled && !this.closed) await this.failedAttempt(v, error); }
      })));
    } catch (error) { console.error('Auto-resume scan:', error.message); }
    finally { this.ticking = false; }
  }
  start() { void this.ready.then(() => { if (this.closed) return; this.timer = setInterval(() => void this.tick(), this.interval); this.timer.unref(); void this.tick(); }).catch(error => console.error('Auto-resume:', error.message)); }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.pending.values()]); }
}
