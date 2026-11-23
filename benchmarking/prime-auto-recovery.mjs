// Server-owned recovery policy. Kept outside the signed inference runtimes:
// retries reuse the original supervisor, conversation, model and checkpoint.
import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './providers/claude-runner.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { resumeExclusively } from './storage/resume-lock.mjs';
import { recoverIdleContinuation, idleFailure } from './recover-idle-continuation.mjs';
import { recoverPrimeMessageContent, messageContentFailure } from './recover-prime-message-content.mjs';

const direct = run => run?.provider === 'prime-agent' && ['prime-inference-direct-v1', 'prime-inference-direct-v2'].includes(run.harness);
const terminal = run => run.status === 'completed' || ['won', 'action-limit'].includes(run.game_status);
const identity = run => Object.fromEntries(['id', 'provider', 'harness', 'model', 'effort', 'tools_enabled', 'effective_prompt_sha256'].map(key => [key, run[key]]));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const RETRY_DELAYS = [15000, 30000, 60000, 120000, 240000, 300000, 300000, 300000];

export function primeFailureKind(error = '') {
  if (idleFailure(error)) return 'idle';
  if (messageContentFailure(error)) return 'message-content';
  if (/^Prime inference returned HTTP (408|425|429|5\d\d)(?:\.| \(output budget \d+\)\.)$/.test(error)) return 'transient';
  if (/^(fetch failed|network error|socket hang up|The operation was aborted due to timeout)$/i.test(error) ||
      /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|other side closed)\b/.test(error)) return 'transient';
  if (['Prime returned no assistant message.', 'Prime context summary was incomplete; conversation retained.', 'MazeBench MCP stopped.'].includes(error) ||
      /^(Unexpected end of JSON input|Unexpected token .*JSON|Unterminated string in JSON)/.test(error)) return 'transient';
  return null;
}

