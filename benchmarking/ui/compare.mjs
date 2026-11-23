import { benchmarkFetch } from "./benchmark-api.mjs";
import { runCompany, runCardValues, selectRuns } from "./run-library.mjs";
import { comparisonCondition } from "./heatmap-import.mjs";
import { comparisonReport, comparisonBounds, croppedBounds, comparisonScale, defaultComparison, drawComparisonMap, displayModelName, tileAt, roomAt } from "./heatmap-comparison.mjs";
import { modelSlug, modelSpeed } from "./model-label.mjs";
import { createGemComparison } from "./gem-comparison.mjs";
import { createHeatmapGifExport } from "./heatmap-gif-export.mjs";

const $ = id => document.getElementById(id);
const number = value => (value || 0).toLocaleString();
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const percent = value => `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(value)}%`;
const params = new URLSearchParams(location.search);
let runs = [], fullWorld = params.get("area") === "world", selectedTile = null, serial = 0, refreshing = false;
let focusedRun = params.get("focus");
let screenshotMode = false, previousScroll = 0, gemMode = params.get("view") === "gems", nextPanel = 0;
const panels = [], cache = new Map(), pending = new Map();
const labelKey = "mazebench-heatmap-labels-v1";
let labels = {};
try { const saved = JSON.parse(localStorage.getItem(labelKey)); if (saved && typeof saved === "object" && !Array.isArray(saved)) labels = saved; } catch { /* Private browsing can disable storage. */ }
const labelFor = run => typeof labels[run?.id] === "string" && labels[run.id].trim() ? labels[run.id] : displayModelName(run?.model);
function saveLabels() { try { localStorage.setItem(labelKey, JSON.stringify(labels)); } catch { /* Keep edits for this page session. */ } }
const modeName = run => run?.observation_mode === "vision" ? "Vision" : "Text";
const details = run => `${modeName(run)} · ${comparisonCondition(run)}${run.effort ? ` · ${run.effort}` : ""}${modelSpeed(run) === "fast" ? " · Fast" : ""} · ${runCardValues(run).version.label}`;
if (params.get("scale") === "share") $("color-scale").value = "share";

// The historical HTML is signed. Modern controls live in this presentation module.
document.title = "MazeBench — Compare runs";
document.querySelector(".compare-heading h1").textContent = "Compare runs";
document.querySelector(".compare-heading p").remove();
$("screenshot-mode").textContent = "Screenshot";
$("screenshot-mode").title = "Clean heatmaps with editable labels";
$("comparison-note").hidden = true;
document.querySelectorAll(".compare-help").forEach(node => node.remove());
const toolbar = document.querySelector(".compare-toolbar");
const area = toolbar.querySelector('[aria-label="Map area"]');
const colorSelect = $("color-scale");
$("model-count").closest("label").remove();
colorSelect.closest("label").hidden = true;
const controls = document.createElement("div");
controls.className = "comparison-controls";
controls.innerHTML = `<div class="comparison-view-switch map-segments" role="group" aria-label="Comparison view"><button type="button" data-view="heatmaps">Heatmaps</button><button type="button" data-view="gems">Line chart</button></div>
  <div class="heatmap-controls"><button type="button" id="add-comparison">＋ Add run</button><details class="map-options"><summary>Map settings</summary><div class="map-options-content"><span>Area</span><div class="area-slot"></div><span>Color</span><div class="map-segments" role="group" aria-label="Color scale"><button type="button" data-scale="count">Visit count</button><button type="button" data-scale="share">Visit share</button></div></div></details></div>`;
