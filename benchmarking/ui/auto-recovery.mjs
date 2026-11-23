export function recoveryPresentation(run) {
  const recovery = run.auto_recovery;
  const waiting = Boolean(recovery?.enabled && ['waiting', 'retrying'].includes(recovery.state));
  const blocked = recovery?.state === 'blocked';
  const date = recovery?.next_retry_at && new Date(recovery.next_retry_at);
  return { waiting, blocked,
    label: waiting ? 'Auto-resuming' : blocked ? 'Needs attention' : null,
    detail: waiting ? `Automatic retry ${recovery.max_attempts ? Math.min(recovery.attempts + (recovery.state === 'waiting' ? 1 : 0), recovery.max_attempts) : recovery.attempts + (recovery.state === 'waiting' ? 1 : 0)}${recovery.max_attempts ? ` of ${recovery.max_attempts}` : ''}${date ? ` at ${date.toLocaleTimeString()}` : ' in progress'}. ${recovery.reason || ''}`
      : blocked ? recovery.reason : null };
}
