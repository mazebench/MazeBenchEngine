// One cancellable display-clock loop; the engine is never stepped from here.
export function playTimeline(timeline, update, {
  signal, requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
  now = () => performance.now(), finish = () => false
} = {}) {
  return new Promise((resolve, reject) => {
    let frame = null, done = false;
    const start = now();
    const settle = (result, error) => {
      if (done) return;
      done = true;
      if (frame !== null) cancelFrame(frame);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => settle(false);
    const tick = time => {
      if (signal?.aborted) return abort();
      try {
        const elapsed = finish() ? timeline.duration : Math.min(timeline.duration, Math.max(0, time - start));
        update(elapsed);
        if (elapsed >= timeline.duration) settle(true);
        else frame = requestFrame(tick);
      } catch (error) { settle(false, error); }
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    tick(start);
  });
}
