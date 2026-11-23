// HTTP-only library projection, outside the frozen agent runtime inventory.
// Cards need signed counters, not reconstructed action/position histories.
import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { journalHead, verifyJournal } from "./storage/journal.mjs";
import { readCheckpointJson } from "./v1/checkpoint-json.mjs";
import { safeOpenFile } from "./v1/safe-files.mjs";
import { readRunVersion } from "./run-version.mjs";
import { rateLimitDetails } from "./run-errors.mjs";

const RUN_ID = /^run-[0-9TZ-]+-[a-f0-9]{6}$/;
const TRANSIENT = new Set(["queued", "running", "continuing", "pausing"]);
const METADATA = ["id", "pair_id", "model", "provider", "world", "observation_mode", "effort", "tools_enabled", "coding_mode", "harness",
  "sequence_enabled", "service_tier", "action_limit", "created_at", "completed_at", "stopped_at", "paused_at", "updated_at", "status"];
const COUNTERS = ["action_count", "gems_collected", "rooms_visited", "unique_cells", "levels_solved", "levels_total", "level_number"];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));

function fileStamp(directory, file) {
  const fd = safeOpenFile(directory, file);
  try {
    const s = fstatSync(fd, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } finally { closeSync(fd); }
}

export class RunLibrary {
  constructor({ markInterrupted = false } = {}) {
    this.markInterrupted = markInterrupted;
    this.cache = new Map();
    this.pending = null;
  }

  async summary(directory) {
    let head;
    try { head = journalHead(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const incremental = head?.storage === "incremental-v1";
    const files = ["summary.json"];
    if (incremental) {
      if (!/^[a-f0-9-]{36}$/.test(head.generation || "")) throw new Error("Invalid journal generation.");
      files.push("checkpoint.json", "game-state.json", "display.json", "sandbox-state/integrity-key",
        `journal/${head.generation}/base-state.json`, `journal/${head.generation}/base-summary.json`,
        `journal/${head.generation}/entries.jsonl`);
    }
    // Retain only small verified projections. Check EVERY verification input on
    // cache hits, including the key, markers, base files, and journal inode.
    // Never return cached scores after a file changes or becomes a link.
    const stamps = files.map(file => {
      try { return fileStamp(directory, file); }
      catch (error) { if (!incremental && error.code === "ENOENT") return "missing"; throw error; }
    });
    const logStamp = incremental ? stamps.at(-1) : null;
    const fingerprint = createHash("sha256").update(JSON.stringify(head ?? null))
      .update(stamps.join("|")).digest("hex");
    const cached = this.cache.get(directory);
    if (cached?.fingerprint === fingerprint) {
      this.cache.delete(directory);
      this.cache.set(directory, cached);
      return cached.value;
    }
    // The journal verifier has a smaller cache. Preserve its changed-log check
    // even when a large library has evicted this run from that cache.
    const full = incremental && cached?.hmac === head.hmac && cached.logStamp !== logStamp;
    const verified = incremental ? verifyJournal(directory, { full }) : null;
    const summary = verified ? verified.summary
      : await readCheckpointJson(directory, "summary.json").catch(error => { if (error.code === "ENOENT") return {}; throw error; });
    const value = pick(summary, COUNTERS);
    const snapshot = { summary: Object.fromEntries(Object.entries(summary).filter(([, value]) => !Array.isArray(value))),
      display: verified?.display, history_epoch: verified ? `${verified.generation}:${verified.historyEpoch || verified.generation}` : null };
    this.cache.set(directory, { fingerprint, value, snapshot, hmac: verified?.hmac, logStamp });
    if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  async snapshot(directory) {
    await this.summary(directory);
    return this.cache.get(directory).snapshot;
  }

  async card(directory, active = false) {
    const metadata = await readCheckpointJson(directory, "run.json");
    const summary = await this.summary(directory);
    const run = { ...pick(metadata, METADATA), ...summary, runner_active: active };
    run.benchmark_version = readRunVersion(directory, metadata, this.cache.get(directory)?.snapshot.summary);
    const rateLimit = metadata.status === "failed" ? rateLimitDetails(metadata.error) : null;
    if (rateLimit) run.rate_limit = rateLimit;
    if (this.markInterrupted && !active && TRANSIENT.has(run.status)) {
      run.recorded_status = run.status;
      run.status = "interrupted";
    }
    return run;
  }

  // Read-only streaming for the dashboard. Runtime liveness still comes from
  // each run's owner; these cards are presented as saved results until then.
  async *stream(roots, signal) {
    const directories = new Map();
    for (const root of roots) {
      const entries = await readdir(root, { withFileTypes: true }).catch(error => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) if (entry.isDirectory() && RUN_ID.test(entry.name) && !directories.has(entry.name)) {
        directories.set(entry.name, path.join(root, entry.name));
      }
    }
    const total = directories.size;
    let loaded = 0;
    yield { type: "start", total, loaded };
    for (const directory of directories.values()) {
      if (signal?.aborted) return;
      const run = await this.card(directory).catch(() => null);
      yield { type: "record", total, loaded: ++loaded, run };
    }
    yield { type: "done", total, loaded };
  }

  async list(supervisor) {
    // Several open pages share the same disk scan instead of queueing copies.
    if (this.pending) return this.pending;
    const task = this.read(supervisor);
    this.pending = task;
    try { return await task; }
    finally { if (this.pending === task) this.pending = null; }
  }

  async read(supervisor) {
    await supervisor.initialize();
    const entries = (await readdir(supervisor.recordsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && RUN_ID.test(entry.name));
    const directories = new Set();
    const runs = await Promise.all(entries.map(async entry => {
      try {
        const directory = supervisor.runDirectory(entry.name);
        directories.add(directory);
        return await this.card(directory, supervisor.active.has(entry.name));
      } catch { return null; }
    }));
    for (const directory of this.cache.keys()) if (!directories.has(directory)) this.cache.delete(directory);
    return runs.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