toolbar.before(controls);
controls.querySelector(".area-slot").append(area);
controls.querySelector(".map-options-content").append(colorSelect);
colorSelect.hidden = true;
toolbar.remove();
const viewSwitch = controls.querySelector(".comparison-view-switch");
const help = document.querySelector(".compare-details");
help.querySelector("summary").textContent = "About these heatmaps";
help.querySelector("p").textContent = "Compare text and vision runs on the same world coordinates and color scale. Visit share normalizes for run length. Hover or tap a tile to compare visits; arrow keys work with a map focused.";
function focusRun(id) {
  focusedRun=id || null;
  for(const panel of panels) panel.element.classList.toggle('comparison-focused',panel.id===focusedRun);
  gemComparison.setFocus(focusedRun); updateURL();
}
function replaceSelection(ids) {
  const unique=[...new Set(ids)].filter(id=>runs.some(run=>run.id===id));
  for(const panel of [...panels]) if(!unique.includes(panel.id)) { observer.unobserve(panel.canvas); panel.element.remove(); panels.splice(panels.indexOf(panel),1); }
  for(const id of unique) if(!panels.some(panel=>panel.id===id)) createPanel(id);
  panels.sort((a,b)=>unique.indexOf(a.id)-unique.indexOf(b.id));
  for(const panel of panels) $('comparison-panels').append(panel.element);
  if(!unique.includes(focusedRun)) { focusedRun=null; gemComparison.setFocus(null); }
  syncPanels(); updateURL();
}
const gemComparison = createGemComparison({ onSelectionChange: replaceSelection, onFocus: focusRun, onChange: () => { if (gemMode) $("screenshot-mode").disabled = !gemComparison.canScreenshot(); } });
function updateView() {
  document.documentElement.classList.toggle("gem-view", gemMode);
  for (const button of viewSwitch.querySelectorAll("button")) button.setAttribute("aria-pressed", String((button.dataset.view === "gems") === gemMode));
  gemComparison.setActive(gemMode);
}
updateView();
viewSwitch.addEventListener("click", event => {
  const button = event.target.closest("button[data-view]");
  if (!button || (button.dataset.view === "gems") === gemMode) return;
  gemMode = button.dataset.view === "gems"; updateView(); loadSelection();
});

const picker = document.createElement("dialog");
picker.className = "comparison-picker";
picker.setAttribute("aria-labelledby", "comparison-picker-title");
picker.innerHTML = `<header><h2 id="comparison-picker-title">Choose a run</h2><button type="button" class="picker-close" aria-label="Close run picker">×</button></header>
  <input type="search" class="picker-search" placeholder="Search model or company" aria-label="Search runs">
  <div class="picker-filters"><div class="map-segments" role="group" aria-label="Observation mode"><button data-mode="all" aria-pressed="true">All</button><button data-mode="vision" aria-pressed="false">Vision</button><button data-mode="ascii" aria-pressed="false">Text</button></div>
  <div class="map-segments" role="group" aria-label="Coding tools"><button data-coding="all" aria-pressed="true">All tools</button><button data-coding="off" aria-pressed="false">Off</button><button data-coding="on" aria-pressed="false">On</button></div></div>
  <div class="picker-runs" role="group" aria-label="Available runs"></div>`;
