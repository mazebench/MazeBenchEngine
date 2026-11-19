import { connections, connectionToken, providerModels, publicConnection } from './credentials.mjs';
import { validId } from '../model-catalog/normalize.mjs';

export async function fetchConnectionModels(connection, { fetcher = fetch, token } = {}) {
  token ??= await connectionToken(connection);
  const anthropic = connection.api === 'anthropic-messages';
  const google = connection.api === 'google-generative-ai';
  const base = connection.base_url.replace(/\/$/, '');
  let endpoint = base + (anthropic && !base.endsWith('/v1') ? '/v1' : '') + '/models';
  if (anthropic) endpoint += '?limit=1000';
  const headers = google ? { 'x-goog-api-key': token }
    : anthropic ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
      : { Authorization: 'Bearer ' + token };
  const all = [], cursors = new Set();
  for (let page = 0; page < 100; page++) {
    const response = await fetcher(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`${connection.name} model discovery returned HTTP ${response.status}.`);
    const body = await response.json(), rows = google || connection.auth === 'chatgpt' ? body.models : body.data;
    if (!Array.isArray(rows)) throw new Error(`${connection.name} returned an invalid model catalog.`);
    all.push(...rows.filter(m => connection.auth !== 'chatgpt' || m.visibility === 'list'));
    if (google ? !body.nextPageToken : !body.has_more) return all;
    const cursor = google ? body.nextPageToken : body.last_id || rows.at(-1)?.id;
    if (!cursor || cursors.has(cursor)) throw new Error('Model pagination did not advance.');
    cursors.add(cursor); const url = new URL(endpoint); url.searchParams.set(google ? 'pageToken' : 'after_id', cursor); endpoint = url.href;
  }
  throw new Error('Model catalog exceeded its page limit.');
}

// Describe models from the provider's live account catalog and the stock
// transport metadata. No chosen-model allowlist; unknown chat models can use
// provider-declared capabilities or explicit connection overrides.
export function describeModel(row, connection, installed = []) {
  if (connection.api === 'google-generative-ai') {
    if (!row.name?.startsWith('models/') || !row.supportedGenerationMethods?.includes('generateContent')) return null;
    row = { id: row.name.slice('models/'.length), display_name: row.displayName,
      max_input_tokens: row.inputTokenLimit, max_output_tokens: row.outputTokenLimit };
  }
  const id = row.slug || row.id;
  if (!validId(id) || row.lifecycle === 'retired') return null;
  const known = installed.find(m => m.id === id), override = connection.models?.find(m => m.id === id);
  const excluded = /(?:embedding|moderation|whisper|tts|transcribe|realtime|audio|image|video|sora|search-preview|deep-research)/i.test(id);
  if (excluded || row.type && !['model', 'chat', 'language'].includes(row.type)) return null;
  const context = override?.contextWindow || row.max_input_tokens || row.context_window || row.context_length || row.limit?.context || known?.contextWindow;
  const maxTokens = override?.maxTokens || row.max_tokens || row.max_output_tokens || row.top_provider?.max_completion_tokens || known?.maxTokens;
  const profile = { id, name: row.display_name || row.name || known?.name || id,
    ...(context ? { contextWindow: context } : {}), ...(maxTokens ? { maxTokens } : {}) };
  const levels = row.supported_reasoning_levels || row.supported_reasoning_efforts;
  const supportedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (Array.isArray(levels) && levels.length && connection.api !== 'anthropic-messages') profile.reasoningEfforts = Object.fromEntries(levels.map(v => {
    const effort = typeof v === 'string' ? v : v.effort || v.reasoning_effort || v.value || v.id;
    return [effort === 'none' ? 'off' : effort, effort === 'none' ? null : effort];
  }).filter(([effort]) => supportedLevels.includes(effort)));
  if (!known && connection.api === 'anthropic-messages' && row.capabilities?.thinking?.types?.adaptive?.supported) {
    const effort = row.capabilities.effort;
    profile.reasoningEfforts = Object.fromEntries(supportedLevels.filter(e => effort?.[e]?.supported).map(e => [e, e]));
    if (row.capabilities.thinking.types.disabled?.supported) profile.reasoningEfforts.off = null;
    profile.compat = { forceAdaptiveThinking: true, supportsTemperature: false };
  }
  // Installed Anthropic capabilities include adaptive-thinking and fallback
  // rules which are not interchangeable with OpenAI effort strings.
  if (!known && !profile.reasoningEfforts) profile.reasoningEfforts = false;
  Object.assign(profile, override || {});
  const knownEfforts = known?.reasoning ? supportedLevels.filter(e => known.thinkingLevelMap?.[e] !== null && (!['xhigh', 'max'].includes(e) || known.thinkingLevelMap?.[e] !== undefined)) : ['default'];
  let efforts = profile.reasoningEfforts === false ? ['default'] : Object.keys(profile.reasoningEfforts || {}).map(e => e === 'off' ? 'none' : e);
  if (!efforts.length) efforts = knownEfforts.length ? knownEfforts.map(e => e === 'off' ? 'none' : e) : ['default'];
  const liveDefault = row.default_reasoning_level || row.default_reasoning_effort;
  const preferred = liveDefault === 'none' ? 'none' : liveDefault;
  const defaultEffort = efforts.includes(preferred) ? preferred : efforts.includes('high') ? 'high' : efforts.includes('medium') ? 'medium' : efforts[0];
  return { id, name: profile.name, connection_id: connection.id, connection_name: connection.name,
    billing_source: connection.auth === 'chatgpt' ? 'chatgpt-plan' : connection.id,
    api: connection.api, efforts, default_effort: defaultEffort, context_limit: context, provider_capabilities: row.capabilities,
    model_profile: profile, connection, metadata_source: known ? 'provider-and-installed-transport' : 'provider',
    ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}) };
}

