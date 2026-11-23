import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicJson } from './providers/claude-runner.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { recoverCodexResourceProbe, resourceProbeFailure } from './recover-codex-resource-probe.mjs';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const eligible = run => run?.provider === 'codex' && run.observation_mode === 'vision' && Boolean(run.codex_thread_id);
const active = run => ['queued', 'running', 'continuing'].includes(run.status);
const identity = run => Object.fromEntries(['id', 'provider', 'observation_mode', 'model', 'effort', 'tools_enabled', 'codex_thread_id', 'effective_prompt_sha256'].map(key => [key, run[key]]));
const codexPolicy = {
  name: 'blocked-codex-resource-probe-v1', eligible, identity, retryable: resourceProbeFailure,
  waitingReason: 'Rolling back an unfinished resource-discovery call; valid moves are preserved.',
  limitReason: 'Repeated blocked calls without enough progress. Resume manually to try again.',
  hourlyLimit: 20,
};
export class CodexVisionAutoRecovery {
  constructor(root, options = {}) {
    this.root = root;
    this.policy = options.policy || codexPolicy;
    this.recordsRoot = options.recordsRoot || path.join(os.homedir(), 'records/mazebench-vision');
    this.stateRoot = options.stateRoot || path.join(os.homedir(), '.mazebench/vision-recovery');
    this.now = options.now || Date.now; this.interval = options.interval || 2000;
    this.delays = options.delays || [1000, 5000, 15000, 30000, 60000];
    this.repair = options.repair || recoverCodexResourceProbe;
    this.request = options.request || (async (id, action) => {
      const response = await fetch(`http://127.0.0.1:${options.visionPort || 8082}/api/benchmark/v1/runs/${encodeURIComponent(id)}${action && action !== 'delete' ? '/' + action : ''}`,
        { method: action === 'delete' ? 'DELETE' : action ? 'POST' : 'GET', signal: AbortSignal.timeout(20000) });
      const value = await response.json(); if (!response.ok) throw new Error(value.error || `Vision owner returned ${response.status}.`); return value;
    });
    this.records = new Map(); this.pending = new Map(); this.closed = false; this.ticking = false; this.ready = this.load();
  }
  directory(id) { if (!/^run-[\dTZ-]+-[a-f0-9]{6}$/.test(id)) throw new Error('Invalid run ID.'); return path.join(this.recordsRoot, id); }
  async load() {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    try { this.enabledAt = (await json(path.join(this.stateRoot, 'policy.json'))).enabled_at; }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.enabledAt = new Date(this.now()).toISOString(); await atomicJson(path.join(this.stateRoot, 'policy.json'), { version: 1, enabled_at: this.enabledAt }); }
    for (const name of await readdir(this.stateRoot)) if (/^run-[\dTZ-]+-[a-f0-9]{6}\.json$/.test(name)) {
      const record = await json(path.join(this.stateRoot, name));
      if (record.version === 1 && record.id + '.json' === name) this.records.set(record.id, record);
    }
  }
  async save(value) { await atomicJson(path.join(this.stateRoot, value.id + '.json'), value); }
  status(id) {
    const value = this.records.get(id); if (!value) return null;
    return { managed: true, policy: this.policy.name, enabled: value.enabled, state: value.state,
      attempts: value.attempts, max_attempts: this.delays.length, total_retries: value.total_retries, reason: value.reason, next_retry_at: value.next_retry_at };
  }
  decorate(run) {
    const value = this.records.get(run.id); if (!value) return run;
    const status = this.status(run.id);
    if (value.enabled && value.state === 'watching' && run.status === 'failed' && !run.runner_active && this.policy.retryable(run.error)) {
      Object.assign(status, { state: 'waiting', reason: this.policy.waitingReason });
    }
    return { ...run, auto_recovery: status,
      ...(value.state === 'paused' && !run.runner_active && run.status === 'failed' ? { status: value.operator_status || 'paused' } : {}) };
  }
  serial(id, work) {
    const previous = this.pending.get(id) || Promise.resolve(), task = previous.catch(() => {}).then(work);
    this.pending.set(id, task);
    void task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id); }).catch(() => {}); return task;
  }
  async enroll(run) {
    await this.ready; if (!this.policy.eligible(run) || this.records.has(run.id)) return;
    const summary = await readCheckpointJson(this.directory(run.id), 'summary.json');
    const value = { version: 1, id: run.id, identity: this.policy.identity(run), enabled: true, state: 'watching', attempts: 0, total_retries: 0,
      last_progress: summary.action_count, recent_retries: [], next_retry_at: null, reason: null };
    this.records.set(run.id, value); await this.save(value);
  }
  async discover() {
    const entries = await readdir(this.recordsRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[\dTZ-]+-[a-f0-9]{6}$/.test(entry.name) || this.records.has(entry.name)) continue;
      try {
        const run = await json(path.join(this.directory(entry.name), 'run.json'));
        if (this.policy.eligible(run) && (active(run) || (run.status === 'failed' && run.created_at >= this.enabledAt && this.policy.retryable(run.error)))) await this.enroll(run);
      } catch (error) { if (error.code !== 'ENOENT') console.error('Vision recovery discovery:', entry.name, error.message); }
    }
  }
  start() { void this.ready.then(() => { if (this.closed) return; this.timer = setInterval(() => void this.tick(), this.interval); this.timer.unref(); void this.tick(); }).catch(error => console.error('Vision recovery:', error.message)); }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.pending.values()]); }
  async block(value, reason) { Object.assign(value, { enabled: false, state: 'blocked', next_retry_at: null, reason }); await this.save(value); }
  async tick() {
    await this.ready; if (this.closed || this.ticking) return; this.ticking = true;
    try {
      await this.discover();
      for (const value of this.records.values()) if (value.enabled && !this.pending.has(value.id)) {
        await this.serial(value.id, async () => { try { await this.check(value); } catch (error) { if (value.enabled && !this.closed) await this.block(value, error.message); } });
      }
    } catch (error) { console.error('Vision recovery check:', error.message); }
    finally { this.ticking = false; }
  }
  async check(value) {
    if (this.closed || !value.enabled) return;
    const run = await json(path.join(this.directory(value.id), 'run.json'));
    if (JSON.stringify(this.policy.identity(run)) !== JSON.stringify(value.identity)) throw new Error('Run identity changed; recovery stopped.');
    if (['paused', 'pausing', 'stopped', 'completed'].includes(run.status)) {
      Object.assign(value, { enabled: false, state: run.status === 'completed' ? 'completed' : 'paused', next_retry_at: null, reason: null }); return this.save(value);
    }
    if (active(run)) return;
    if (run.status !== 'failed' || !this.policy.retryable(run.error)) return this.block(value, run.error || 'This failure requires review.');
    const summary = await readCheckpointJson(this.directory(run.id), 'summary.json');
    if (summary.action_count > value.last_progress) { value.attempts = 0; value.last_progress = summary.action_count; }
    value.recent_retries = value.recent_retries.filter(at => this.now() - at < 3600000);
    if (value.attempts >= this.delays.length || value.recent_retries.length >= this.policy.hourlyLimit) return this.block(value, this.policy.limitReason);
    if (!value.next_retry_at) {
      Object.assign(value, { state: 'waiting', reason: this.policy.waitingReason, next_retry_at: new Date(this.now() + this.delays[value.attempts]).toISOString() });
      return this.save(value);
    }
    if (this.now() < Date.parse(value.next_retry_at)) return;
    Object.assign(value, { state: 'retrying', next_retry_at: null, attempts: value.attempts + 1, total_retries: value.total_retries + 1 }); value.recent_retries.push(this.now()); await this.save(value);
    await this.recoverAndResume(value, run);
  }
  async recoverAndResume(value, run) {
    const assertInactive = async metadata => {
      if (this.closed || !value.enabled) throw new Error('Recovery cancelled by pause/stop.');
      const current = await this.request(value.id);
      if (current.runner_active || current.status !== 'failed' || current.codex_thread_id !== metadata.codex_thread_id || current.error !== metadata.error) throw new Error('Run changed or is active; recovery cancelled.');
    };
    await assertInactive(run);
    await this.repair({ root: this.root, directory: this.directory(value.id), assertInactive, apply: true });
    if (this.closed || !value.enabled) return;
    const resumed = await this.request(value.id, 'resume');
    if (value.enabled) { Object.assign(value, { state: 'watching', reason: null, next_retry_at: null }); await this.save(value); }
    return this.decorate(resumed);
  }
  async command(id, action) {
    await this.ready;
    let value = this.records.get(id);
    if (value && ['pause', 'stop', 'delete'].includes(action)) { value.enabled = false; value.state = 'paused'; value.operator_status = action === 'stop' ? 'stopped' : 'paused'; value.next_retry_at = null; }
    return this.serial(id, async () => {
      const run = await this.request(id);
      if (!this.policy.eligible(run)) return this.request(id, action);
      if (!value) { await this.enroll(run); value = this.records.get(id); }
      if (['pause', 'stop', 'delete'].includes(action)) {
        Object.assign(value, { enabled: false, state: 'paused', operator_status: action === 'stop' ? 'stopped' : 'paused', next_retry_at: null, reason: null }); await this.save(value);
        const result = !run.runner_active && run.status === 'failed' && action !== 'delete' ? run : await this.request(id, action);
        if (action === 'delete') { this.records.delete(id); await rm(path.join(this.stateRoot, id + '.json'), { force: true }); }
        return this.decorate(result);
      }
      if (run.runner_active) throw new Error('This run is already active.');
      Object.assign(value, { enabled: true, state: 'retrying', attempts: 0, next_retry_at: null, reason: null }); await this.save(value);
      try {
        if (run.status === 'failed' && this.policy.retryable(run.error)) return await this.recoverAndResume(value, run);
        const result = await this.request(id, 'resume'); value.state = 'watching'; await this.save(value); return this.decorate(result);
      } catch (error) { if (value.enabled) await this.block(value, error.message); throw error; }
    });
  }
}