document.body.append(picker);
let picking = null, pickerMode = "all", pickerCoding = "all";
const search = picker.querySelector("input");
function addLogo(container, run) {
  const values = runCardValues(run);
  if (!values.logo) return;
  const img = document.createElement("img"); img.src = values.logo; img.alt = ""; img.width = img.height = 22;
  img.className = `comparison-logo${values.monochromeLogo ? " monochrome" : ""}`;
  container.append(img);
}
function renderPicker() {
  const query = search.value.trim().toLowerCase();
  const list = picker.querySelector(".picker-runs"); list.replaceChildren();
  const visible = runs.filter(run => (!query || `${run.model} ${modelSlug(run.model)} ${runCompany(run)} ${run.id}`.toLowerCase().includes(query))
    && (pickerMode === "all" || (run.observation_mode || "ascii") === pickerMode)
    && (pickerCoding === "all" || Boolean(run.tools_enabled) === (pickerCoding === "on")));
  for (const run of visible) {
    const button = document.createElement("button"); button.type = "button"; button.className = "picker-run"; button.dataset.id = run.id;
    button.setAttribute("aria-pressed", String(picking?.id === run.id));
    button.disabled = !picking?.id && panels.some(panel => panel.id === run.id);
    addLogo(button, run);
    const body = document.createElement("span"), title = document.createElement("strong"), subtitle = document.createElement("small");
    title.textContent = modelSlug(run.model); subtitle.textContent = details(run);
    body.append(title, subtitle);
    const stamp = document.createElement("span"); stamp.className = "picker-run-date";
    stamp.textContent = `${run.created_at ? dates.format(new Date(run.created_at)) : "Undated"}${run.source ? " · Imported" : ""}`;
    button.title = `${modelSlug(run.model)} · ${details(run)} · ${run.status || "Imported"} · ${run.id}`;
    button.append(body, stamp); list.append(button);
  }
  if (!visible.length) { const empty = document.createElement("p"); empty.className = "picker-empty"; empty.textContent = "No matching runs."; list.append(empty); }
}
function openPicker(panel) { picking = panel; search.value = ""; renderPicker(); picker.showModal(); search.focus(); }
picker.querySelector(".picker-close").addEventListener("click", () => picker.close());
picker.addEventListener("click", event => {
  if (event.target === picker) { const r = picker.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) picker.close(); }
  const choice = event.target.closest(".picker-run");
  if (choice && picking) {
    const other=panels.find(panel=>panel!==picking && panel.id===choice.dataset.id);
    if(other) other.id=picking.id;
    picking.id=choice.dataset.id; focusRun(picking.id); picker.close(); loadSelection();
  }
  const filter = event.target.closest("[data-mode], [data-coding]");
  if (filter) {
    if (filter.dataset.mode) pickerMode = filter.dataset.mode; else pickerCoding = filter.dataset.coding;
    for (const button of filter.parentElement.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button === filter));
    renderPicker();
  }
});
search.addEventListener("input", renderPicker);
picker.addEventListener("close", () => {
  if(picking && !picking.id) { observer.unobserve(picking.canvas); picking.element.remove(); panels.splice(panels.indexOf(picking),1); syncPanels(); updateURL(); $('add-comparison').focus(); }
  else picking?.element.querySelector('.comparison-pick').focus({preventScroll:true});
});

