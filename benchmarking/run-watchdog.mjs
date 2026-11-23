// Operator-side recovery only. Never import this from a signed model runtime.
import path from 'node:path';
import os from 'node:os';
import { mkdir, readFile, writeFile, rename, unlink, appendFile, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { recoverIdleContinuation, idleFailure } from './recover-idle-continuation.mjs';
import { recoverPrimeMessageContent } from './recover-prime-message-content.mjs';

export const INTERVAL_MS = 15 * 60 * 1000;
export const TARGETS = [
  { id: 'run-2026-10-23T21-38-27-136Z-e809f5', name: 'DeepSeek V4.1 Flash', provider: 'prime-agent', model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'max' },
  { id: 'run-2026-10-23T21-38-28-532Z-e2a66a', name: 'Qwen 3.8 27B', provider: 'prime-agent', model: 'qwen/qwen3.8-27b', effort: 'xhigh' },
  { id: 'run-2026-10-23T17-52-26-807Z-674902', name: 'K3.1 Pro', provider: 'kimi-code', model: 'k3.1-pro', effort: 'max', not_before: '2026-10-23T22:40:00Z' }
];

export function decide(target, run, now = Date.now()) {
  if (target.not_before && now < Date.parse(target.not_before)) return 'waiting';
  if (run.id !== target.id || run.model !== target.model || run.provider !== target.provider || run.effort !== target.effort || run.tools_enabled !== false)
    throw new Error('Run identity or Python-off/reasoning condition differs from the authorized target.');
  if (['won', 'action-limit'].includes(run.game_status) || run.status === 'completed') return 'finished';
  if (run.runner_active) return 'running';
  // The owning server handles these retries and their circuit breaker. Never
  // bypass its pause, backoff, or safety decision with an external resume.
  if (run.auto_recovery?.managed) {
    if (run.auto_recovery.state === 'blocked') throw new Error(run.auto_recovery.reason || 'Automatic recovery needs attention.');
    return run.auto_recovery.enabled ? 'recovering' : 'operator-paused';
  }
  // An intentional pause/stop after enabling monitoring remains an operator
  // control. Only failures and orphaned sessions are automatically resumed.
  if (['paused', 'stopped'].includes(run.status)) return 'operator-paused';
  if (['failed', 'interrupted', 'queued', 'preparing', 'running', 'continuing', 'pausing'].includes(run.status)) return 'resume';
  throw new Error('Unknown run state: ' + run.status);
}

export async function checkRuns({ targets = TARGETS, previous = {}, get, resume, recover = async () => null, now = Date.now(), wait = delay, verifyDelay = 8000 }) {
  const results = {}, events = [];
  const reads = await Promise.allSettled(targets.map(target => {
    if (target.not_before && now < Date.parse(target.not_before)) return null;
    if (previous[target.id]?.outcome === 'finished') return null;
    return get(target.id);
  }));
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index], old = previous[target.id];
    let result;
    try {
      if (old?.outcome === 'finished') { results[target.id] = old; continue; }
      const read = reads[index];
      if (read.status === 'rejected') throw read.reason;
      let run = read.value;
      let outcome = run ? decide(target, run, now) : 'waiting';
      result = { name: target.name, model: target.model, outcome, checked_at: new Date(now).toISOString(),
        actions: run?.action_count ?? old?.actions ?? null, attempts: old?.attempts || 0 };
      if (outcome === 'resume') {
        result.attempts++;
        const repair = await recover(target, run);
        if (repair) result.repair = repair;
        // The owning supervisor verifies signed assets/checkpoints and acquires
        // its exclusive resume lock. It reuses the saved session and pending
        // tool calls. The original benchmark prompt and checkpoints remain
        // unchanged; any operator continuation above is backed up and audited.
        await resume(target.id);
        await wait(verifyDelay);
        run = await get(target.id);
        outcome = decide(target, run, now);
        if (outcome === 'resume') throw new Error(run.error || 'The run failed again immediately after resuming.');
        result.outcome = outcome;
        result.actions = run.action_count;
        result.resumed_at = new Date().toISOString();
        events.push({ id: target.id, name: target.name, kind: 'resumed', actions: result.actions, ...(repair ? { repair } : {}) });
      }
    } catch (error) {
      result = { ...result, name: target.name, model: target.model, outcome: 'needs-attention',
        checked_at: new Date(now).toISOString(), attempts: result?.attempts || old?.attempts || 0,
        actions: result?.actions ?? old?.actions ?? null, error: String(error.message || error).slice(0,1000) };
    }
    results[target.id] = result;
    if (result.outcome === 'needs-attention' && (old?.outcome !== result.outcome || old?.error !== result.error))
      events.push({ id: target.id, name: target.name, kind: 'needs-attention', error: result.error });
    if (result.outcome === 'finished' && old?.outcome !== 'finished') events.push({ id: target.id, name: target.name, kind: 'finished', actions: result.actions });
  }
  return { checked_at: new Date(now).toISOString(), next_check: new Date(now + INTERVAL_MS).toISOString(), runs: results, events,
    complete: targets.every(target => results[target.id]?.outcome === 'finished') };
}

