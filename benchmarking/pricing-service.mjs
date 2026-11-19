import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { pricingSources, validPrice } from './pricing-sources.mjs';
import { installPricingSnapshot } from './token-pricing.mjs';

// Older report processes cannot interpret recurring peak schedules. Keep their
// cache separate during a rolling update, preserving prior price observations.
const legacyCacheFile = path.resolve(import.meta.dirname, '../.mazebench/pricing/catalog.json');
export const pricingCacheFile = path.resolve(import.meta.dirname, '../.mazebench/pricing/catalog-v2.json');
const sixHours = 6 * 60 * 60 * 1000, retryDelay = 5 * 60 * 1000;
const empty = () => ({ version: 1, entries: {}, sources: {} });
const signature = price => JSON.stringify([price.rates, price.context_tiers, price.changes, price.effective_at, price.time_schedule]);
function validateSnapshot(value) {
  if (value?.version !== 1 || !value.entries || !value.sources) throw new Error('Invalid pricing cache');
  for (const item of Object.values(value.entries)) {
    if (!Array.isArray(item.versions) || !item.versions.length || item.versions.some(v => !validPrice(v.price) || v.from != null && !Number.isFinite(v.from))) throw new Error('Invalid cached price');
  }
  return value;
}
export class PricingService {
  constructor({ file = pricingCacheFile, sources = pricingSources, fetcher = fetch, now = Date.now } = {}) {
    this.file = file; this.definitions = sources; this.fetcher = fetcher; this.now = now; this.snapshot = empty(); this.pending = null;
    this.ready = this.load();
  }
  async load() {
    try { this.snapshot = validateSnapshot(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT' && this.file === pricingCacheFile) {
        try { this.snapshot = validateSnapshot(JSON.parse(await readFile(legacyCacheFile, 'utf8'))); }
        catch (legacyError) { if (legacyError.code !== 'ENOENT') this.snapshot.storage_error = `Could not read cached pricing: ${legacyError.message}`; }
      } else if (error.code !== 'ENOENT') this.snapshot.storage_error = `Could not read cached pricing: ${error.message}`;
    }
  }
  async refresh(force = false) {
    await this.ready;
    if (this.pending) return this.pending;
    this.pending = this.update(force).finally(() => { this.pending = null; });
    return this.pending;
  }
  async update(force) {
    const now = this.now(), checked = new Date(now).toISOString();
    // Fetches are independent; a broken source must not block healthy sources.
    const results = await Promise.allSettled(this.definitions.map(async source => {
      const old = this.snapshot.sources[source.id];
      if (!force && now < (old?.next_check || 0)) return null;
      try {
        const response = await this.fetcher(source.url, { signal: AbortSignal.timeout(15000),
          headers: { 'Accept-Language': 'en', ...(old?.etag ? { 'If-None-Match': old.etag } : {}) } });
        if (response.status === 304 && old?.checked_at) return { source, unchanged: true, etag: old.etag };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Bound downloaded data and never execute source content.
        const reader = response.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
          if (size > 16 * 1024 * 1024) throw new Error('Pricing source exceeded size limit'); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); }
        finally { await reader.cancel().catch(() => {}); }
        const entries = source.parse(text);
        if (!entries.length || entries.some(e => !/^(direct|prime):[^\s]+:(standard|fast)$/.test(e.key) || !validPrice(e.price))) throw new Error('Unrecognized or invalid pricing data');
        if (old?.count && entries.length < old.count * .75) throw new Error('Pricing table unexpectedly lost more than 25% of entries');
        return { source, entries, etag: response.headers.get('etag') };
      } catch (error) { return { source, error: error.message }; }
    }));
    let touched = false;
    // Official data wins independently of network completion order.
    const values = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean)
      .sort((a,b) => (b.source.priority || 10) - (a.source.priority || 10));
    for (const result of values) {
      touched = true;
      const { source } = result, old = this.snapshot.sources[source.id] || {};
      if (result.error) {
        this.snapshot.sources[source.id] = { ...old, url: source.url, attempted_at: checked, error: result.error, next_check: now + retryDelay };
        continue;
      }
      const info = this.snapshot.sources[source.id] = { url: source.url, checked_at: checked, attempted_at: checked,
        next_check: now + sixHours, count: result.entries?.length ?? old.count, etag: result.etag };
      for (const { key, price: raw } of result.entries || []) {
        const existing = this.snapshot.entries[key], priority = source.priority || 10;
        if (existing && existing.priority > priority) continue;
        const price = { ...raw, source: source.url.replace(/\.md$/, ''), source_id: source.id, checked_at: checked,
          observed_at: checked, note: raw.note || 'Automatically checked against the provider. Historical prices before first observation may be unavailable.' };
        const previous = existing?.versions.at(-1);
        if (previous && signature(previous.price) === signature(price)) {
          previous.price = price; existing.priority = priority;
        } else {
          const effective = Date.parse(price.effective_at);
          // A retrospective effective date must never reorder recorded history.
          const from = previous ? Math.max(previous.from || 0, Number.isFinite(effective) ? effective : now) : null;
          this.snapshot.entries[key] = { priority, versions: [...(existing?.versions || []), { from, price }] };
        }
      }
      if (result.unchanged) for (const item of Object.values(this.snapshot.entries)) {
        const price = item.versions.at(-1).price;
        if (price.source_id === source.id) price.checked_at = info.checked_at;
      }
    }
    if (touched) {
      this.snapshot.updated_at = checked;
      try {
        delete this.snapshot.storage_error;
        await mkdir(path.dirname(this.file), { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.snapshot), { mode: 0o600 }); await rename(temp, this.file);
      } catch (error) { this.snapshot.storage_error = `Pricing works in memory but could not be saved: ${error.message}`; }
    }
    return this.snapshot;
  }
  start() { this.refresh().catch(() => {}); this.timer = setInterval(() => this.refresh().catch(() => {}), 60000); this.timer.unref(); }
  close() { clearInterval(this.timer); }
}

let loadedVersion;
export async function loadPricingCache(file = pricingCacheFile) {
  try {
    const info = await stat(file), version = `${file}:${info.mtimeMs}:${info.size}`;
    if (loadedVersion === version) return;
    const snapshot = validateSnapshot(JSON.parse(await readFile(file, 'utf8')));
    installPricingSnapshot(snapshot); loadedVersion = version;
  } catch { /* Last working prices, including bundled verified rates, remain installed. */ }
}
