import { codingLabel as previousLabel } from './all-code/capabilities.mjs';
export { codingMode, CODING_MODES, supportsAnyLanguage } from './all-code/capabilities.mjs';
export const isPrimeDirect = run => run?.provider === 'prime-agent' && ['prime-inference-direct-v1', 'prime-inference-direct-v2'].includes(run?.harness);
export const codingLabel = run => isPrimeDirect(run) || (run?.provider === 'prime-agent' && run?.coding_mode === 'off') ? 'Python off' : previousLabel(run);
