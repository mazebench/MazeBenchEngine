import { setupCurrentVersionBadge } from '../../ui/current-version.mjs';
import { groupModels, sortedEfforts, variantEfforts, resolveSelection } from "../model-catalog/normalize.mjs";
import { supportsAnyLanguage } from "../capabilities.mjs";
import { benchmarkFetch, visionAvailable, visionUrl } from "./benchmark-api.mjs";
import { RunListView, providerName, runCompany, selectRuns, isActiveRun } from "./run-library.mjs";
import { modelLabel, modelOptionLabel, modelGroupId } from "./model-label.mjs";
import { setupLauncherLayout } from "./launcher-layout.mjs";
import { setupPromptPreview } from "./prompt-preview.mjs";
import { cachedRuns, cacheRuns, setupRunLoading, loadRunsWithProgress } from "./run-loading.mjs";
import { CHARACTER_SEED_MAX_LENGTH } from "../character-seed.mjs";
import './pricing-link.mjs';
setupCurrentVersionBadge(document.querySelector('.topbar nav'), { benchmark: true });

const elements = Object.fromEntries([
  "world", "world-description", "world-objective", "connection-status", "launch-form", "provider", "model", "effort", "action-limit", "run-options-summary",
  "coding-mode", "launch-note", "sequence-option", "sequence-enabled", "observation-option", "observation-mode", "vision-preview", "vision-preview-image", "vision-preview-status", "vision-room", "vision-left", "vision-right", "vision-tilt", "launch-single",
  "launch-status", "refresh", "run-list", "record-count", "codex-version", "codex-update-status", "check-codex", "runtime-details", "agent-readiness", "run-pagination", "run-page", "previous-runs", "next-runs", "run-company", "run-model", "run-sort"
].map((id) => [id, document.getElementById(id)]));
elements.provider.append(new Option('DeepSeek Harness', 'deepseek-harness'));

// Extend the live UI without modifying the signed historical HTML snapshot.
elements["run-sort"].append(new Option("Active first", "active"), new Option("Active only", "active-only"));
try {
  const saved = localStorage.getItem("mazebench.run-sort");
  if ([...elements["run-sort"].options].some(option => option.value === saved)) elements["run-sort"].value = saved;
} catch { /* Sorting still works when browser storage is unavailable. */ }

// New controls belong to the live module; historical HTML stays signed.
const speedLabel = document.createElement("label");
speedLabel.innerHTML = '<span>Speed</span><select id="model-speed" aria-label="Model speed"></select>';
elements.effort.closest("label").after(speedLabel);
elements.speed = speedLabel.querySelector("select");
const catalogControls = document.createElement("div");
catalogControls.className = "model-catalog-controls";
const refreshModels = document.createElement("button"); refreshModels.type = "button"; refreshModels.textContent = "Refresh models";
const catalogStatus = document.createElement("span"); catalogStatus.setAttribute("role", "status");
const chatgptUsage = document.createElement('a'); chatgptUsage.href = 'https://chatgpt.com/settings/usage';
chatgptUsage.textContent = 'Using ChatGPT plan · Manage usage'; chatgptUsage.target = '_blank'; chatgptUsage.rel = 'noopener noreferrer'; chatgptUsage.hidden = true;
catalogControls.append(refreshModels, catalogStatus, chatgptUsage); elements["launch-form"].after(catalogControls);
const launcherLayout = setupLauncherLayout(elements, catalogControls);
const seedField = document.createElement('label');
seedField.className = 'launch-field launch-field-character-seed';
seedField.innerHTML = `<span>Character seed</span><input id="character-seed" type="text" maxlength="${CHARACTER_SEED_MAX_LENGTH}" placeholder="Default glyphs" spellcheck="false" title="Use a seed to scramble the ASCII characters for this run">`;
const characterSeed = seedField.querySelector('input');
elements['launch-form'].querySelector('.options-fields').append(seedField);
const supportsCharacterSeed = () => elements.provider.value === 'antigravity' && elements.world.value === 'main-world' &&
  elements['observation-mode'].value === 'ascii' && elements['coding-mode'].value !== 'any';
