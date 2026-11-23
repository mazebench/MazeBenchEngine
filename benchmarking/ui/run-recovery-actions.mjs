import { isPrimeDirect } from '../capabilities.mjs';
import { rateLimitDetails } from '../run-errors.mjs';
import { recoveryPresentation } from './auto-recovery.mjs';

export function runRecoveryActions(run, now = Date.now()) {
  const rateLimit = run.status === 'failed' ? run.rate_limit || rateLimitDetails(run.error) : null;
  const waiting = recoveryPresentation(run).waiting;
  const terminal = ['won', 'action-limit'].includes(run.game_status);
  const boundary = Boolean(run.capability_boundary_verified)
    && (run.provider !== 'prime-agent' || isPrimeDirect(run) || run.runner_active);
  const resumable = ['paused', 'stopped', 'interrupted'].includes(run.status) || run.compaction_recoverable
    || (run.status === 'failed' && (rateLimit || run.world === 'slotski' || isPrimeDirect(run)));
  const resumeVisible = Boolean(!terminal && !run.runner_active && boundary && !waiting && resumable);
  const reset = Date.parse(rateLimit?.reset_at);
  const resumeAt = Number.isFinite(reset) && reset > now ? reset : null;
  return {
    rateLimit, resumeVisible, resumeDisabled: !resumeVisible || resumeAt !== null, resumeAt,
    // A quota failure is never a reason to replace the existing benchmark.
    failureAction: waiting ? null : rateLimit ? (resumeVisible ? 'resume' : null) : 'new'
  };
}
