import { benchmarkFetch } from "./benchmark-api.mjs";
import { displayModelName } from "./heatmap-comparison.mjs";
import { heatmapTimeline, animationExtent } from "./heatmap-timeline.mjs";

export function createHeatmapGifExport({ selection, onExit, onResize }) {
  const toolbar = document.createElement("aside");
  toolbar.className = "heatmap-export"; toolbar.hidden = true;
  toolbar.setAttribute("aria-label", "Heatmap GIF export");
  toolbar.innerHTML = `
    <div class="heatmap-export-controls">
      <label>Timeline <select aria-label="GIF timeline"><option value="moves">Moves</option><option value="elapsed">Elapsed time</option></select></label>
      <label>Length <select aria-label="GIF length"><option value="5">5 seconds</option><option value="10" selected>10 seconds</option><option value="20">20 seconds</option><option value="30">30 seconds</option></select></label>
      <button type="button" class="gif-start">Export GIF</button>
      <button type="button" class="gif-cancel" hidden>Cancel export</button>
      <a class="gif-download" hidden>Download GIF</a>
      <button type="button" class="gif-exit">Done</button>
    </div>
    <p class="gif-note"></p><output class="gif-status" role="status" aria-live="polite"></output>`;
  document.body.append(toolbar);
  const mode = toolbar.querySelector('[aria-label="GIF timeline"]'), length = toolbar.querySelector('[aria-label="GIF length"]');
  const start = toolbar.querySelector(".gif-start"), cancel = toolbar.querySelector(".gif-cancel");
  const download = toolbar.querySelector(".gif-download"), status = toolbar.querySelector(".gif-status"), note = toolbar.querySelector(".gif-note");
  let job = null, objectURL = null;
  const setBusy = active => {
    mode.disabled = length.disabled = start.disabled = active;
    cancel.hidden = !active; toolbar.setAttribute("aria-busy", String(active));
  };
  const clearDownload = () => {
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = null; download.hidden = true; download.removeAttribute("href");
  };
  const cancelExport = () => {
    if (!job) return;
    job.controller.abort(); job.worker?.terminate(); job = null;
    setBusy(false); status.textContent = "Export cancelled.";
  };
  toolbar.addEventListener("pointerdown", event => event.stopPropagation());
  cancel.addEventListener("click", cancelExport);
  toolbar.querySelector(".gif-exit").addEventListener("click", onExit);
  start.addEventListener("click", async () => {
    if (job) return;
    clearDownload();
    const current = { controller: new AbortController(), worker: null }; job = current;
    setBusy(true); status.classList.remove("error");
    try {
      if (!window.Worker || !window.OffscreenCanvas) throw new Error("GIF export needs a browser with OffscreenCanvas support.");
      const { panels, scale } = selection(), timelines = [], loaded = new Map();
      if (!panels.length || panels.some(p => !p.run || !p.map)) throw new Error("Load the selected heatmaps before exporting.");
      for (const [i, { run, map, actions, name }] of panels.entries()) {
        status.textContent = `Loading movement history ${i + 1} of ${panels.length}…`;
        let timeline = loaded.get(run.id);
        if (!timeline) {
          if (run.source) timeline = { snapshot: true, finalMap: map, moveCount: actions };
          else {
            // Fetch one consistent, complete history per run. Rendering and
            // encoding are local; these reads never pause or mutate a runner.
            const response = await benchmarkFetch(`/api/benchmark/v1/runs/${encodeURIComponent(run.id)}`, {
              signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(60000)]), cache: "no-store",
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error || `History request failed (${response.status}).`);
            timeline = heatmapTimeline(value);
          }
          loaded.set(run.id, timeline);
        }
        if (job !== current) return;
        timelines.push({ ...timeline, name: name || displayModelName(run.model) });
      }
      animationExtent(timelines, mode.value);
      const worker = new Worker(new URL("./heatmap-gif-worker.mjs", import.meta.url), { type: "module" });
      current.worker = worker;
      const fail = message => {
        if (job !== current) return;
        worker.terminate(); job = null; setBusy(false);
        status.classList.add("error"); status.textContent = `Couldn’t export GIF. ${message}`;
      };
      worker.onerror = event => { event.preventDefault(); fail(event.message || "The encoder could not be loaded. Try again."); };
      worker.onmessage = ({ data }) => {
        if (job !== current) return;
        if (data.type === "progress") status.textContent = `Creating GIF… ${data.percent}%`;
        else if (data.type === "error") fail(data.message);
        else if (data.type === "done") {
          worker.terminate(); job = null; setBusy(false);
          const blob = new Blob([data.bytes], { type: "image/gif" });
          objectURL = URL.createObjectURL(blob); download.href = objectURL;
          download.download = `mazebench-heatmaps-${mode.value}-${new Date().toISOString().replace(/[:.]/g, "-")}.gif`;
          download.hidden = false;
          status.textContent = `GIF ready · ${(blob.size / 1024 / 1024).toFixed(1)} MB · loops with a 2-second final hold.`;
          download.click();
        }
      };
      status.textContent = "Creating GIF… 0%";
      worker.postMessage({ panels: timelines, mode: mode.value, seconds: Number(length.value), scale });
    } catch (error) {
      if (job !== current) return;
      current.worker?.terminate(); job = null; setBusy(false);
      status.classList.add("error"); status.textContent = `Couldn’t export GIF. ${error.message}`;
    }
  });
  window.addEventListener("pagehide", () => { cancelExport(); clearDownload(); });
  const height = () => toolbar.hidden ? 0 : toolbar.offsetHeight + 32;
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--heatmap-export-space", `${height()}px`);
    onResize();
  }).observe(toolbar);
  return {
    height,
    setVisible(visible) {
      toolbar.hidden = !visible;
      if (!visible) { cancelExport(); clearDownload(); return; }
      status.textContent = ""; status.classList.remove("error");
      const imported = selection().panels.filter(p => p.run?.source).length;
      note.textContent = "Click a name to edit · Esc to exit" + (imported ? " · Imported maps stay static in GIFs" : "");
      start.disabled = imported === selection().panels.length;
    },
  };
}