const connectionLabel = document.createElement('label'); connectionLabel.className = 'launch-field launch-field-connection';
const connectionHeading = document.createElement('span'); connectionHeading.textContent = 'Connection';
const connectionSelect = document.createElement('select'); connectionSelect.setAttribute('aria-label', 'Model connection');
connectionLabel.append(connectionHeading, connectionSelect); elements.provider.closest('label').after(connectionLabel);
connectionLabel.hidden = true;
let models = [], catalogs = {}, catalogLoading, catalogCheckedAt = 0;
const selectedGroup = () => models.find(m => m.id === elements.model.value && m.provider === elements.provider.value && (!m.connection_id || m.connection_id === connectionSelect.value));
const selectedVariant = () => resolveSelection(selectedGroup(), { speed: elements.speed.value, effort: elements.effort.value, coding_mode: elements["coding-mode"].value });
function renderCatalogStatus() {
  chatgptUsage.hidden = !selectedGroup()?.variants.some(model => model.billing_source === 'chatgpt-plan');
  const state = catalogs[elements.provider.value];
  catalogStatus.textContent = !state ? "Model catalog unavailable. Refresh models." : state.error
    ? `Model refresh failed: ${state.error}${state.updated_at ? " Showing the last successful list." : ""}`
    : `${models.filter(m => m.provider === elements.provider.value).length} models · Updated ${new Date(state.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · Refreshes every 5 minutes`;
  const connection = state?.connections?.find(c => c.id === connectionSelect.value);
  if (connection?.error) catalogStatus.textContent = `${connection.name}: ${connection.error}`;
  else {
    const failed = state?.connections?.filter(c => c.error) || [];
    if (failed.length) catalogStatus.textContent += ` · Unavailable: ${failed.map(c => c.name).join(', ')}`;
  }
}

let polling = false;
let launching = false;
let codexReady = false;
let installationStatus = {};

function providerCompatible(provider) {
  if (selectedGroup()?.variants.some(v => v.connection)) return elements.world.value === 'main-world' && elements['observation-mode'].value === 'ascii';
  if(elements["observation-mode"].value==='vision'&&installationStatus[provider]?.vision_available)
    return elements.world.value==='main-world'&&elements['coding-mode'].value==='off';
  return !["grok-build", "antigravity", "muse-code", "kimi-code", "prime-agent", "deepseek-harness"].includes(provider) || (elements.world.value === "main-world" && elements["observation-mode"].value === "ascii");
}