const observer = new ResizeObserver(() => drawMaps());
function createPanel(id = "") {
  const side = `map-${++nextPanel}`, element = document.createElement("section");
  element.className = "comparison-panel";
  element.innerHTML = `<header class="comparison-panel-header"><button type="button" class="comparison-pick"><span class="comparison-pick-body"><strong></strong><small></small></span><span class="pick-chevron" aria-hidden="true">⌄</span></button><span class="comparison-order"><button type="button" data-shift="-1" aria-label="Move heatmap left" title="Move left">←</button><button type="button" data-shift="1" aria-label="Move heatmap right" title="Move right">→</button></span><button type="button" class="remove-comparison" aria-label="Remove run">×</button></header>
    <dl class="comparison-stats"><div><dt>Moves</dt><dd data-stat="actions">—</dd></div><div><dt>Tiles</dt><dd data-stat="tiles">—</dd></div><div><dt>Rooms</dt><dd data-stat="rooms">—</dd></div><div><dt>Gems</dt><dd data-stat="gems">—</dd></div></dl>
    <div class="comparison-map"><canvas width="640" height="640" tabindex="0" role="img" aria-describedby="${side}-tile"></canvas><div class="map-message" role="status">Choose a run</div></div>
    <footer><output id="${side}-tile" class="tile-readout">Hover to inspect</output><a class="open-run" hidden aria-label="Open run details">↗</a></footer>
    <p class="screenshot-model-name" role="textbox" aria-multiline="false" spellcheck="false"></p>`;
  const panel = { id, element, canvas: element.querySelector("canvas"), message: element.querySelector(".map-message"), label: element.querySelector(".screenshot-model-name"), data: null, dataId: null, layout: null };
  panels.push(panel); $("comparison-panels").append(element); observer.observe(panel.canvas);
  element.addEventListener('click',event=>{
    const shift=event.target.closest('[data-shift]');
    if(shift) {
      const from=panels.indexOf(panel), to=from+Number(shift.dataset.shift);
      if(to<0||to>=panels.length) return;
      [panels[from],panels[to]]=[panels[to],panels[from]];
      for(const item of panels) $('comparison-panels').append(item.element);
      syncPanels(); gemComparison.setSelection(panels.map(p=>p.id)); updateURL(); drawMaps();
      shift.focus({preventScroll:true});
    }
  });
  panel.canvas.addEventListener('focus',()=>focusRun(panel.id));
  panel.canvas.addEventListener('pointerdown',()=>focusRun(panel.id));
  element.querySelector(".comparison-pick").addEventListener("click", () => openPicker(panel));
  element.querySelector(".remove-comparison").addEventListener("click", () => {
    observer.unobserve(panel.canvas); panels.splice(panels.indexOf(panel), 1); element.remove(); syncPanels(); loadSelection();
  });
  panel.label.addEventListener("input", () => {
    labels[panel.id] = panel.label.textContent.slice(0, 160); saveLabels(); fitScreenshotLabels();
  });
  panel.label.addEventListener("blur", () => {
    const value = panel.label.textContent.replace(/\s+/g, " ").trim().slice(0, 160);
    if (value) labels[panel.id] = value; else delete labels[panel.id];
    saveLabels(); panel.label.textContent = labelFor(runs.find(run => run.id === panel.id)); drawMaps();
  });
  panel.label.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); panel.label.blur(); } });
  const inspect = event => {
    if (screenshotMode || !panel.layout || !panel.data) return;
    const rect = panel.canvas.getBoundingClientRect(); selectedTile = tileAt(panel.layout, event.clientX - rect.left, event.clientY - rect.top); drawMaps();
  };
  panel.canvas.addEventListener("pointermove", inspect); panel.canvas.addEventListener("pointerdown", inspect);
  panel.canvas.addEventListener("keydown", event => {
    if (screenshotMode) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (event.key === "Escape") { selectedTile = null; drawMaps(); return; }
    if (!direction || !panel.layout || !panel.data) return;
    event.preventDefault(); const b = panel.layout, p = selectedTile || { x: b.minX, y: b.minY };
    selectedTile = { x: Math.max(b.minX, Math.min(b.minX + b.columns - 1, p.x + direction[0])), y: Math.max(b.minY, Math.min(b.minY + b.rows - 1, p.y + direction[1])) }; drawMaps();
  });
  return panel;
}
function syncPanels() {
  $('comparison-panels').style.setProperty('--comparison-count',Math.max(1,panels.length));
  panels.forEach((panel,index)=>{
    panel.element.querySelector('.remove-comparison').hidden=false;
    panel.element.querySelector('[data-shift="-1"]').disabled=index===0;
    panel.element.querySelector('[data-shift="1"]').disabled=index===panels.length-1;
    panel.element.classList.toggle('comparison-focused',panel.id===focusedRun);
    panel.element.dataset.runId=panel.id;
  });
}
const gifExport = createHeatmapGifExport({
  selection: () => ({ scale: colorSelect.value, panels: panels.map(panel => ({ run: runs.find(run => run.id === panel.id), name: labelFor(runs.find(run => run.id === panel.id)), map: panel.data?.map, actions: panel.data?.actions })) }),
  onExit: () => setScreenshotMode(false), onResize: () => drawMaps(),
});
const resetLabels = document.createElement("button"); resetLabels.type = "button"; resetLabels.textContent = "Reset names";
resetLabels.addEventListener("click", () => { for (const panel of panels) { delete labels[panel.id]; renderPanel(panel); } saveLabels(); drawMaps(); });
document.querySelector(".heatmap-export-controls .gif-exit").before(resetLabels);
const screenshotReturn = document.createElement("button");
screenshotReturn.className = "screenshot-return"; screenshotReturn.type = "button"; screenshotReturn.textContent = "Done"; screenshotReturn.hidden = true;
screenshotReturn.addEventListener("click", () => setScreenshotMode(false)); document.body.append(screenshotReturn);

