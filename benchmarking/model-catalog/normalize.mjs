// Provider identifiers remain exact. Group only documented preset suffixes;
// names such as Flash, Pro, Max and Lightning are actual model families.
export const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'enabled', 'default'];
export const sortedEfforts = values => [...new Set(values)].sort((a, b) => {
  const ai = effortOrder.indexOf(a), bi = effortOrder.indexOf(b);
  return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi) || a.localeCompare(b);
});
export const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/.test(id);
export function kimiModels(result) {
  if (!Array.isArray(result?.data)) throw new Error('Kimi returned an invalid model catalog.');
  return result.data.map(m => {
    const efforts = m.reasoning?.effort?.valid || m.think_efforts?.valid_efforts || [];
    const available = efforts.length ? sortedEfforts(efforts) : ['default'];
    return { id: m.id, name: 'Kimi ' + (m.display_name || m.id), provider: 'kimi-code', efforts: available,
      default_effort: m.reasoning?.effort?.default || m.think_efforts?.default_effort || 'default',
      context_limit: m.limit?.context || m.context_length };
  }).filter(m => validId(m.id) && Number.isSafeInteger(m.context_limit) && m.context_limit > 0 && m.efforts.includes(m.default_effort));
}
export function codexModels(result) {
  return result.data.map(m => ({ id: m.model || m.id, name: m.displayName || m.model, provider: 'codex',
    efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort), default_effort: m.defaultReasoningEffort,
    speed_options: ['standard', ...(m.additionalSpeedTiers || []).filter(t => t === 'fast')], hidden: m.hidden === true,
    is_default: m.isDefault === true }));
}
export function claudeModels(result, picker = {}) {
  const known = new Map((picker.models || []).map(m => [m.resolvedModel || m.value, m]));
  return result.data.filter(m => m.lifecycle !== 'retired').map(m => {
    const live = known.get(m.id), effort = m.capabilities?.effort;
    const efforts = effort?.supported ? sortedEfforts(Object.entries(effort).filter(([k, v]) => k !== 'supported' && v?.supported).map(([k]) => k)) : [];
    const allowed = live?.supportedEffortLevels ? efforts.filter(e => live.supportedEffortLevels.includes(e)) : efforts;
    // The CLI reports fast capability for picker entries; the official fast-mode
    // compatibility list additionally includes older Opus 5 and 4.8 versions.
    const fast = live?.supportsFastMode ?? ['claude-opus-5', 'claude-opus-4-8'].includes(m.id);
    return { id: m.id, name: m.display_name || m.id, provider: 'claude-code', efforts: allowed.length ? allowed : ['default'],
      default_effort: allowed.includes('medium') && /-5-5$/.test(m.id) ? 'medium' : allowed.includes('high') ? 'high' : allowed[0] || 'default',
      speed_options: ['standard', ...(fast ? ['fast'] : [])], context_limit: m.max_input_tokens,
      lifecycle: m.lifecycle, retires_at: m.retires_at };
  });
}
export function antigravityModels(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => {
    const [id, name] = line.trim().split('\t');
    if (!validId(id) || !name) return [];
    const effort = id.match(/-(minimal|low|medium|high|xhigh|max)$/)?.[1] || 'default';
    return [{ id, name, provider: 'antigravity', efforts: [effort], default_effort: effort }];
  });
}
export function grokModels(cache) {
  return Object.entries(cache.models || {}).flatMap(([key, entry]) => {
    const m = entry.info || entry, id = m.slug || m.id || key;
    if (!validId(id)) return [];
    const efforts = (m.reasoning_efforts || m.supported_reasoning_levels || m.supported_reasoning_efforts || []).map(e => typeof e === 'string' ? e : e.value || e.id || e.effort || e.reasoning_effort);
    return [{ id, name: m.name || m.display_name || id, provider: 'grok-build', efforts: efforts.length ? sortedEfforts(efforts) : ['default'],
      default_effort: m.reasoning_effort || m.default_reasoning_level || m.default_reasoning_effort || efforts[0] || 'default', hidden: m.visibility === 'hide' }];
  });
}
export function modelIdentity(model) {
  let id = model.id, name = model.name || id, speed = 'standard';
  if (model.provider === 'antigravity') {
    id = id.replace(/-(minimal|low|medium|high|xhigh|max)$/, '');
    name = name.replace(/\s*\((?:minimal|low|medium|high|xhigh|max)(?:[^)]*)\)\s*$/i, '');
  }
  if (model.provider === 'kimi-code' && /-highspeed$/.test(id)) {
    speed = 'fast'; name = name.replace(/\s*High\s*speed$/i, '');
    // kimi-for-coding currently resolves to K2.8, whereas its historical
    // highspeed alias resolves to K2.7: these must never be merged.
    id = id === 'kimi-for-coding-highspeed' ? 'kimi-k2.7-code' : id.replace(/-highspeed$/, '');
  }
  if (model.provider === 'grok-build' && !model.connection && /-build-fast$/.test(id)) {
    speed = 'fast'; id = id.replace(/-build-fast$/, ''); name = name.replace(/\s+(?:Build\s+)?Fast$/i, '');
  }
  if (model.provider === 'muse-code') name = id; // Preserve Full/Contributor; some provider labels omit Full.
  return { id, name, speed };
}
export function groupModels(models) {
  const groups = new Map();
  for (const m of models) {
    const identity = modelIdentity(m), key = `${m.provider}:${m.connection_id || ''}:${identity.id}`;
    let group = groups.get(key);
    if (!group) { group = { id: identity.id, name: identity.name, provider: m.provider, connection_id: m.connection_id, connection_name: m.connection_name, variants: [], hidden: m.hidden === true }; groups.set(key, group); }
    for (const speed of m.speed_options || [identity.speed]) group.variants.push({ ...m, speed,
      service_tier: m.speed_options ? speed : 'standard' });
    if (identity.speed === 'standard') group.name = identity.name;
    group.hidden &&= m.hidden === true;
  }
  return [...groups.values()];
}
export function variantEfforts(variant, mode) {
  return variant.provider === 'prime-agent' && mode === 'off' ? variant.direct_efforts || [] : variant.efforts;
}
export function resolveSelection(group, { speed = 'standard', effort, coding_mode = 'off' } = {}) {
  const variants = group?.variants.filter(v => v.speed === speed) || [];
  return variants.find(v => variantEfforts(v, coding_mode)?.includes(effort)) || null;
}