function updateReadiness() {
  seedField.hidden = characterSeed.disabled = !supportsCharacterSeed();
  updateRunOptionsSummary();
  renderCatalogStatus();
  const provider = elements.provider.value;
  const direct = provider === "prime-agent" && elements["coding-mode"].value === "off";
  const status = direct ? installationStatus[provider]?.direct : installationStatus[provider];
  const any = elements["coding-mode"].value === "any";
  const connected = selectedGroup()?.variants.some(v => v.connection);
  const codeReady = !any || (!connected && supportsAnyLanguage(launchPayload()) && status?.code_sandbox?.available);
  const needsAuth = ["claude-code", "grok-build", "antigravity", "muse-code", "kimi-code", "prime-agent", "deepseek-harness"].includes(provider);
  codexReady = Boolean(codeReady && status?.available && status?.tested && (!needsAuth || connected || status.authenticated) && providerCompatible(provider) && selectedVariant() && !selectedVariant()?.connection_stale && !catalogs[provider]?.stale);
  elements["codex-version"].textContent = status?.version ? `${providerName(provider)} ${status.version.replace(/^codex-cli /, "")}` : "Checking agent…";
  const labels = { "up-to-date": "Up to date", "update-available": `Update available: ${status?.latest_version}. Run codex update, then restart the server.`, "newer-than-release": "Newer than the current stable release", unknown: "Latest release check unavailable" };
  elements["codex-update-status"].textContent = any && !codeReady
    ? (supportsAnyLanguage(launchPayload()) ? status?.code_sandbox?.error || "Checking coding workspace…" : elements["coding-mode"].querySelector('option[value="any"]').title)
    : !providerCompatible(provider)
    ? installationStatus[provider]?.vision_available ? `${providerName(provider)} supports Main World vision with Coding off.` : `${providerName(provider)} currently supports Main World with ASCII observations.`
    : !status ? "Checking installation and sign-in…" : connected && codexReady ? `${connectionSelect.selectedOptions[0]?.textContent} · Benchmark tool boundary verified` : status.error || (needsAuth
    ? `${status?.authenticated ? "Signed in" : "Not signed in"} · ${status?.tested ? "Benchmark tool boundary verified" : "Version needs validation"}`
    : `${labels[status?.update_status] || "Checking installation"} · ${status?.tested ? "Benchmark checks supported" : "Version needs validation"}`);
  elements["check-codex"].textContent = provider === "codex" ? "Check for updates" : "Check installation";
  elements["agent-readiness"].textContent = codexReady ? "Ready" : status ? "Needs attention" : "Checking…";
  elements["runtime-details"].classList.toggle("needs-attention", Boolean(status && !codexReady));
  if (status && !codexReady && selectedGroup()) {
    elements["runtime-details"].open = true;
    elements["runtime-details"].closest('.run-options').open = true;
  }
  elements["launch-single"].disabled = launching || !codexReady;
  launcherLayout.update();
}

async function checkCodex(force = false) {
  elements["check-codex"].disabled = true;
  try {
    installationStatus = await api(`/api/benchmark/v1/providers${force ? "?force=1" : ""}`);
  } catch (error) { installationStatus = Object.fromEntries(["codex", "claude-code", "grok-build", "antigravity", "muse-code", "kimi-code", "prime-agent", "deepseek-harness"].map(provider => [provider, { error: error.message }])); }
  finally { elements["check-codex"].disabled = false; updateReadiness(); }
}