export class PrimeAutoRecovery {
  constructor(supervisor, { now = Date.now, interval = 5000, delays = RETRY_DELAYS, maxPerHour = 12 } = {}) {
    this.supervisor = supervisor;
    this.now = now; this.interval = interval; this.delays = delays; this.maxPerHour = maxPerHour;
    this.records = new Map(); this.pending = new Map(); this.closed = false;
    this.ready = this.load();
  }
  home(id) { this.supervisor.runDirectory(id); return path.join(this.supervisor.directStateRoot, id); }
  async load() {
    const entries = await readdir(this.supervisor.directStateRoot, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    // Only explicitly enrolled runs. Never adopt historical failures or paused
    // runs merely because their model/provider matches.
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^run-[\w-]+$/.test(entry.name)) continue;
      try {
        const value = await json(path.join(this.home(entry.name), 'auto-recovery.json'));
        if (value.version === 1 && value.id === entry.name && direct(value.identity)) this.records.set(value.id, value);
      } catch (error) { if (error.code !== 'ENOENT') console.error('Prime recovery state could not load:', entry.name, error.message); }
    }
  }
  start() {
    this.ready.then(() => {
      if (this.closed) return;
      this.timer = setInterval(() => { void this.tick(); }, this.interval); this.timer.unref();
      void this.tick();
    }).catch(error => console.error('Prime auto-recovery unavailable:', error.message));
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([...this.pending.values()]); }
  serial(id, work) {
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.pending.set(id, next);
    void next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id); }).catch(() => {});
    return next;
  }
  status(id) {
    const value = this.records.get(id);
    if (!value) return null;
    return { managed: true, enabled: value.enabled, state: value.state, attempts: value.attempts,
      max_attempts: this.delays.length, total_retries: value.total_retries, next_retry_at: value.next_retry_at, reason: value.reason };
  }
  decorate(run) { const value = this.status(run.id); return value ? { ...run, auto_recovery: value } : run; }
  async save(value, event = null) {
    const home = this.home(value.id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(home, 'auto-recovery.json'), value);
    if (event) await appendFile(path.join(home, 'auto-recovery-events.jsonl'), JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...this.status(value.id) }) + '\n', { mode: 0o600 });
  }
  async snapshot(id) {
    const directory = this.supervisor.runDirectory(id);
    const metadata = await json(path.join(directory, 'run.json'));
    const summary = await readCheckpointJson(directory, 'summary.json');
    return { ...metadata, game_status: summary.game_status, action_count: summary.action_count };
  }
  async enroll(id) {
    await this.ready;
    return this.serial(id, () => this.enrollUnlocked(id));
  }
  async enrollUnlocked(id) {
    const run = await this.snapshot(id);
    if (!direct(run) || terminal(run)) return;
    const old = this.records.get(id);
    const value = { version: 1, id, identity: identity(run), enabled: true, state: 'watching', attempts: 0,
      total_retries: old?.total_retries || 0, recent_retries: [], last_progress: run.action_count,
      next_retry_at: null, reason: null };
    this.records.set(id, value); await this.save(value, 'enabled');
  }
  async block(value, reason) {
    Object.assign(value, { enabled: false, state: 'blocked', next_retry_at: null, reason });
    await this.save(value, 'needs-attention');
  }
  async prepare(id, run, assertInactive) {
    const directory = this.supervisor.runDirectory(id), home = this.home(id);
    await assertInactive();
    await this.supervisor.verifyRunCapabilityBoundary(run, directory);
    const conversation = await json(path.join(home, 'conversation.json'));
    if (conversation.run_id !== id || conversation.messages?.[0]?.content !== await readFile(path.join(directory, 'prompt.md'), 'utf8'))
      throw new Error('Saved Prime conversation does not match this run.');
    if (conversation.inflight_tool) throw new Error('An interrupted tool call needs reconciliation before resuming; no game action was replayed.');
    const args = { root: this.supervisor.projectRoot, directory, home, assertInactive };
    if (idleFailure(run.error)) await recoverIdleContinuation(args);
    if (messageContentFailure(run.error) && !await recoverPrimeMessageContent(args))
      throw new Error('Prime rejected this request with HTTP 422; no known message-content repair applies.');
    await assertInactive();
  }
  async tick() {
    await this.ready;
    if (this.closed) return;
    await Promise.allSettled([...this.records.values()].filter(value => value.enabled && !this.pending.has(value.id)).map(value =>
      this.serial(value.id, async () => {
        try { await this.check(value); }
        catch (error) { await this.block(value, error.message); }
      })));
  }
  async check(value) {
    if (this.closed || !value.enabled) return;
    const id = value.id, run = await this.snapshot(id);
    if (JSON.stringify(identity(run)) !== JSON.stringify(value.identity)) throw new Error('Run identity or benchmark settings changed; automatic recovery stopped.');
    if (terminal(run)) {
      Object.assign(value, { enabled: false, state: 'completed', next_retry_at: null, reason: null });
      return this.save(value, 'completed');
    }
    if (['paused', 'pausing', 'stopped'].includes(run.status)) {
      Object.assign(value, { enabled: false, state: 'paused', next_retry_at: null, reason: null });
      return this.save(value, 'operator-paused');
    }
    let progress = false;
    if (run.action_count > value.last_progress) {
      value.last_progress = run.action_count; value.attempts = 0; progress = true;
    }
    if (this.supervisor.active.has(id)) {
      if (progress || value.state !== 'watching') {
        Object.assign(value, { state: 'watching', next_retry_at: null, reason: null }); await this.save(value);
      }
      return;
    }
    const kind = run.status === 'failed' ? primeFailureKind(run.error) : ['interrupted', 'queued', 'running', 'continuing'].includes(run.status) ? 'restart' : null;
    if (!kind) return this.block(value, run.error || 'This run cannot be recovered automatically.');
    value.recent_retries = value.recent_retries.filter(at => this.now() - at < 3600000);
    if (value.attempts >= this.delays.length) return this.block(value, `Automatic recovery stopped after ${value.attempts} retries without new game actions. Resume to try again.`);
    if (value.recent_retries.length >= this.maxPerHour) return this.block(value, 'Automatic recovery reached its hourly retry limit. Resume to try again.');
    if (!value.next_retry_at) {
      Object.assign(value, { state: 'waiting', reason: run.error || 'The runner was interrupted.', next_retry_at: new Date(this.now() + this.delays[value.attempts]).toISOString() });
      return this.save(value, 'retry-scheduled');
    }
    if (this.now() < Date.parse(value.next_retry_at)) return;
    const assertInactive = async () => {
      if (this.closed || !value.enabled || this.supervisor.active.has(id)) throw new Error('Recovery cancelled; the run is active or was paused/stopped.');
    };
    Object.assign(value, { state: 'retrying', next_retry_at: null, attempts: value.attempts + 1, total_retries: value.total_retries + 1 });
    value.recent_retries.push(this.now()); await this.save(value, 'retry-started');
    try {
      await this.prepare(id, run, assertInactive);
      await assertInactive();
      await resumeExclusively(this.supervisor, id);
      if (value.enabled) { value.state = 'watching'; value.reason = null; await this.save(value, 'resumed'); }
    } catch (error) { if (value.enabled && !this.closed) throw error; }
  }
  async command(id, action) {
    await this.ready;
    // Cancel before waiting for an in-progress integrity check/repair. The
    // serialized command then pauses any runner already started by that check.
    const value = this.records.get(id);
    if (value && ['pause', 'stop', 'delete'].includes(action)) {
      Object.assign(value, { enabled: false, state: 'paused', next_retry_at: null, reason: null });
    }
    return this.serial(id, async () => {
      if (value && ['pause', 'stop', 'delete'].includes(action)) {
        Object.assign(value, { enabled: false, state: 'paused', next_retry_at: null, reason: null });
        await this.save(value, 'operator-' + action);
      }
      const metadata = await json(path.join(this.supervisor.runDirectory(id), 'run.json'));
      if (action === 'resume' && direct(metadata)) {
        const run = await this.snapshot(id);
        if (this.supervisor.active.has(id)) throw new Error('This run is already active; wait for it to finish pausing.');
        if (terminal(run)) throw new Error('This game has finished.');
        await this.prepare(id, run, async () => { if (this.supervisor.active.has(id)) throw new Error('This run is already active.'); });
        const resumed = await resumeExclusively(this.supervisor, id);
        await this.enrollUnlocked(id);
        return this.decorate(resumed);
      }
      if (action === 'pause' && value && !this.supervisor.active.has(id) && !terminal(await this.snapshot(id))) {
        const file = path.join(this.supervisor.runDirectory(id), 'run.json'), metadata = await json(file);
        await atomicJson(file, { ...metadata, status: 'paused', updated_at: new Date(this.now()).toISOString() });
        return this.decorate(await this.supervisor.get(id));
      }
      const result = action === 'resume' ? await resumeExclusively(this.supervisor, id) : await this.supervisor[action](id);
      if (action === 'delete') this.records.delete(id);
      return this.decorate(result);
    });
  }
}
