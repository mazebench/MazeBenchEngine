import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { catalogSources } from './sources.mjs';
import { groupModels, validId } from './normalize.mjs';
export const CATALOG_TTL = 5 * 60_000;
export class ModelCatalog {
  constructor({ antigravityBin, sources = catalogSources({ antigravityBin }), cacheFile = path.join(os.homedir(), '.mazebench/model-catalog.json'), now = Date.now, ttl = CATALOG_TTL } = {}) {
    Object.assign(this, { sources, cacheFile, now, ttl }); this.entries = {}; this.pending = new Map(); this.saving = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    if (!this.cacheFile) return;
    try { const saved = JSON.parse(await readFile(this.cacheFile, 'utf8')); if (saved.version === 1) this.entries = saved.providers; } catch { /* Missing/corrupt disposable cache is refreshed. */ }
  }
  async provider(provider, { force = false } = {}) {
    await this.ready;
    if (!this.sources[provider]) throw new Error('Unknown model provider.');
    if (this.pending.has(provider)) return this.pending.get(provider);
    const previous = this.entries[provider];
    if (!force && previous && this.now() - previous.checked_at < (previous.error ? 30000 : this.ttl)) return this.view(previous);
    const promise = (async () => {
      const checked_at = this.now();
      try {
        const result = await this.sources[provider]({ force });
        const models = Array.isArray(result) ? result : result.models;
        if (!Array.isArray(models) || !models.length || models.some(m => !validId(m.id) || m.provider !== provider || !m.efforts?.length || !m.efforts.includes(m.default_effort))) throw new Error('Provider returned an incomplete model catalog.');
        const ids = new Set(); if (models.some(m => { const id = `${m.connection_id || ''}:${m.id}`; return ids.has(id) || !ids.add(id); })) throw new Error('Provider returned duplicate model IDs.');
        this.entries[provider] = { models, connections: result.connections, checked_at, updated_at: this.now(), error: null };
      } catch (error) {
        this.entries[provider] = { models: previous?.models || [], updated_at: previous?.updated_at || null, checked_at, error: error.message };
      }
      await this.save(); return this.view(this.entries[provider]);
    })().finally(() => this.pending.delete(provider));
    this.pending.set(provider, promise); return promise;
  }
  view(entry) {
    return { ...entry, stale: Boolean(entry.error || !entry.updated_at || this.now() - entry.updated_at >= this.ttl) };
  }
  async save() {
    if (!this.cacheFile) return;
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      const temporary = this.cacheFile + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify({ version: 1, providers: this.entries }), { mode: 0o600 });
      await rename(temporary, this.cacheFile);
    });
    // A disk cache failure must not turn a successful online refresh into an
    // unhandled rejection or discard the in-memory catalog.
    await this.saving.catch(() => {});
  }
  async all(options = {}) {
    const pairs = await Promise.all(Object.keys(this.sources).map(async p => [p, await this.provider(p, options)]));
    const providers = Object.fromEntries(pairs), models = pairs.flatMap(([, value]) => value.models);
    return { models, groups: groupModels(models), catalogs: Object.fromEntries(pairs.map(([p, { models, ...status }]) => [p, { ...status, model_count: models.length }])),
      default_model: providers.codex?.models.find(m => m.is_default)?.id || providers.codex?.models[0]?.id, refresh_interval_ms: this.ttl };
  }
  async selection(spec, { force = false } = {}) {
    const state = await this.provider(spec.provider || 'codex', { force });
    if (state.stale) throw new Error('Refresh the model catalog before launching: ' + (state.error || 'catalog is stale'));
    const matches = state.models.filter(m => m.id === spec.model && (!spec.connection_id || m.connection_id === spec.connection_id));
    if (matches.length > 1) throw new Error('Choose the billing connection for this model.');
    const model = matches[0];
    if (!model) throw new Error('The selected model is no longer available through this harness. Refresh models.');
    if (model.connection_stale) throw new Error(model.connection_error || 'Refresh this provider connection before launching.');
    const direct = spec.provider === 'prime-agent' && spec.coding_mode === 'off';
    const efforts = direct ? model.direct_efforts : model.efforts;
    if (!efforts?.includes(spec.effort || (direct ? model.default_direct_effort : model.default_effort))) throw new Error('This model does not support the selected reasoning effort.');
    if (!(model.speed_options || ['standard']).includes(spec.service_tier || 'standard')) throw new Error('This model does not support the selected speed.');
    return model;
  }
}
