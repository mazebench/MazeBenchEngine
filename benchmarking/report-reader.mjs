import { Worker } from "node:worker_threads";

// Journal replay and multi-GB telemetry parsing must not block HTTP/replay UI.
export class ReportReader {
  constructor() { this.worker = null; this.sequence = 0; this.jobs = new Map(); this.pending = new Map(); }
  read(directory, kind, runnerActive = false) {
    const key = JSON.stringify([directory, kind, runnerActive]);
    if (this.pending.has(key)) return this.pending.get(key);
    if (!this.worker) {
      const worker = this.worker = new Worker(new URL("./report-worker.mjs", import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")) });
      worker.on("message", ({ id, value, error }) => {
        const job = this.jobs.get(id); if (!job) return;
        this.jobs.delete(id);
        if (error) job.reject(new Error(error)); else job.resolve(value);
        if (!this.jobs.size) worker.unref();
      });
      const fail = error => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const job of this.jobs.values()) job.reject(error);
        this.jobs.clear();
      };
      worker.on("error", fail);
      worker.on("exit", code => fail(new Error(`Report reader stopped (${code}). Please retry.`)));
      worker.unref();
    }
    const id = ++this.sequence;
    this.worker.ref();
    const task = new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject }); this.worker.postMessage({ id, directory, kind, runnerActive }); });
    const result = task.finally(() => { if (this.pending.get(key) === result) this.pending.delete(key); });
    this.pending.set(key, result);
    return result;
  }
  async close() { if (this.worker) await this.worker.terminate(); }
}
