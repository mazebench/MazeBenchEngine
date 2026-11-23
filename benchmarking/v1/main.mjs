const elements = Object.fromEntries([
  "connection-status", "launch-form", "model", "effort", "action-limit",
  "tools-enabled", "tools-label", "launch-single", "launch-pair",
  "launch-status", "refresh", "run-list", "record-count", "codex-version", "codex-update-status", "check-codex"
].map((id) => [id, document.getElementById(id)]));

let models = [];
let polling = false;
let launching = false;
let codexReady = false;

async function checkCodex(force = false) {
  elements["check-codex"].disabled = true;
  try {
    const status = await api(`/api/benchmark/v1/status${force ? "?force=1" : ""}`);
    codexReady = status.available && status.tested;
    elements["codex-version"].textContent = status.version || "Codex unavailable";
    const labels = {
      "up-to-date": "Up to date",
      "update-available": `Update available: ${status.latest_version}. Run codex update, then restart the benchmark server.`,
      "newer-than-release": "Installed version is newer than the current stable release",
      unknown: "Could not check the latest release"
    };
    elements["codex-update-status"].textContent = `${labels[status.update_status] || "Unknown version"} · ${status.tested ? "Benchmark checks supported" : "Launch blocked: this version needs benchmark validation"}${status.error ? ` · ${status.error}` : ""}`;
    elements["codex-version"].title = status.executable || "";
  } catch (error) {
    codexReady = false;
    elements["codex-update-status"].textContent = error.message;
  } finally {
    elements["check-codex"].disabled = false;
    elements["launch-single"].disabled = launching || !codexReady;
    elements["launch-pair"].disabled = launching || !codexReady;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

function statusLabel(value) {
  return String(value || "unknown").replaceAll("-", " ");
}

function compactDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function duration(run) {
  if (!run.created_at) return "";
  const end = run.completed_at || run.stopped_at || Date.now();
  const seconds = Math.max(0, Math.floor((new Date(end) - new Date(run.created_at)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function recordHref(run) {
  return `./run.html?id=${encodeURIComponent(run.id)}`;
}

function renderRuns(runs) {
  elements["run-list"].replaceChildren();
  elements["record-count"].textContent = `${runs.length} record${runs.length === 1 ? "" : "s"}`;
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "records-empty";
    empty.innerHTML = "<strong>No evaluations yet</strong><p>Launch a model above. Its record will appear here immediately.</p>";
    elements["run-list"].append(empty);
    return;
  }
  for (const run of runs) {
    const card = document.createElement("article");
    card.className = `record-card${run.tools_enabled ? " tools" : ""}`;
    const link = document.createElement("a");
    link.className = "record-card-link";
    link.href = recordHref(run);
    const progress = run.action_limit
      ? Math.min(100, (run.action_count || 0) / run.action_limit * 100)
      : run.status === "completed" ? 100 : 0;

    const top = document.createElement("div");
    top.className = "record-top";
    const condition = document.createElement("span");
    condition.className = "condition";
    condition.textContent = run.tools_enabled ? "Python on" : "Python off";
    const recordStatus = document.createElement("span");
    recordStatus.className = `record-status ${run.status}`;
    recordStatus.textContent = statusLabel(run.status);
    top.append(condition, recordStatus);

    const model = document.createElement("strong");
    model.className = "record-model";
    model.textContent = run.model;
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = `${run.effort} reasoning · ${compactDate(run.created_at)} · ${duration(run)}`;

    const progressBar = document.createElement("span");
    progressBar.className = "run-progress";
    const progressValue = document.createElement("i");
    progressValue.style.width = `${progress}%`;
    progressBar.append(progressValue);

    const metrics = document.createElement("div");
    metrics.className = "record-metrics";
    const values = [
      ["Actions", `${run.action_count || 0}${run.action_limit ? `/${run.action_limit}` : ""}`],
      ["Gems", run.gems_collected || 0],
      ["Rooms", run.rooms_visited || 1],
      ["Cells", run.unique_cells || 1]
    ];
    for (const [label, value] of values) {
      const metric = document.createElement("span");
      const name = document.createElement("small");
      const output = document.createElement("b");
      name.textContent = label;
      output.textContent = value;
      metric.append(name, output);
      metrics.append(metric);
    }

    const footer = document.createElement("div");
    footer.className = "record-footer";
    const runId = document.createElement("code");
    runId.textContent = run.id.slice(-13);
    const footerActions = document.createElement("div");
    footerActions.className = "record-footer-actions";
    const open = document.createElement("a");
    open.href = recordHref(run);
    open.textContent = "Open model report →";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "record-delete danger";
    remove.dataset.deleteRun = run.id;
    remove.textContent = "Delete";
    remove.disabled = Boolean(run.runner_active);
    remove.title = run.runner_active
      ? "Stop or pause this run before deleting it."
      : "Permanently delete this run.";
    footerActions.append(open, remove);
    footer.append(runId, footerActions);
    link.append(top, model, meta, progressBar, metrics);
    card.append(link, footer);
    elements["run-list"].append(card);
  }
}

function updateEfforts() {
  const selected = models.find((model) => model.id === elements.model.value) || models[0];
  elements.effort.replaceChildren();
  for (const effort of selected?.efforts || ["medium"]) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effort;
    option.selected = effort === selected.default_effort;
    elements.effort.append(option);
  }
}

async function loadModels() {
  const catalog = await api("/api/benchmark/v1/models");
  models = catalog.models;
  elements.model.replaceChildren();
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name;
    option.selected = model.id === catalog.default_model;
    elements.model.append(option);
  }
  updateEfforts();
  if (!catalog.codex_available) throw new Error("No locally authenticated Codex model catalog was found.");
}

function launchPayload(toolsEnabled = elements["tools-enabled"].checked) {
  return {
    model: elements.model.value,
    effort: elements.effort.value,
    tools_enabled: toolsEnabled,
    action_limit: elements["action-limit"].value === "unlimited"
      ? null
      : Number(elements["action-limit"].value),
    start_room: "HxI"
  };
}

function setLaunching(active, message) {
  launching = active;
  elements["launch-single"].disabled = active || !codexReady;
  elements["launch-pair"].disabled = active || !codexReady;
  elements["launch-status"].textContent = message;
}

async function launchSingle(event) {
  event.preventDefault();
  setLaunching(true, "Preparing the game and checking the isolation boundary…");
  try {
    const run = await api("/api/benchmark/v1/runs", {
      method: "POST",
      body: JSON.stringify(launchPayload())
    });
    await refreshRuns();
    setLaunching(false, `Launched ${run.model}. Its live record is ready below.`);
  } catch (error) {
    setLaunching(false, error.message);
  }
}

async function launchPair() {
  if (elements["action-limit"].value === "unlimited") elements["action-limit"].value = "100";
  setLaunching(true, "Preflighting Python isolation, then starting both conditions…");
  try {
    await api("/api/benchmark/v1/pairs", {
      method: "POST",
      body: JSON.stringify(launchPayload(false))
    });
    await refreshRuns();
    setLaunching(false, "Matched pair launched. Open either record to watch its model report.");
  } catch (error) {
    setLaunching(false, error.message);
  }
}

async function refreshRuns() {
  const value = await api("/api/benchmark/v1/runs");
  renderRuns(value.runs);
}

function showError(error) {
  elements["connection-status"].textContent = error.message;
  elements["connection-status"].classList.add("error");
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await refreshRuns();
    elements["connection-status"].textContent = "local supervisor online";
    elements["connection-status"].classList.remove("error");
  } catch (error) {
    showError(error);
  } finally {
    polling = false;
  }
}

elements["launch-form"].addEventListener("submit", launchSingle);
elements["check-codex"].addEventListener("click", () => checkCodex(true));
elements["launch-pair"].addEventListener("click", launchPair);
elements.refresh.addEventListener("click", () => poll());
elements["run-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-run]");
  if (!button || button.disabled) return;
  const id = button.dataset.deleteRun;
  const run = (await api("/api/benchmark/v1/runs")).runs.find((entry) => entry.id === id);
  if (!run) return poll();
  const confirmed = window.confirm(
    `Permanently delete ${run.model} run ${run.id}?\n\nThis removes its record, workspace, replay, and interview chats. This cannot be undone.`
  );
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
    await poll();
  } catch (error) {
    button.disabled = false;
    showError(error);
  }
});
elements.model.addEventListener("change", updateEfforts);
elements["tools-enabled"].addEventListener("change", () => {
  elements["tools-label"].textContent = elements["tools-enabled"].checked ? "On" : "Off";
});

try {
  setLaunching(false, elements["launch-status"].textContent);
  await Promise.all([loadModels(), checkCodex()]);
  await poll();
  setInterval(poll, 2000);
  setInterval(() => checkCodex(), 15 * 60_000);
} catch (error) {
  showError(error);
  elements["launch-status"].textContent = error.message;
}