async function api(path, options = {}) {
  const response = await benchmarkFetch(path, {
    ...options,
    // GETs need no JSON content header (or the extra cross-origin preflight).
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

const runList = new RunListView(elements["run-list"]);
const runLoading = setupRunLoading(elements["run-list"]);
const updatePrompt = setupPromptPreview(document.getElementById("agent-prompts"), launchPayload);
let latestRuns = [];
document.addEventListener('mazebench:versions-updated', () => { if (latestRuns.length) renderRuns(latestRuns); });
let hasRunData = false, runsAreCached = false, pendingRuns;
let pollTimer;

function filterOptions(select, values, placeholder, label = value => value) {
  const options = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return;
  const selected = select.value;
  select.replaceChildren(new Option(placeholder, ""), ...options.map(value => new Option(label(value), value)));
  select.value = options.includes(selected) ? selected : "";
  select.dataset.options = signature;
}

function renderRuns(runs, page) {
  latestRuns = runs;
  filterOptions(elements["run-company"], runs.map(runCompany), "All companies");
  const company = elements["run-company"].value;
  filterOptions(elements["run-model"], runs.filter(run => !company || runCompany(run) === company).map(run => modelGroupId(run.model)), "All models", modelLabel);
  const visible = selectRuns(runs, { company, model: elements["run-model"].value, sort: elements["run-sort"].value });
  const result = runList.update(visible, page, { cached: runsAreCached });
  elements["record-count"].textContent = visible.length === runs.length
    ? `${runs.length} run${runs.length === 1 ? "" : "s"}` : `${visible.length} of ${runs.length} runs`;
  elements["run-pagination"].hidden = result.totalPages === 1;
  elements["run-page"].textContent = `${result.page + 1} of ${result.totalPages}`;
  elements["previous-runs"].disabled = result.page === 0;
  elements["next-runs"].disabled = result.page + 1 === result.totalPages;
}

function updateEfforts(preserve = true) {
  const previous = preserve ? elements.effort.value : "";
  const mode = elements["coding-mode"].value;
  const variants = selectedGroup()?.variants.filter(v => v.speed === elements.speed.value) || [];
  const efforts = sortedEfforts(variants.flatMap(v => variantEfforts(v, mode) || []));
  const defaults = variants.map(v => mode === "off" && v.provider === "prime-agent" ? v.default_direct_effort : v.default_effort);
  const preferred = previous || defaults.find(e => efforts.includes(e)) || efforts[0];
  elements.effort.replaceChildren(...efforts.map(e => new Option(e === "default" ? "Model default" : e === "enabled" ? "Thinking enabled" : e, e)));
  if (previous && !efforts.includes(previous)) { const missing = new Option(previous + " (unavailable)", previous); missing.disabled = true; elements.effort.append(missing); }
  elements.effort.value = preferred || "";
  elements.effort.disabled = efforts.length < 2;
}
function updateSpeeds(preserve = true) {
  const previous = preserve ? elements.speed.value : "";
  const speeds = [...new Set((selectedGroup()?.variants || []).map(v => v.speed))].filter(speed => elements["observation-mode"].value !== "vision" || elements.provider.value === "codex" || speed === "standard");
  elements.speed.replaceChildren(...speeds.map(speed => new Option(speed === "fast" ? "Fast" : "Standard", speed)));
  if (previous && !speeds.includes(previous)) { const missing = new Option(previous + " (unavailable)", previous); missing.disabled = true; elements.speed.append(missing); }
  elements.speed.value = previous || (speeds.includes("standard") ? "standard" : speeds[0]) || "";
  elements.speed.disabled = speeds.length < 2;
  updateEfforts(preserve);
}
function updateModels(preserve = false) {
  const previous = preserve ? elements.model.value : "";
  elements["coding-mode"].disabled = false;
  elements["coding-mode"].querySelector('option[value="off"]').disabled = false;
  const all = models.filter(model => model.provider === elements.provider.value);
  const previousConnection = connectionSelect.value;
  const connections = [...new Map(all.filter(m => m.connection_id).map(m => [m.connection_id, m.connection_name || m.connection_id])).entries()];
  connectionLabel.hidden = !connections.length;
  connectionSelect.replaceChildren(...connections.map(([id, name]) => new Option(name, id)));
  if (connections.some(([id]) => id === previousConnection)) connectionSelect.value = previousConnection;
  const providerModels = all.filter(model => !model.connection_id || model.connection_id === connectionSelect.value);
  elements.model.replaceChildren(...providerModels.map(model => new Option(modelOptionLabel(model), model.id)));
  // Never silently change a user's chosen model during a background refresh.
  if (previous && !providerModels.some(m => m.id === previous)) {
    const missing = new Option(previous + " (unavailable)", previous); missing.disabled = true; elements.model.append(missing);
    elements.model.value = previous;
  } else elements.model.value = previous || providerModels.find(m => m.variants.some(v => v.is_default))?.id ||
    providerModels.find(m => m.id === ({ "kimi-code": "k3.1-pro", "claude-code": "claude-sonnet-5-5", "muse-code": "muse-wonder-1.0", "grok-build": "grok-4.7" })[elements.provider.value])?.id || providerModels[0]?.id || "";
  updateCodingOptions(); updateSpeeds(preserve); updateReadiness(); updatePrompt();
}
async function loadModels(force = false) {
  if (catalogLoading) return catalogLoading;
  refreshModels.disabled = true;
  catalogLoading = (async () => {
    try {
      const catalog = await api(`/api/benchmark/v1/models${force ? "?force=1" : ""}`);
      models = catalog.groups || groupModels(catalog.models);
      catalogs = catalog.catalogs || {}; catalogCheckedAt = Date.now();
      updateModels(Boolean(elements.model.value));
    } catch (error) {
      for (const provider of Object.keys(catalogs)) catalogs[provider] = { ...catalogs[provider], stale: true, error: error.message };
      catalogStatus.textContent = "Model refresh failed: " + error.message; updateReadiness();
    } finally { refreshModels.disabled = false; catalogLoading = null; }
  })();
  return catalogLoading;
}

function launchPayload() {
  const mode = elements["coding-mode"].value;
  const seed = supportsCharacterSeed() ? characterSeed.value.trim() : '';
  return {
    world: elements.world.value,
    ...(elements.world.value === "main-world" ? { observation_mode: elements["observation-mode"].value } : {}),
    provider: elements.provider.value,
    ...(connectionSelect.value ? { connection_id: connectionSelect.value } : {}),
    model: selectedVariant()?.id || "",
    service_tier: selectedVariant()?.service_tier || "standard",
    effort: elements.effort.value,
    coding_mode: mode,
    tools_enabled: mode !== "off",
    ...(seed ? { character_seed: seed } : {}),
    ...(elements.world.value === "slotski" ? { sequence_enabled: elements["sequence-enabled"].value === "true" } : {}),
    action_limit: elements["action-limit"].value === "unlimited"
      ? null
      : Number(elements["action-limit"].value),
    start_room: elements.world.value !== "main-world" ? "Level 1" : "HxI"
  };
}

function setLaunching(active, message) {
  launching = active;
  elements["launch-single"].disabled = active || !codexReady;
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
    await refreshRuns({ afterMutation: true });
    setLaunching(false, `Launched ${modelLabel(run.model)}. Its live record is ready below.`);
  } catch (error) {
    setLaunching(false, error.message);
  }
}

async function refreshRuns({ afterMutation = false } = {}) {
  // A launch needs a response requested after creation; ordinary refreshes share work.
  if (afterMutation && pendingRuns) await pendingRuns.catch(() => {});
  if (pendingRuns) return pendingRuns;
  runLoading.start({ initial: !hasRunData, cached: runsAreCached });
  pendingRuns = (async () => {
    try {
      const signal = AbortSignal.timeout(30_000);
      const showPartial = !hasRunData;
      const value = await loadRunsWithProgress(() => api("/api/benchmark/v1/runs?view=library", { signal }), {
        signal, progress: value => runLoading.progress(value),
        partial: runs => {
          if (!showPartial) return;
          runsAreCached = true;
          renderRuns(runs);
          hasRunData = true;
        }
      });
      runsAreCached = false;
      renderRuns(value.runs);
      hasRunData = true;
      cacheRuns(value.runs);
      runLoading.finish();
    } catch (error) {
      if (hasRunData) {
        runsAreCached = true;
        renderRuns(latestRuns);
      }
      runLoading.finish({ error: true, hasRuns: hasRunData });
      throw error;
    } finally {
      pendingRuns = null;
    }
  })();
  return pendingRuns;
}

function showError(error) {
  elements["connection-status"].textContent = error.message;
  elements["connection-status"].classList.add("error");
  elements["connection-status"].classList.remove("connected");
}

async function poll() {
  clearTimeout(pollTimer);
  if (polling) return;
  polling = true;
  try {
    await refreshRuns();
    elements["connection-status"].textContent = "Connected";
    elements["connection-status"].classList.remove("error");
    elements["connection-status"].classList.add("connected");
  } catch (error) {
    showError(error);
    if (!hasRunData) {
      const message = document.createElement("p");
      message.className = "empty-copy";
      message.textContent = "Runs couldn’t load. Refresh to try again.";
      elements["run-list"].replaceChildren(message);
    }
  } finally {
    polling = false;
    if (!document.hidden) {
      const active = latestRuns.some(isActiveRun);
      pollTimer = setTimeout(poll, active ? 5000 : 30000);
    }
  }
}

elements["launch-form"].addEventListener("submit", launchSingle);
elements["check-codex"].addEventListener("click", () => { void checkCodex(true); void loadModels(true); });
refreshModels.addEventListener("click", () => loadModels(true));
elements.refresh.addEventListener("click", () => poll());
for (const id of ["run-company", "run-model", "run-sort"]) {
  elements[id].addEventListener("change", () => {
    if (id === "run-sort") {
      try { localStorage.setItem("mazebench.run-sort", elements[id].value); } catch { /* Optional preference. */ }
    }
    renderRuns(latestRuns, 0);
  });
}
for (const [id, step] of [["previous-runs", -1], ["next-runs", 1]]) {
  elements[id].addEventListener("click", () => {
    renderRuns(latestRuns, runList.page + step);
    elements["run-list"].scrollIntoView({ block: "start" });
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(pollTimer);
  else { poll(); if (Date.now() - catalogCheckedAt > 5 * 60_000) loadModels(); }
});
elements["run-list"].addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-run]");
  if (!button || button.disabled) return;
  const id = button.dataset.deleteRun;
  const run = (await api("/api/benchmark/v1/runs?view=library")).runs.find((entry) => entry.id === id);
  if (!run) return poll();
  const confirmed = window.confirm(
    `Permanently delete ${modelLabel(run.model)} run ${run.id}?\n\nThis removes its record, workspace, replay, and interview chats. This cannot be undone.`
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
function updateRunOptionsSummary() {
  const limit = elements["action-limit"].value;
  const actions = limit === "unlimited" ? "Unlimited actions" : `${Number(limit).toLocaleString()} actions`;
  const sequences = elements.world.value === "slotski"
    ? ` · ${elements["sequence-enabled"].value === "true" ? "Batch moves" : "Single moves"}`
    : "";
  const seed = supportsCharacterSeed() && characterSeed.value.trim();
  elements["run-options-summary"].textContent = `${elements.world.selectedOptions[0]?.textContent || "Main World"} · ${actions}${sequences}${seed ? ` · Character seed ${seed}` : ''}`;
}

function updateWorld() {
  const ice = elements.world.value === "ice-maze", slotski = elements.world.value === "slotski";
  elements["sequence-option"].hidden = !slotski;
  elements["observation-option"].hidden = ice || slotski;
  if (ice || slotski) elements["observation-mode"].value = "ascii";
  updateCodingOptions();
  updateObservation();
  updateReadiness();
  elements["world-objective"].textContent = slotski ? "Move A to the exit" : ice ? "Solve 30 levels" : "Collect 100 gems";
  elements["world-description"].textContent = slotski ? "Move the 2×2 target block to the bottom-center exit." : ice ? "Solve 30 puzzles in order. All players slide together." : "Explore Main World from room H×I.";
  updateRunOptionsSummary();
}
let previewYaw = 0, previewPitch = 2, previewGeneration = 0;
async function updateObservation() {
  updateCodingOptions();
  updateReadiness();
  const enabled = elements.world.value === "main-world" && elements["observation-mode"].value === "vision";
  elements["vision-preview"].hidden = !enabled;
  if (!enabled) return;
  const generation = ++previewGeneration;
  elements["vision-preview-status"].textContent = "Rendering the agent's view…";
  if (!await visionAvailable()) { elements["vision-preview-status"].textContent = "Vision runner is offline."; return; }
  if (generation !== previewGeneration) return;
  const img = elements["vision-preview-image"];
  img.onload = () => { elements["vision-preview-status"].textContent = "Preview only · no benchmark actions are taken"; };
  img.onerror = () => { elements["vision-preview-status"].textContent = "The image could not be rendered. Try again."; };
  img.src = visionUrl(`/api/benchmark/vision/preview?room=${elements["vision-room"].value}&yaw=${previewYaw}&pitch=${previewPitch}`);
}
elements["observation-mode"].addEventListener("change", () => { updateSpeeds(); updateObservation(); });
elements["vision-room"].addEventListener("change", updateObservation);
elements["vision-left"].addEventListener("click", () => { previewYaw = (previewYaw + 3) % 4; updateObservation(); });
elements["vision-right"].addEventListener("click", () => { previewYaw = (previewYaw + 1) % 4; updateObservation(); });
elements["vision-tilt"].addEventListener("click", () => { previewPitch = (previewPitch + 1) % 5; updateObservation(); });
if (new URLSearchParams(location.search).get("mode") === "vision") elements["observation-mode"].value = "vision";
const requestedWorld = new URLSearchParams(location.search).get("world");
if (["ice-maze", "slotski"].includes(requestedWorld)) elements.world.value = requestedWorld;
if (elements.world.value === "slotski") elements["action-limit"].value = "1000";
elements.world.addEventListener("change", () => {
  elements["action-limit"].value = elements.world.value === "slotski" ? "1000" : "unlimited";
  updateWorld();
});
updateWorld();
updatePrompt();
elements["launch-form"].addEventListener("change", updatePrompt);
document.getElementById("prompt-details").addEventListener("toggle", event => {
  if (event.currentTarget.open) updatePrompt();
});
elements["action-limit"].addEventListener("change", updateRunOptionsSummary);
characterSeed.addEventListener('input', updateRunOptionsSummary);
elements["sequence-enabled"].addEventListener("change", updateRunOptionsSummary);
elements.model.addEventListener("change", () => { updateSpeeds(false); updateReadiness(); updatePrompt(); });
elements.speed.addEventListener("change", () => { updateEfforts(); updateReadiness(); updatePrompt(); });
elements.effort.addEventListener("change", updateReadiness);
elements.provider.addEventListener("change", () => { updateModels(); if (Date.now() - catalogCheckedAt > 5 * 60_000) loadModels(); });
connectionSelect.addEventListener('change', () => updateModels(false));
function updateCodingOptions() {
  const connected = selectedGroup()?.variants.some(v => v.connection);
  const supported = !connected && supportsAnyLanguage(launchPayload());
  const anyOption = elements["coding-mode"].querySelector('option[value="any"]');
  anyOption.disabled = !supported;
  anyOption.title = supported ? "Use the full coding workspace with any supported language"
    : elements["observation-mode"].value === "vision"
      ? "Vision's full coding workspace is not available yet. Choose ASCII to use Coding tools On."
      : "Coding tools On is not supported by this agent in the selected world.";
  // Preserve a selected unsupported condition and explain it; never silently
  // launch a different tier when the provider or observation mode changes.
  const prime = elements.provider.value === "prime-agent";
  elements["launch-note"].textContent = elements.provider.value === 'deepseek-harness' || connected
    ? `${providerName(elements.provider.value)} uses the selected connection for inference. Main World ASCII supports coding Off or Python Only.` : prime
    ? "Off uses direct maze tools through Prime Inference, a separate harness from stock Prime Agent. On and Python Only use the native Prime Agent workspace. Your Prime account pays inference; native modes also use a billed remote VM."
    : elements["coding-mode"].value === "any"
      ? "On supports Python, JavaScript, C/C++, Rust, Go, Java, Ruby, Perl and Lua."
      : "On enables the full coding workspace with ASCII observations. Python Only is the legacy workspace.";
}
elements["coding-mode"].addEventListener("change", () => { updateCodingOptions(); updateEfforts(false); updateReadiness(); updatePrompt(); });

try {
  updateRunOptionsSummary();
  setLaunching(false, elements["launch-status"].textContent);
  const savedRuns = cachedRuns();
  if (savedRuns) {
    runsAreCached = true;
    renderRuns(savedRuns);
    hasRunData = true;
  }
  await Promise.all([poll(), loadModels(), checkCodex()]);
  setInterval(() => { if (!document.hidden) checkCodex(); }, 15 * 60_000);
  setInterval(() => { if (!document.hidden) loadModels(); }, 5 * 60_000);
} catch (error) {
  showError(error);
  elements["launch-status"].textContent = error.message;
}
