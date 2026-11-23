// Operator lifecycle policy, deliberately independent of provider/model lists.
import { rateLimitDetails } from './run-errors.mjs';
export const ACTIVE_STATES = ['preparing', 'queued', 'running', 'continuing'];
export const finished = run => run.status === 'completed' || ['won', 'action-limit'].includes(run.game_status);
export const runIdentity = run => Object.fromEntries(['id', 'provider', 'world', 'observation_mode', 'model', 'effort', 'coding_mode', 'tools_enabled', 'connection_id', 'service_tier', 'action_limit', 'effective_prompt_sha256'].filter(k => run[k] !== undefined).map(k => [k, run[k]]));
export function failurePolicy(error, now = Date.now()) {
  const text = String(error || '');
  // Never retry through a broken credential, invalid checkpoint, changed tool
  // boundary, or deterministic request/configuration error.
  if (/integrity|signature|checkpoint.*(?:invalid|corrupt)|identity changed|capability.*(?:boundary|changed|violation)|unsafe .*boundary|no resumable|not found|ENOENT|invalid.*(?:api.?key|credential)|unauthori[sz]ed|authentication|permission denied|insufficient[_ ](?:quota|credits|balance)|credit balance|billing|payment required|(?:HTTP|status["':= ]*)\s*(?:400|401|402|403|404|422)\b|unsupported|not supported|invalid (?:request|argument|model)|unknown (?:model|variant)|cannot be resumed/i.test(text)) return { kind: 'blocked' };
  const reset = Date.parse(rateLimitDetails(text)?.reset_at || '');
  const retry = text.match(/retry[-_ ]after["':= ]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)?\b/i);
  const retryMs = retry ? Number(retry[1]) * (/^ms|^millisecond/.test(retry[2] || '') ? 1 : /^m/.test(retry[2] || '') ? 60000 : 1000) : 0;
  const retryAt = Math.max(Number.isFinite(reset) ? reset : 0, retryMs ? now + retryMs : 0);
  if (retryAt || /retryable["'\s:]*true|\b(?:408|425|429|5\d\d)\b|rate[_ -]?limit|too many requests|usage (?:limit|window)|quota.*(?:exceeded|exhausted)|at capacity|overload|temporar(?:y|ily)|service unavailable|network|TRANSPORT:|fetch failed|socket|connection (?:error|reset|closed|refused)|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_|stream.*(?:disconnect|closed|ended|incomplete)|provider.*turn failed|(?:agent|runner|MCP).* (?:exited|stopped|terminated)|original runner is still alive|empty response|no_visible_content/i.test(text)) return { kind: 'transient', retryAt };
  return { kind: 'unknown' };
}
