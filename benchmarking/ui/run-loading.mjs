const cacheKey = "mazebench.run-library.v1";
const cacheLifetime = 10 * 60_000;

// Only the small card projection is cached, never transcripts or replay data.
export function cachedRuns() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(cacheKey));
    const age = Date.now() - saved?.at;
    if (age >= 0 && age < cacheLifetime && Array.isArray(saved.runs)
      && saved.runs.every(run => run && typeof run.id === "string")) return saved.runs;
  } catch { /* Storage is optional, including in private browsing. */ }
  return null;
}

export function cacheRuns(runs) {
  try { sessionStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), runs })); }
  catch { /* A full or disabled cache must not prevent fresh cards loading. */ }
}

export async function readRunStream(response, receive) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", complete = false;
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "error") throw new Error(event.error || "Run loading failed.");
    if (event.type === "done") complete = true;
    receive(event);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end;
      while ((end = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
      if (done) break;
    }
    consume(pending);
    if (!complete) throw new Error("Run loading was interrupted.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function loadRunsWithProgress(requestRuns, { signal, progress, partial } = {}) {
  const streamController = new AbortController();
  let total = null, loaded = 0, statusReady = false;
  // One work unit per verified record, plus the live owner-status response.
  const update = () => {
    if (total !== null) progress?.({ loaded, total, statusReady });
  };
  const owner = requestRuns().then(value => {
    if (!Array.isArray(value.runs)) throw new Error("The run list could not be loaded. Refresh to try again.");
    statusReady = true; update(); return { value };
  }).catch(error => ({ error }));
  const saved = [];
  const streaming = (async () => { try {
    const response = await fetch(`http://${location.hostname}:8085/api/benchmark/playback/library`, {
      signal: signal ? AbortSignal.any([signal, streamController.signal]) : streamController.signal,
    });
    if (response.ok && response.headers.get("content-type")?.includes("application/x-ndjson")) {
      await readRunStream(response, event => {
        if (Number.isSafeInteger(event.total) && Number.isSafeInteger(event.loaded)) {
          total = event.total; loaded = event.loaded; update();
        }
        if (event.run) {
          saved.push(event.run);
          // Paint in small batches without rebuilding the list for every record.
          if (saved.length === 1 || saved.length % 8 === 0) partial?.([...saved]);
        }
        if (event.type === "done" && saved.length) partial?.([...saved]);
      });
    }
  } catch { /* Older/offline report services still load through the authoritative owner. */ } })();
  const result = await owner;
  // The owner's complete response is sufficient. Never delay ready cards for
  // the optional streaming reader (or leave a second scan running afterward).
  streamController.abort();
  await streaming;
  if (result.error) throw result.error;
  return result.value;
}

export function setupRunLoading(container) {
  const indicator = document.createElement("div");
  indicator.className = "run-loading";
  indicator.hidden = true;
  indicator.innerHTML = '<span class="run-loading-label" role="status"></span><div class="run-loading-track" role="progressbar" aria-label="Loading runs" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><span class="run-loading-percent" aria-hidden="true">0%</span>';
  container.before(indicator);
  container.querySelector(".empty-copy")?.remove();
  const label = indicator.querySelector(".run-loading-label");
  const track = indicator.querySelector(".run-loading-track");
  const percent = indicator.querySelector(".run-loading-percent");
  let loadingLabel = "Loading runs…";
  const setProgress = value => {
    const amount = Math.max(0, Math.min(100, Math.floor(value)));
    track.setAttribute("aria-valuenow", String(amount));
    track.firstElementChild.style.width = `${amount}%`;
    percent.textContent = `${amount}%`;
  };
  let timer;
  return {
    start({ initial = false, cached = false } = {}) {
      clearTimeout(timer);
      container.setAttribute("aria-busy", "true");
      indicator.dataset.state = "loading";
      setProgress(0);
      loadingLabel = initial ? "Loading runs…" : cached ? "Updating saved runs…" : "Updating runs…";
      label.textContent = loadingLabel;
      track.setAttribute("aria-label", loadingLabel);
      track.removeAttribute("aria-valuetext");
      // Avoid flashing a bar for every fast background poll.
      if (initial || cached) indicator.hidden = false;
      else timer = setTimeout(() => { indicator.hidden = false; }, 350);
    },
    progress({ loaded, total, statusReady }) {
      setProgress((loaded + Number(statusReady)) / (total + 1) * 100);
      label.textContent = loaded === total && !statusReady ? "Checking live status…" : loadingLabel;
      track.setAttribute("aria-valuetext", `${loaded} of ${total} records read${statusReady ? ", live status loaded" : ", checking live status"}`);
    },
    finish({ error = false, hasRuns = false } = {}) {
      clearTimeout(timer);
      container.setAttribute("aria-busy", "false");
      if (error) {
        indicator.dataset.state = "error";
        indicator.hidden = !hasRuns;
        label.textContent = "Refresh failed. Showing saved runs.";
        return;
      }
      indicator.dataset.state = "complete";
      setProgress(100);
      label.textContent = "Runs loaded";
      timer = setTimeout(() => { indicator.hidden = true; }, 200);
    }
  };
}
