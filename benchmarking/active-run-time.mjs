// Presentation-only clock. Original timestamps remain available for billing,
// audit records and wall-clock tooltips. Silence alone is never a pause.
export const createActivityClock = () => ({ gaps: [], active: false, last: null, stopped: null, group: null, boundaries: 0 });
const time = value => typeof value === 'number' ? value : Date.parse(value);
function begin(clock, at, restart = false) {
  if (restart && clock.active && clock.last != null && at > clock.last) {
    // A killed process may never emit a terminal event. Its next process ID
    // proves an interruption; the last observed activity bounds the old turn.
    clock.gaps.push({ start: clock.last, end: at, inferred: true });
  } else if (!clock.active && clock.stopped != null && at > clock.stopped) {
    clock.gaps.push({ start: clock.stopped, end: at });
  }
  clock.active = true; clock.stopped = null; clock.boundaries++;
}
function stop(clock, at) { clock.active = false; clock.stopped ??= at; clock.boundaries++; }

export function consumeActivityEvent(clock, event, { provider, harness } = {}) {
  const at = time(event._received_at || event.timestamp || event.at);
  if (!Number.isFinite(at) || clock.last != null && at < clock.last) return;
  const type = event.type || event.msg?.type || event.event;
  const directPrime = provider === 'prime-agent' && /prime-inference-direct/.test(harness || '');
  const group = event._turn_id;
  const groupChanged = group && group !== clock.group;
  const explicitStart = type === 'thread.started' || type === 'init' || type === 'system' && event.subtype === 'init' || type === 'system.version';
  if (groupChanged || explicitStart) {
    begin(clock, at, clock.active); clock.group = group || clock.group;
  } else if (type === 'turn.started' && !clock.active) begin(clock, at);
  // Prime direct emits turn.completed for *each request*, not process exit.
  // Its downtime comes from the owning server's recovery journal instead.
  if (!directPrime && (['turn.failed', 'turn.completed', 'result', 'session.resume_hint'].includes(type))) stop(clock, at);
  if (provider === 'deepseek-harness') {
    if (type === 'status' && event.phase === 'turn_start' && !clock.active) begin(clock, at);
    if (type === 'final' || type === 'error' || type === 'status' && event.phase === 'turn_end') stop(clock, at);
  }
  if (provider === 'muse-code') {
    const detail = event.payload?.event || event.payload || {};
    const recorded = Number.isFinite(event.recorded_at) ? event.recorded_at / 1000 : at;
    // On resume Muse can replay old events. A replayed terminal record is not
    // the termination of the new process (receipt time is much later).
    if (detail.kind === 'run_terminal' && Math.abs(recorded - at) < 1000) stop(clock, at);
  }
  if (type === 'turn.step.retrying' && Number.isFinite(event.delay_ms) && event.delay_ms > 0)
    clock.gaps.push({ start: at, end: at + event.delay_ms });
  clock.last = at;
}

export function consumeRecoveryEvent(clock, event) {
  const at = time(event.at);
  if (!Number.isFinite(at) || clock.last != null && at < clock.last) return;
  if (['retry-scheduled', 'blocked', 'needs-attention', 'operator-paused', 'operator-pause', 'operator-stop', 'completed'].includes(event.event)) stop(clock, at);
  if (['resumed', 'enabled', 'enrolled'].includes(event.event)) begin(clock, at);
  clock.last = at;
}

export function activeTimeReport(value, clocks) {
  const samples = value.samples || [], timestamps = samples.map(sample => sample.timestamp).filter(Number.isFinite).sort((a,b) => a-b);
  if (!timestamps.length) return value;
  const start = timestamps[0], end = timestamps.at(-1);
  const upperBound = at => {
    let lo = 0, hi = timestamps.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (timestamps[mid] < at) lo = mid + 1; else hi = mid; }
    return timestamps[lo - 1];
  };
  const gaps = clocks.flatMap(clock => [...clock.gaps, ...(!clock.active && clock.stopped != null ? [{ start: clock.stopped, end }] : [])])
    .map(gap => ({ ...gap, start: Math.max(start, gap.start, gap.inferred ? upperBound(gap.end) ?? start : start), end: Math.min(end, gap.end) }))
    .filter(gap => gap.end > gap.start).sort((a,b) => a.start - b.start);
  const merged = [];
  for (const gap of gaps) {
    const prior = merged.at(-1);
    if (prior && gap.start <= prior.end) { prior.end = Math.max(prior.end, gap.end); prior.inferred ||= gap.inferred; }
    else merged.push({ ...gap });
  }
  const elapsed = at => {
    let removed = 0;
    for (const gap of merged) { if (gap.start >= at) break; removed += Math.min(at, gap.end) - gap.start; }
    return Math.max(0, at - start - removed);
  };
  const active = clocks.some(clock => clock.boundaries);
  return { ...value,
    samples: samples.map(sample => ({ ...sample, active_ms: elapsed(sample.timestamp) })),
    compactions: (value.compactions || []).map(event => ({ ...event, active_ms: elapsed(event.timestamp) })),
    time_axis: { kind: active ? 'active' : 'elapsed', active_ms: elapsed(end), elapsed_ms: end - start,
      excluded_ms: end - start - elapsed(end), interruption_count: merged.length,
      inferred_interruptions: merged.filter(gap => gap.inferred).length,
      basis: active ? 'Recorded stops, failures, restarts and retry waits are excluded. Unlogged exits are bounded by the last observed activity before restart. Active thinking and tool execution remain included.'
        : 'This historical harness did not record start/stop boundaries. Unverified gaps are retained rather than guessing from silence.' }
  };
}
