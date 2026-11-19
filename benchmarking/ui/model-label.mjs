import { modelIdentity } from '../model-catalog/normalize.mjs';
// Presentation never rewrites the exact provider ID pinned in run.json.
export function modelSlug(model, fallback = model) {
  if (/^deepseek-/i.test(String(model || ''))) return String(model);
  const slug = String(model || fallback || '').trim().toLowerCase().split('/').at(-1)
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (['k3', 'kimi-k3'].includes(slug)) return 'kimi-k3';
  if (slug === 'k3-256k') return 'kimi-k3-256k';
  if (/^(?:kimi-)?k3\.1-pro(?:-highspeed)?$/.test(slug)) return 'kimi-k3.1-pro';
  if (slug === 'kimi-for-coding') return 'kimi-k2.8-preview';
  if (slug === 'kimi-for-coding-highspeed') return 'kimi-k2.7-code';
  return modelGroupId(slug);
}

export function modelLabel(model, fallback = model) {
  if (/^deepseek-/i.test(String(model || ''))) return String(model);
  if (["kimi/k3", "moonshotai/kimi-k3", "kimi-k3", "k3"].includes(model)) return "Kimi K3";
  if (model === 'k3-256k') return 'Kimi K3 · 256K';
  if (/^k3\.1-pro(?:-highspeed)?$/.test(model)) return 'Kimi K3.1 Pro';
  if (model === 'kimi-for-coding') return 'Kimi K2.8 Preview';
  if (model === 'kimi-for-coding-highspeed') return 'Kimi K2.7 Code';
  const provider = /^(?:gemini-|claude-|gpt-oss-).+-(?:minimal|low|medium|high|xhigh|max)$/.test(model) ? 'antigravity' : /^grok-/.test(model) ? 'grok-build' : '';
  return modelIdentity({ id: model || '', name: fallback || model, provider }).name
    .replace(provider === 'antigravity' ? /-(minimal|low|medium|high|xhigh|max)$/ : /$^/, '')
    .replace(provider === 'grok-build' ? /-build-fast$/ : /$^/, '');
}
export function modelOptionLabel(model) {
  if (model.provider === 'deepseek-harness' || model.connection_id) return (model.name && model.name !== model.id ? `${model.id} · ${model.name}` : model.id) +
    (model.billing_source === 'chatgpt-plan' || model.variants?.some(v => v.billing_source === 'chatgpt-plan') ? ' · ChatGPT plan' : '');
  return modelSlug(model.id);
}
export const modelSpeed = run => run.service_tier === 'fast' || /(?:-highspeed|-build-fast)$/.test(run.model || '') ? 'fast' : 'standard';

export function modelGroupId(model) {
  if (['k3', 'kimi/k3', 'moonshotai/kimi-k3', 'kimi-k3'].includes(model)) return 'kimi-k3';
  return String(model || '').replace(/^(k3\.1-pro)-highspeed$/, '$1').replace(/^(grok-.+)-build-fast$/, '$1')
    .replace(/^((?:gemini-|claude-|gpt-oss-).+)-(minimal|low|medium|high|xhigh|max)$/, '$1');
}
