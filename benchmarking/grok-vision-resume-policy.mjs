// Grok 1.0.41 may advertise already-allowed MCP catalog keys at resume init.
// They are catalog entries, not additional callable native functions.
import { createGrokBoundaryValidator as originalValidator, grokMazeTools } from './grok/policy.mjs';
export { buildGrokArguments, grokEnvironment, verifyStoredGrokToolCatalog } from './grok/policy.mjs';
export function createGrokBoundaryValidator(options) {
  const validate = originalValidator(options);
  const allowed = new Set(['search_tool', 'use_tool', ...grokMazeTools(options.toolsEnabled)]);
  return event => {
    if (event?.type === 'system' && event.subtype === 'init' && Array.isArray(event.tools) && event.tools.length) {
      if (new Set(event.tools).size !== event.tools.length || event.tools.some(name => !allowed.has(name)) ||
          !event.tools.includes('search_tool') || !event.tools.includes('use_tool')) return 'Unexpected Grok resume tool catalog.';
      // Keep every original check, including OAuth, model, cwd, skills, MCP
      // servers and all actual tool invocations. Raw events are never rewritten.
      return validate({ ...event, tools: ['search_tool', 'use_tool'] });
    }
    return validate(event);
  };
}
