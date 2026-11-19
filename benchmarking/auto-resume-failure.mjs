import path from 'node:path';
import { readJsonLinesTail } from './storage/tail-jsonl.mjs';
import { runDirectory, directoryFor } from './auto-resume-owner.mjs';
import { isRejectedMcpError, REJECTED_MCP_REPAIR, rejectedMcpCandidate } from './recover-antigravity-rejected-call.mjs';
import { STARTUP_ERROR, STARTUP_REPAIR, antigravityStartupCandidate } from './recover-antigravity-startup.mjs';
import { needsClaudeUsageRecovery } from './recover-claude-usage-report.mjs';
// Older immutable DeepSeek runners sometimes saved only a generic failure.
// Read the structured error from that same terminal turn, never a stale turn.
export async function recoveryFailure(run, { directory = runDirectory(run.id), tail = readJsonLinesTail } = {}) {
  if (needsClaudeUsageRecovery(run)) {
    directory = await directoryFor(run, directory).catch(() => null);
    const events = directory ? await tail(path.join(directory, 'claude-events.jsonl'), 64) : [];
    const end = events.at(-1);
    const limit = events.findLast(e => e.type === 'rate_limit_event' && e._turn_id === end?._turn_id);
    const reset = limit?.rate_limit_info?.resetsAt;
    if (end?.type === 'result' && end.is_error === true && end._turn_id &&
        Number.isFinite(Date.parse(run.completed_at)) && Math.abs(Date.parse(end._received_at) - Date.parse(run.completed_at)) < 30000 &&
        limit?.rate_limit_info?.status === 'rejected' && Number.isSafeInteger(reset) && reset > 0 && reset < 8640000000000 &&
        limit.session_id === end.session_id && Date.parse(limit._received_at) <= Date.parse(end._received_at) &&
        Date.parse(end._received_at) - Date.parse(limit._received_at) < 30000)
      return { ...run, recovery_error: `Claude usage limit reached; resets at ${new Date(reset * 1000).toISOString()}.` };
  }
  if (run.provider === 'antigravity' && run.status === 'failed' && run.error === STARTUP_ERROR) {
    directory = await directoryFor(run, directory).catch(() => null);
    const evidence = directory && await antigravityStartupCandidate(directory);
    if (evidence) return { ...run, recovery_repair: STARTUP_REPAIR,
      recovery_error: evidence.provider_error === 'authentication failed or timed out'
        ? 'Provider startup failed before initialization; no model or tool activity occurred.'
        : 'Temporary network failure before provider initialization; no model or tool activity occurred.' };
  }
  if (run.provider === 'antigravity' && run.status === 'failed' && isRejectedMcpError(run.error)) {
    directory = await directoryFor(run, directory).catch(() => null);
    if (directory && await rejectedMcpCandidate(directory)) return { ...run, recovery_repair: REJECTED_MCP_REPAIR,
      recovery_error: 'Antigravity rejected an incorrectly routed MCP call before execution; audited same-session recovery is available.' };
  }
  if (run.status !== 'failed' || run.provider !== 'deepseek-harness' || run.error !== 'DeepSeek Harness could not complete the turn. See the run’s private agent-stderr.log.' || !directory) return run;
  const events = await tail(path.join(directory, 'deepseek-events.jsonl'), 16);
  const end = events.findLast(e => e.type === 'status' && e.phase === 'turn_end');
  const detail = end?.reason?.error;
  if (!detail?.message || end.reason.kind !== 'error' || !end._turn_id ||
      !Number.isFinite(Date.parse(run.completed_at)) || Math.abs(Date.parse(end._received_at) - Date.parse(run.completed_at)) > 30000 ||
      events.some(e => e.type === 'status' && e.phase === 'turn_start' && e._turn_id !== end._turn_id && Date.parse(e._received_at) > Date.parse(end._received_at))) return run;
  return { ...run, recovery_error: `${detail.code ? detail.code + ': ' : ''}${detail.message}${Number.isInteger(detail.status) ? ' (HTTP ' + detail.status + ')' : ''}` };
}