async function json(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomic(file, value) {
  const temporary = file + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file);
}
async function acquire(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close(); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = await json(file, null);
      if (!lock?.pid) return false;
      try { process.kill(lock.pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') return false; }
      await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return false;
}

const runFile = promisify(execFile);
async function notify(events) {
  if (!events.length) return;
  const message = events.map(event => `${event.name}: ${event.kind === 'resumed' ? 'resumed' : event.kind === 'finished' ? 'finished' : 'needs attention'}`).join('; ');
  // Notify only this Mac's user. No email, chat messages or external service.
  await runFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "MazeBench monitor"', '-e', 'end run', message], { timeout: 10000 }).catch(() => {});
}

export async function runWatchdog({ directory = path.join(os.homedir(), '.mazebench/run-watchdog'), dryRun = false } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const settings = await json(path.join(directory, 'settings.json'), { enabled: true, notifications: true });
  if (!settings.enabled) return { disabled: true };
  const lock = path.join(directory, 'check.lock');
  if (!await acquire(lock)) return { already_checking: true };
  try {
    const previous = await json(path.join(directory, 'status.json'), {});
    if (previous.complete) return { complete: true };
    const api = async (id, mutation = false) => {
      const response = await fetch('http://127.0.0.1:8083/api/benchmark/v1/runs/' + encodeURIComponent(id) + (mutation ? '/resume' : '?view=overview'),
        { method: mutation ? 'POST' : 'GET', signal: AbortSignal.timeout(mutation ? 60000 : 15000), redirect: 'error' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `Local benchmark server returned HTTP ${response.status}.`);
      return value;
    };
    if (dryRun) {
      const results = [];
      for (const target of TARGETS) {
        if (target.not_before && Date.now() < Date.parse(target.not_before)) results.push({ id: target.id, name: target.name, decision: 'waiting' });
        else results.push({ id: target.id, name: target.name, decision: decide(target, await api(target.id)) });
      }
      return { dry_run: true, runs: results };
    }
    const report = await checkRuns({ previous: previous.runs, get: id => api(id), resume: id => api(id, true),
      recover: async (target, run) => {
        if (target.provider !== 'prime-agent') return null;
        const recover = idleFailure(run.error) ? recoverIdleContinuation : run.error === 'Prime inference returned HTTP 422.' ? recoverPrimeMessageContent : null;
        if (!recover) return null;
        return recover({ root: path.resolve(import.meta.dirname, '..'),
          directory: path.join(os.homedir(), 'records/mazebench-benchmark', target.id),
          home: path.join(os.homedir(), '.mazebench/prime-direct/runs', target.id),
          assertInactive: async () => {
            const current = await api(target.id);
            if (decide(target, current) !== 'resume' || current.status !== 'failed') throw new Error('Run became active during recovery.');
          } });
      } });
    await atomic(path.join(directory, 'status.json'), report);
    for (const event of report.events) await appendFile(path.join(directory, 'events.jsonl'), JSON.stringify({ at: report.checked_at, ...event }) + '\n', { mode: 0o600 });
    if (settings.notifications) await notify(report.events);
    return report;
  } finally { await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

if (process.argv[1] === import.meta.filename) {
  runWatchdog({ dryRun: process.argv.includes('--dry-run') }).then(report => {
    if (report.events?.length || report.dry_run) console.log(JSON.stringify(report));
  }).catch(error => { console.error(new Date().toISOString(), error.message); process.exitCode = 1; });
}