export function grokConnectedModel(model) {
  let efforts = model.efforts;
  if (model.api === 'anthropic-messages') {
    // Grok's native Messages adapter implements adaptive thinking, whereas
    // DeepSeek also implements token budgets for older Claude models.
    const capabilities = model.provider_capabilities;
    efforts = capabilities?.thinking?.types?.adaptive?.supported
      ? ['low', 'medium', 'high', 'xhigh', 'max'].filter(e => capabilities.effort?.[e]?.supported)
      : [];
    if (capabilities?.thinking?.types?.disabled?.supported && efforts.length) efforts.unshift('none');
    if (!efforts.length) efforts = ['default'];
  }
  return { ...model, provider: 'grok-build', efforts,
    default_effort: efforts.includes(model.default_effort) ? model.default_effort : efforts.includes('high') ? 'high' : efforts[0] };
}

const cache = new Map(), pending = new Map();
export async function connectedCatalog({ force = false, configured = connections() } = {}) {
  const states = await Promise.all(configured.map(async connection => {
    const key = JSON.stringify(connection), previous = cache.get(key);
    if (!force && previous && Date.now() - previous.checked_at < 60000) return previous;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      const checked_at = Date.now();
      try {
        const [rows, installed] = await Promise.all([fetchConnectionModels(connection), providerModels(connection.catalog_provider)]);
        const models = rows.map(row => describeModel(row, connection, installed)).filter(Boolean);
        if (!models.length) throw new Error('No compatible language models were returned.');
        const state = { ...publicConnection(connection), checked_at, models, error: null, stale: false, excluded_count: rows.length - models.length };
        cache.set(key, state); return state;
      } catch (error) {
        const state = { ...publicConnection(connection), checked_at, models: previous?.models || [], stale: true, error: error.message };
        cache.set(key, state); return state;
      }
    })().finally(() => pending.delete(key)); pending.set(key, operation); return operation;
  }));
  return { models: states.flatMap(s => s.models.map(m => ({ ...m, connection_stale: s.stale, connection_error: s.error }))),
    connections: states.map(({ models, ...state }) => ({ ...state, model_count: models.length })) };
}
