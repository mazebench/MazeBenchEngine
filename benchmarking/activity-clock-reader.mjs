import { closeSync, fstatSync, read } from 'node:fs';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import os from 'node:os';
import { safeOpenFile, safeReadFile } from './v1/safe-files.mjs';
import { createActivityClock, consumeActivityEvent, consumeRecoveryEvent, activeTimeReport } from './active-run-time.mjs';

const readAsync = promisify(read);
export class ActivityClockReader {
  constructor({ primeHome = path.join(os.homedir(), '.mazebench/prime-direct/runs') } = {}) {
    this.primeHome = primeHome; this.cache = new Map();
  }
  async consume(directory, file, cache, accept) {
    let fd;
    try { fd = safeOpenFile(directory, file); }
    catch (error) { if (error.code === 'ENOENT') return createActivityClock(); throw error; }
    try {
      const stat = fstatSync(fd), key = path.join(directory, file);
      let saved = cache.get(key);
      if (!saved || stat.ino !== saved.inode || stat.size < saved.offset) {
        saved = { inode: stat.ino, offset: 0, partial: '', decoder: new StringDecoder('utf8'), clock: createActivityClock() }; cache.set(key, saved);
      }
      const buffer = Buffer.alloc(256 * 1024);
      while (saved.offset < stat.size) {
        const { bytesRead } = await readAsync(fd, buffer, 0, Math.min(buffer.length, stat.size - saved.offset), saved.offset);
        if (!bytesRead) break;
        saved.offset += bytesRead;
        const lines = (saved.partial + saved.decoder.write(buffer.subarray(0, bytesRead))).split('\n'); saved.partial = lines.pop();
        for (const line of lines) { let event; try { event = JSON.parse(line); } catch { continue; } accept(saved.clock, event); }
      }
      return saved.clock;
    } finally { closeSync(fd); }
  }
  async read(directory, telemetry) {
    if (!telemetry.samples?.length) return telemetry;
    const metadata = JSON.parse(safeReadFile(directory, 'run.json'));
    let cache = this.cache.get(directory);
    if (!cache) { cache = new Map(); this.cache.set(directory, cache); if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value); }
    const file = ({ 'claude-code': 'claude-events.jsonl', 'grok-build': 'grok-events.jsonl', antigravity: 'antigravity-events.jsonl',
      'kimi-code': 'kimi-events.jsonl', 'muse-code': 'muse-events.jsonl', 'deepseek-harness': 'deepseek-events.jsonl' })[metadata.provider] || 'agent-events.jsonl';
    const clocks = [await this.consume(directory, file, cache, (clock, event) => consumeActivityEvent(clock, event, metadata))];
    if (metadata.provider === 'prime-agent' && /^run-[\w-]+$/.test(metadata.id || '')) {
      clocks.push(await this.consume(path.join(this.primeHome, metadata.id), 'auto-recovery-events.jsonl', cache, consumeRecoveryEvent));
    }
    return activeTimeReport(telemetry, clocks);
  }
}
