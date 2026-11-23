// Estimate the current import stage. Downloads, physics and drawing have
// different costs, so never carry one stage's throughput into another.
export class ImportEstimate {
  reset() { this.stage = null; }

  update(done, total, phase, now) {
    // Browser-world progress reserves slices of its overall loading bar.
    if (phase === "Loading rooms") total = 50;
    else if (phase === "Loading models") { done -= 50; total = 15; }
    const previous = this.stage;
    if (!previous || previous.phase !== phase || previous.total !== total || done < previous.done) {
      this.stage = { phase, total, done, baseline: done, started: now };
    } else previous.done = done;
  }

  label(now) {
    const stage = this.stage;
    if (!stage) return "Estimating time…";
    if (stage.phase === "Ready") return "0:00 remaining";
    const { done, total, baseline, started } = stage;
    if (done >= total) return "Finishing…";
    const elapsed = Math.max(0, now - started), completed = done - baseline;
    if (elapsed < 300 || completed <= 0) return "Estimating time…";
    const seconds = Math.max(1, Math.ceil(elapsed * (total - done) / completed / 1000));
    return `~${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} remaining in this step`;
  }
}
