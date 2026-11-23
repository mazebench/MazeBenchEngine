import { comparisonSeries } from './comparison-report.mjs';
import { parentPort } from "node:worker_threads";
import { readCheckpointJson } from "./v1/checkpoint-json.mjs";
import { isIncremental, verifyJournal, readJournalSummary } from "./storage/journal.mjs";
import { RunLibrary } from "./run-library.mjs";
import { TokenTelemetry } from "./token-telemetry.mjs";
import { RunTelemetry } from "./run-telemetry.mjs";
import { heatmapVisits } from "./ui/heatmap.mjs";
import { iceLevelTimings } from "./ui/ice-level-timings.mjs";
import { loadPricingCache } from './pricing-service.mjs';

const tokens = new TokenTelemetry(), charts = new RunTelemetry(), library = new RunLibrary();
const analyses = new Map();
async function analysis(directory, runnerActive) {
  const snapshot = await library.snapshot(directory);
  const version = library.cache.get(directory).fingerprint;
  const metadata = await readCheckpointJson(directory, "run.json");
  let cached = analyses.get(directory);
  if (cached?.version !== version) {
    const head = isIncremental(directory) ? verifyJournal(directory) : null;
    const summary = head ? await readJournalSummary(directory, head) : await readCheckpointJson(directory, "summary.json");
    const visits = heatmapVisits(summary), counts = new Map();
    let total = 0;
    for (const p of visits.positions) {
      if (!p || !Number.isFinite(p.worldX) || !Number.isFinite(p.worldY)) continue;
      const key = `${p.worldX},${p.worldY}`;
      if (!counts.has(key)) counts.set(key, { worldX: p.worldX, worldY: p.worldY, count: 0 });
      counts.get(key).count++; total++;
    }
    const historyEpoch = head ? `${head.generation}:${head.historyEpoch || head.generation}` : snapshot.history_epoch;
    cached = { version, summary: metadata.world === "ice-maze" ? summary : null,
      value: { action_count: summary.action_count, history_epoch: historyEpoch,
        novelty: summary.novelty || [], heatmap: { points: [...counts.values()], total, current: visits.current, trackedActions: visits.trackedActions } } };
    analyses.set(directory, cached);
    if (analyses.size > 8) analyses.delete(analyses.keys().next().value);
  }
  return { ...cached.value, ice_timing_rows: cached.summary ? iceLevelTimings({ ...metadata, ...cached.summary, runner_active: runnerActive }) : [] };
}

let queue = Promise.resolve();
parentPort.on("message", message => {
  queue = queue.catch(() => {}).then(async () => {
    const { id, directory, kind, runnerActive } = message;
    try {
      if (kind === 'tokens' || kind === 'charts' || kind === 'comparison') await loadPricingCache();
      let value;
      if (kind === "analysis") value = await analysis(directory, runnerActive);
      else if (kind === "tokens") value = await tokens.read(directory);
      else if (kind === "comparison") {
        const usage = await tokens.comparisonUsage(directory).catch(() => ({ records: [], metadata: {}, priceOptions: {}, telemetry: {} }));
        const summary = await readCheckpointJson(directory, 'summary.json');
        const timing = await charts.read(directory).catch(() => null);
        value = { series: comparisonSeries(summary, usage.records, usage.metadata, usage.priceOptions, timing?.thinking.episodes),
          totals: usage.telemetry.totals };
      } else if (kind === "charts") {
        const telemetry = await tokens.read(directory).catch(() => null);
        value = await charts.read(directory, { runnerActive, compactions: telemetry?.compactions || [] });
      } else throw new Error("Unknown report view.");
      parentPort.postMessage({ id, value });
    } catch (error) { parentPort.postMessage({ id, error: String(error.message || error) }); }
  });
});