async function importedJSON(path) {
  const response = await fetch(new URL(path, import.meta.url), { signal: AbortSignal.timeout(15000), cache: "no-cache" });
  if (!response.ok) throw new Error(`Imported heatmaps unavailable (${response.status}).`);
  return response.json();
}
async function api(url) {
  const response = await benchmarkFetch(url, { signal: AbortSignal.timeout(60000) }); const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`); return value;
}
function report(id) {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.value);
  if (pending.has(id)) return pending.get(id);
  const run = runs.find(run => run.id === id);
  const request = (run?.source ? importedJSON(`../imports/${encodeURIComponent(id)}.json`) : api(`/api/benchmark/v1/runs/${encodeURIComponent(id)}?view=analysis`)).then(value => {
    const result = comparisonReport(value);
    if (pending.get(id) === request) { cache.delete(id); cache.set(id, { value: result, at: Date.now() }); if (cache.size > Math.max(12, panels.length)) cache.delete(cache.keys().next().value); }
    return result;
  }).finally(() => { if (pending.get(id) === request) pending.delete(id); });
  pending.set(id, request); return request;
}
function updateURL() {
  const url = new URL(location.href);
  for (const key of ["map", "run", "left", "right", "third", "models"]) url.searchParams.delete(key);
  for (const panel of panels) if(panel.id) url.searchParams.append("map", panel.id);
  url.searchParams.set('selection','1');
  if(focusedRun) url.searchParams.set('focus',focusedRun); else url.searchParams.delete('focus');
  if (gemMode) url.searchParams.set("view", "gems"); else url.searchParams.delete("view");
  if (fullWorld) url.searchParams.set("area", "world"); else url.searchParams.delete("area");
  if (colorSelect.value === "share") url.searchParams.set("scale", "share"); else url.searchParams.delete("scale");
  history.replaceState(null, "", url);
}
function renderPanel(panel) {
  const run = runs.find(run => run.id === panel.id), data = panel.data;
  if (document.activeElement !== panel.label) panel.label.textContent = labelFor(run);
  panel.label.setAttribute("aria-label", `Screenshot label for ${modelSlug(run?.model) || "run"}`);
  const pick = panel.element.querySelector(".comparison-pick");
  pick.querySelector("strong").textContent = modelSlug(run?.model) || "Choose a run";
  pick.querySelector("small").textContent = run ? details(run) : "Text or vision";
  pick.setAttribute("aria-label", `Choose run${run ? `: ${modelSlug(run.model)} · ${details(run)}` : ""}`);
  pick.querySelector("img")?.remove(); if (run) { const logo = document.createElement("span"); addLogo(logo, run); if (logo.firstChild) pick.prepend(logo.firstChild); }
  const link = panel.element.querySelector(".open-run"); link.hidden = !run;
  if (run) { link.href = run.source?.run_id ? new URL(`./archive.html?id=${encodeURIComponent(run.source.run_id)}`, import.meta.url).href : `./run.html?id=${encodeURIComponent(run.id)}`; link.title = `${run.source ? "Older run" : "Open run"} · ${run.created_at ? dates.format(new Date(run.created_at)) : "Undated"}`; }
  const stats = { actions: data?.actions, tiles: data?.map.points.length, rooms: data ? run?.rooms_visited : null, gems: data ? run?.gems_collected : null };
  for (const [key, value] of Object.entries(stats)) panel.element.querySelector(`[data-stat="${key}"]`).textContent = value == null ? "—" : number(value);
  panel.canvas.setAttribute("aria-label", data ? `${modelSlug(run.model)} ${modeName(run)} heatmap: ${number(data.map.points.length)} tiles visited, ${number(data.map.total)} visits.` : "Heatmap unavailable");
}
function fitScreenshotLabels() {
  for (const panel of panels) panel.label.style.removeProperty("font-size");
  if (!screenshotMode || !panels.length) return;
  const size = Math.min(...panels.map(({ label }) => {
    const preferred = parseFloat(getComputedStyle(label).fontSize), range = document.createRange(); range.selectNodeContents(label);
    return preferred * Math.min(1, Math.max(1, label.clientWidth - 2) / Math.max(1, range.getBoundingClientRect().width));
  }));
  for (const panel of panels) panel.label.style.fontSize = `${Math.floor(size * 100) / 100}px`;
}
function drawMaps() {
  if (gemMode) { gemComparison.draw(); return; }
  if (!panels.length) return;
  const maps = panels.map(panel => panel.data?.map), bounds = comparisonBounds(maps, fullWorld), scale = colorSelect.value, colors = comparisonScale(maps, scale), crops = maps.map(croppedBounds);
  const grid = $("comparison-panels"); fitScreenshotLabels();
  const labelHeight = screenshotMode ? Math.max(...panels.map(panel => panel.label.clientHeight)) : 0;
  const screenshotCell = screenshotMode ? Math.max(.05, Math.min(
    (grid.clientWidth - parseFloat(getComputedStyle(grid).columnGap) * (panels.length - 1)) / panels.length / Math.max(...crops.map(crop => crop.columns)),
    (window.innerHeight - 72 - labelHeight - gifExport.height()) / Math.max(...crops.map(crop => crop.rows))
  )) : 1;
  $("explored-area").setAttribute("aria-pressed", String(!fullWorld)); $("full-world").setAttribute("aria-pressed", String(fullWorld));
  for (const button of controls.querySelectorAll("[data-scale]")) button.setAttribute("aria-pressed", String(button.dataset.scale === scale));
  for (const [index, panel] of panels.entries()) {
    panel.layout = drawComparisonMap(panel.canvas, panel.data?.map, screenshotMode ? crops[index] : bounds, scale, colors, selectedTile, { screenshotMode, screenshotCell });
    const count = panel.data?.map.counts.get(`${selectedTile?.x},${selectedTile?.y}`) || 0;
    panel.element.querySelector(".tile-readout").textContent = !panel.data ? "" : !selectedTile ? `${number(panel.data.map.total)} visits` : `${roomAt(selectedTile)} · ${number(count)} visits${scale === "share" ? ` · ${percent(panel.data.map.total ? count / panel.data.map.total * 100 : 0)}` : ""}`;
  }
  $("comparison-legend").hidden = !colors.maximum;
  const format = scale === "share" ? percent : number;
  $("legend-min").textContent = format(colors.minimum); $("legend-max").textContent = format(colors.maximum);
  $("legend-label").textContent = scale === "share" ? "Share of visits" : "Visits per tile";
  $("screenshot-mode").disabled = !panels.length || !panels.every(panel => panel.data?.map.points.length);
}
function setScreenshotMode(active) {
  if (active && $("screenshot-mode").disabled) return;
  if (active) previousScroll = window.scrollY;
  else if (document.activeElement?.classList.contains("screenshot-model-name")) document.activeElement.blur();
  screenshotMode = active; selectedTile = null;
  document.documentElement.classList.toggle("screenshot-mode", active); gifExport.setVisible(active && !gemMode);
  screenshotReturn.hidden = !active || !gemMode;
  for (const panel of panels) { panel.canvas.tabIndex = active ? -1 : 0; panel.label.contentEditable = active ? "plaintext-only" : "false"; panel.label.tabIndex = active ? 0 : -1; }
  document.querySelector(".gem-chart").tabIndex = active ? -1 : 0;
  if (active) { document.querySelector(".map-options").open = false; document.querySelector(".compare-main").focus({ preventScroll: true }); window.scrollTo(0, 0); }
  else { $("screenshot-mode").focus({ preventScroll: true }); window.scrollTo(0, previousScroll); }
  drawMaps();
}
async function loadSelection() {
  const generation = ++serial; selectedTile = null;
  if(!panels.some(panel=>panel.id===focusedRun)) focusedRun=null;
  syncPanels(); gemComparison.setSelection(panels.map(panel=>panel.id)); gemComparison.setFocus(focusedRun); updateURL();
  if (gemMode) { await gemComparison.load(); return; }
  $("comparison-status").classList.remove("error"); $("comparison-status").textContent = "Loading…";
  let failed = false;
  const queue = [...panels];
  for (const panel of queue) {
    if (panel.dataId !== panel.id) panel.data = null;
    panel.message.hidden = Boolean(panel.data); panel.message.textContent = panel.id ? "Loading heatmap…" : "Choose a text or vision run";
    panel.element.setAttribute("aria-busy", String(Boolean(panel.id))); renderPanel(panel);
  }
  drawMaps();
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length && serial === generation) {
      const panel = queue.shift(), id = panel.id; if (!id) { panel.element.setAttribute("aria-busy", "false"); continue; }
      try {
        const data = await report(id); if (serial !== generation) return;
        panel.data = data; panel.dataId = id; panel.message.hidden = Boolean(data.map.points.length); panel.message.textContent = "No recorded visits yet";
      } catch (error) { if (serial !== generation) return; failed = true; panel.data = null; panel.message.hidden = false; panel.message.textContent = `Couldn’t load heatmap. ${error.message}`; }
      finally { if (serial === generation) { panel.element.setAttribute("aria-busy", "false"); renderPanel(panel); drawMaps(); } }
    }
  }));
  if (serial !== generation) return;
  $("comparison-status").classList.toggle("error", failed); $("comparison-status").textContent = failed ? "Some heatmaps couldn’t load · Try Refresh" : "";
}
async function refresh(initial = false) {
  if (refreshing) return;
  refreshing = true; $("refresh-comparison").disabled = true;
  try {
    const [local, imported] = await Promise.allSettled([api("/api/benchmark/v1/runs?view=library"), importedJSON("../imports/index.json")]);
    if (local.status === "rejected" && imported.status === "rejected") throw local.reason;
    runs = selectRuns([...(local.value?.runs || []), ...(imported.value?.runs || [])].filter(run => !run.world || run.world === "main-world"));
    if (initial) {
      const requested = params.getAll("map").length ? params.getAll("map") : params.getAll("run");
      const choices = requested.length || params.has("selection") ? [...new Set(requested)] : defaultComparison(runs, params.get("left"), params.get("right"), params.get("third"), params.get("models") === "3" || params.has("third") ? 3 : 2);
      for (const id of choices) if(runs.some(run=>run.id===id)) createPanel(id);
    }
    syncPanels(); cache.clear(); pending.clear();
    gemComparison.setRuns(runs, panels.map(panel => panel.id)); await loadSelection();
    const warnings = [local.status === "rejected" ? "Local runs unavailable" : "", imported.status === "rejected" ? "Imported heatmaps unavailable" : ""].filter(Boolean);
    if (warnings.length) { $("comparison-status").textContent = warnings.join(" · "); $("comparison-status").classList.add("error"); }
  } catch (error) { $("comparison-status").classList.add("error"); $("comparison-status").textContent = `Couldn’t refresh runs. ${error.message}`; }
  finally { refreshing = false; $("refresh-comparison").disabled = false; $("add-comparison").disabled = !runs.length; }
}
$("add-comparison").disabled = true;
$("add-comparison").addEventListener("click", () => { const panel = createPanel(); syncPanels(); loadSelection(); openPicker(panel); });
$("refresh-comparison").addEventListener("click", () => refresh());
$("screenshot-mode").addEventListener("click", () => setScreenshotMode(true));
document.addEventListener("keydown", event => { if (screenshotMode && event.key === "Escape") { event.preventDefault(); setScreenshotMode(false); } });
$("explored-area").addEventListener("click", () => { fullWorld = false; selectedTile = null; updateURL(); drawMaps(); });
$("full-world").addEventListener("click", () => { fullWorld = true; selectedTile = null; updateURL(); drawMaps(); });
controls.addEventListener("click", event => { const button = event.target.closest("[data-scale]"); if (button) { colorSelect.value = button.dataset.scale; updateURL(); drawMaps(); } });
observer.observe($("comparison-panels")); window.addEventListener("resize", drawMaps); refresh(true);
