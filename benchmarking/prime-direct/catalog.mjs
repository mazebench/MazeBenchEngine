import { credentials } from '../prime/policy.mjs';

const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function directModel(model) {
  if (!model.supported_parameters?.includes('tools')) return null;
  const efforts = ORDER.filter(e => model.reasoning?.supported_efforts?.includes(e));
  if (!efforts.length && model.specs?.supports_reasoning) efforts.push('enabled');
  if (!efforts.length) efforts.push('default');
  return { id: model.id, name: model.display_name || model.id, provider: 'prime-agent',
    efforts, default_effort: efforts.at(-1), pricing: model.pricing,
    context_window: model.specs?.context_window || model.context_window,
    max_output_tokens: model.specs?.max_output_tokens || model.max_output_tokens,
    parameters: model.supported_parameters };
}
export function samplingFor(model, effort = model.default_effort) {
  if (!model.efforts.includes(effort)) throw new Error('Reasoning effort is not advertised for this Prime model.');
  const sampling = { max_tokens: Math.min(model.max_output_tokens || 32768, 131072, Math.floor((model.context_window || 131072) / 4)) };
  if (effort !== 'default') {
    sampling.reasoning = effort === 'none' ? { enabled: false } : { enabled: true, ...(effort === 'enabled' ? {} : { effort }) };
    if (effort !== 'enabled' && model.parameters.includes('reasoning_effort')) sampling.reasoning_effort = effort;
  }
  return sampling;
}
export async function fetchCatalog() {
  const { key, team } = await credentials();
  const response = await fetch('https://api.pinference.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${key}`, ...(team ? { 'X-Prime-Team-ID': team } : {}) }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Prime catalog returned HTTP ${response.status}.`);
  return (await response.json()).data.map(directModel).filter(Boolean);
}
