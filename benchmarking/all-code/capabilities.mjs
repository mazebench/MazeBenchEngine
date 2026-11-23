import { codingLabel as legacyLabel } from "../coding-mode.mjs";
export { codingMode, CODING_MODES } from '../coding-mode.mjs';
export function supportsAnyLanguage(spec = {}) {
  if ((spec.observation_mode || 'ascii') !== 'ascii') return false;
  const world = spec.world || 'main-world', provider = spec.provider || 'codex';
  if (['codex', 'claude-code'].includes(provider)) return ['main-world', 'ice-maze', 'slotski'].includes(world);
  return world === 'main-world' && ['grok-build', 'antigravity', 'muse-code', 'kimi-code', 'prime-agent'].includes(provider);
}

export const codingLabel = run => run?.coding_mode === "any" ? "Any language" : legacyLabel(run);
