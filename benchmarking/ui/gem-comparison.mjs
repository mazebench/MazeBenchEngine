import { renderProgressChart } from './comparison-chart.mjs';
import { X_AXES, RUN_CAP_LABEL, capRunHistory, runCapIndex, LOG_COST_MINIMUM, progressSeries, logarithmicScale } from './comparison-chart-data.mjs';
import { codingLabel, codingMode } from "../capabilities.mjs";
import { benchmarkFetch } from "./benchmark-api.mjs";
import { runCompany, runCardValues, selectRuns } from "./run-library.mjs";
import { displayModelName } from "./heatmap-comparison.mjs";
import { gemSeries, gemsAt, gemLinePath, axisExtent, layoutEndLabels, limitGemSeries } from "./gem-comparison-data.mjs";
import { comparisonGemCount, correctedGemSeries, editedGemSeries, moveGemPoint } from "./gem-comparison-edits.mjs";
import { gemMarker } from "./gem-comparison-markers.mjs";

const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const number = value => value.toLocaleString();
const score = value => `${(value.collected / value.total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const familyColors = { claude:'#ff9b45', gemini:'#b18cff', gemma:'#b18cff', gpt:'#72c7ff', grok:'#ff7db8', kimi:'#67d88b' };
const familyFallbacks = ['#4fd6c8','#ff7db8','#f3c05f','#7ea6ff','#ff8a72','#cf8cff','#d8dd6b'];
function modelColor(run) {
  const family=displayModelName(run.model).split('-')[0].replace(/[^a-z0-9]/g,'');
  let hash=0; for(const char of family) hash=(hash*31+char.charCodeAt(0))>>>0;
  return familyColors[family] || familyFallbacks[hash%familyFallbacks.length];
}
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function createGemComparison({ onChange, onSelectionChange, onFocus }) {
  const root = document.createElement("section");
  root.className = "gem-comparison";
  root.hidden = true;
  root.innerHTML = `
    <div class="gem-controls"><button type="button" class="comparison-filter-open">☷ Filters & runs <span class="gem-selection-count"></span></button><span class="comparison-filter-summary"></span>
      <label class="scale-control">X-axis scale <select class="comparison-x-scale"><option value="linear">Linear</option><option value="log">Logarithmic</option></select></label>
      <label class="scale-control comparison-run-cap"><input type="checkbox">Cap runs at ${RUN_CAP_LABEL}</label></div>
    <dialog class="chart-filters" aria-labelledby="chart-filter-title"><header><h2 id="chart-filter-title">Comparison</h2><button class="chart-filter-done" type="button">Done</button></header>
      <div class="chart-filter-fields">
        <fieldset><legend>Score</legend><div class="map-segments" data-setting="metric"><button data-value="gems">Gems</button><button data-value="rooms">Rooms</button></div></fieldset>
        <fieldset><legend>Compare by</legend><div class="map-segments chart-axis-picker" data-setting="axis">${Object.entries(X_AXES).map(([key,label]) => `<button data-value="${key}">${label}</button>`).join("")}</div></fieldset>
        <fieldset><legend>Observations</legend><div class="map-segments" data-setting="mode"><button data-value="all">All</button><button data-value="ascii">ASCII</button><button data-value="vision">Vision</button></div></fieldset>
        <fieldset><legend>Coding tools</legend><div class="map-segments" data-setting="coding"><button data-value="all">All</button><button data-value="off">Off</button><button data-value="on">On</button></div></fieldset>
        <fieldset><legend>Sort by</legend><div class="map-segments" data-setting="sort"><button data-value="score">Best score</button><button data-value="recent">Most recent</button></div></fieldset>
        <fieldset><legend>Companies</legend><div class="chart-companies"></div></fieldset>
        <details class="chart-advanced"><summary>Chart options</summary><div class="gem-axis-controls"><div class="gem-max-control"><label class="scale-control">Max moves <input class="gem-max-moves" type="number" min="1" step="1" placeholder="Auto" inputmode="numeric"></label><button type="button" class="gem-max-auto">Auto</button></div>
        <div class="map-segments" data-setting="range"><button data-value="auto">Auto scale</button><button data-value="full">Full scale</button></div><select class="gem-range" hidden><option value="auto">Auto</option><option value="100">Full</option></select></div></details>
      </div>
      <div class="gem-picker-toolbar"><input type="search" placeholder="Search models or companies" aria-label="Search runs"><button type="button" class="gem-select-visible">Select matching</button><button type="button" class="gem-clear">Clear</button></div>
      <div class="gem-run-list"></div><p class="gem-picker-note">The same selected runs appear in both views.</p>
    </dialog>
    <div class="gem-edit-controls"><button type="button" class="gem-edit-toggle" aria-pressed="false">Edit curve</button><button type="button" class="gem-edit-reset" disabled>Reset curve edits</button><span class="gem-edit-help">Drag points to reshape a curve. Edits are saved in this browser.</span><span class="gem-edit-status" role="status"></span></div>
    <article class="gem-chart-card">
      <header class="gem-chart-heading"><div><span>MAZEBENCH · MAIN WORLD</span><h2>Gems collected by move</h2></div><span class="gem-chart-count"></span></header>
      <div class="progress-chart"></div><div class="progress-legend"></div><p class="progress-notice" hidden></p><div class="gem-plot"><svg class="gem-chart" role="img" tabindex="0" aria-label="Gems collected by move"></svg><output class="gem-tooltip" hidden></output></div>
      <div class="gem-chart-legend"></div>
      <p class="gem-adjustment-note" hidden></p>
    </article>
    <p class="gem-chart-note">Lines connect collection milestones. Curve edits affect this comparison only. Max moves limits the chart and scores to that move. Moves include all recorded actions, including undo, reset and camera actions. Refresh to update.</p>`;
  document.getElementById("comparison-panels").before(root);
  const $ = selector => root.querySelector(selector);
  let runs = [], active = false, generation = 0, plot = null, loading = false, focusedId = null;
  const params = new URLSearchParams(location.search);
  const settings = { metric: params.get('metric') === 'rooms' ? 'rooms' : 'gems', axis: Object.hasOwn(X_AXES,params.get('axis')) ? params.get('axis') : 'moves', mode:'all', coding:'all', sort:'score', range:'auto' };
  const xScaleControl = $('.comparison-x-scale');
  xScaleControl.value = params.get('xScale') === 'log' ? 'log' : 'linear';
  const logX = () => xScaleControl.value === 'log';
  const runCapControl = $('.comparison-run-cap input');
  runCapControl.checked = params.get('runCap') === '1' || params.get('xCap') === '1';
  const companies = new Set(), histories = new Map();
  const markerIds = new Map();
  function markerIndex(id) { if (!markerIds.has(id)) markerIds.set(id,markerIds.size); return markerIds.get(id); }
  const filters = $('.chart-filters');
  $('.comparison-filter-open').addEventListener('click',()=>{ renderPicker(); filters.showModal(); });
  $('.chart-filter-done').addEventListener('click',()=>filters.close());
  filters.addEventListener('click',event=>{ if(event.target===filters) {const r=filters.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) filters.close();} });
  const selected = new Set(new URLSearchParams(location.search).getAll("run"));
  const savedMax = Number(new URLSearchParams(location.search).get("maxMoves"));
  let maxMoves = Number.isSafeInteger(savedMax) && savedMax > 0 ? savedMax : null;
  $(".gem-max-moves").value = maxMoves ?? "";
  const data = new Map(), requests = new Map(), errors = new Map();
  const storageKey = "mazebench-gem-curve-edits-v1";
  let edits = {}, editing = false, drag = null, selectedPoint = null;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.version === 1 && saved.runs && typeof saved.runs === "object" && !Array.isArray(saved.runs)) edits = saved.runs;
  } catch { /* A missing or unavailable local store starts with recorded curves. */ }
  const fullSeries = run => editedGemSeries(data.get(run.id), edits[run.id]);
  function saveEdits() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ version: 1, runs: edits }));
      $(".gem-edit-status").textContent = "Saved in this browser.";
    } catch { $(".gem-edit-status").textContent = "Browser storage unavailable; edits last until reload."; }
  }
  const matches = run => (settings.mode === 'all' || (run.observation_mode || 'ascii') === settings.mode)
    && (settings.coding === 'all' || (codingMode(run) === 'off' ? 'off' : 'on') === settings.coding)
    && (!companies.size || companies.has(runCompany(run)));
  const sorted = list => list.sort((a,b) => settings.sort === 'recent' ? String(b.created_at||'').localeCompare(a.created_at||'') : (settings.metric === 'rooms' ? (b.rooms_visited||0)-(a.rooms_visited||0) : comparisonGemCount(b)-comparisonGemCount(a)) || String(b.created_at||'').localeCompare(a.created_at||''));
  const filtered = () => sorted(runs.filter(run => matches(run) && `${displayModelName(run.model)} ${runCompany(run)} ${run.id}`.toLowerCase().includes($('input[type="search"]').value.toLowerCase())));
  function filterSelection() {
    // Applying a filter updates the shared comparison, including the heatmaps.
    selected.clear(); for (const run of filtered()) selected.add(run.id);
    changed();
  }
  filters.addEventListener('click', event => {
    const button=event.target.closest('[data-setting] [data-value]');
    if (button) {
      const key=button.closest('[data-setting]').dataset.setting; settings[key]=button.dataset.value;
      if (['mode','coding'].includes(key)) filterSelection();
      else if(key==='sort') {const ids=sorted(selectedRuns()).map(run=>run.id);selected.clear();ids.forEach(id=>selected.add(id));changed();}
      else { if (settings.metric !== 'gems' || settings.axis !== 'moves') editing=false; $('.gem-range').value=settings.range==='full'?'100':'auto'; syncURL(); renderPicker(); draw(); }
    }
    const company=event.target.closest('[data-company]');
    if(company) { const key=company.dataset.company; if(!key) companies.clear(); else if(companies.has(key)) companies.delete(key); else companies.add(key); filterSelection(); }
  });
  const selectedRuns = () => [...selected].map(id => runs.find(run => run.id === id)).filter(Boolean);
  const detail = run => `${run.effort || 'Default'} · ${codingLabel(run)} · ${run.observation_mode === 'vision' ? 'Vision' : 'ASCII'} · ${run.id.slice(-6)}`;
  function syncURL() {
    const url = new URL(location.href);
    url.searchParams.set('axis',settings.axis); url.searchParams.set('metric',settings.metric);
    if (logX()) url.searchParams.set('xScale', 'log'); else url.searchParams.delete('xScale');
    url.searchParams.delete('xCap');
    if (runCapControl.checked) url.searchParams.set('runCap', '1'); else url.searchParams.delete('runCap');
    if (maxMoves === null) url.searchParams.delete("maxMoves"); else url.searchParams.set("maxMoves", maxMoves);
    history.replaceState(null, "", url);
  }
  function renderPicker() {
    $(".gem-selection-count").textContent = `${selected.size} selected`;
    for (const button of filters.querySelectorAll('[data-setting] [data-value]')) button.setAttribute('aria-pressed',String(settings[button.closest('[data-setting]').dataset.setting]===button.dataset.value));
    const companyNames=[...new Set(runs.map(runCompany))].sort();
    $('.chart-companies').innerHTML=`<button data-company="" aria-pressed="${!companies.size}">All</button>`+companyNames.map(company=>{ const values=runCardValues(runs.find(run=>runCompany(run)===company)); return `<button data-company="${escape(company)}" aria-pressed="${companies.has(company)}">${values.logo?`<img src="${escape(values.logo)}" class="${values.monochromeLogo?'monochrome':''}" alt="">`:''}${escape(company)}</button>`; }).join('');
    $('.comparison-filter-summary').textContent=`${settings.metric==='gems'?'Gems':'Rooms'} · ${X_AXES[settings.axis]}`;
    $('.gem-max-control').hidden=settings.axis!=='moves';
    const visible = filtered();
    $(".gem-run-list").innerHTML = visible.length ? visible.map(run => `
      <label class="gem-run-option"><input type="checkbox" value="${escape(run.id)}" ${selected.has(run.id) ? "checked" : ""}>
        <span><strong>${escape(displayModelName(run.model))}</strong><small>${escape(detail(run))} · ${run.created_at ? escape(dates.format(new Date(run.created_at))) : "Undated"} · ${escape(run.id.slice(-6))}</small></span>
        <span class="gem-run-score">${number(settings.metric==='rooms' ? (run.rooms_visited||0) : fullSeries(run)?.collected ?? comparisonGemCount(run))} ${settings.metric}</span></label>`).join("") : '<p class="gem-empty-list">No matching runs.</p>';
  }
  function changed() {
    syncURL(); renderPicker(); onSelectionChange?.([...selected]); load();
  }
  $(".gem-run-list").addEventListener("change", event => {
    if (!event.target.matches('input[type="checkbox"]')) return;
    if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value);
    changed();
  });
  $('input[type="search"]').addEventListener("input", renderPicker);

  $(".gem-select-visible").addEventListener("click", () => { for (const run of filtered()) selected.add(run.id); changed(); });
  $(".gem-clear").addEventListener("click", () => { selected.clear(); changed(); });
  xScaleControl.addEventListener('change', () => { finishDrag(true); syncURL(); draw(); });
  runCapControl.addEventListener('change', () => { finishDrag(true); syncURL(); draw(); });
  $(".gem-range").addEventListener("change", draw);
  $(".gem-max-moves").addEventListener("input", event => {
    const input = event.target, value = input.value === "" ? null : input.valueAsNumber;
    const valid = !input.validity.badInput && (value === null || Number.isSafeInteger(value) && value > 0);
    input.setCustomValidity(valid ? "" : "Enter a positive whole number, or leave blank for Auto.");
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid) return;
    maxMoves = value; syncURL(); draw();
  });
  $(".gem-max-moves").addEventListener("change", event => event.target.reportValidity());
  $(".gem-max-auto").addEventListener("click", () => {
    maxMoves = null;
    $(".gem-max-moves").value = ""; $(".gem-max-moves").setCustomValidity(""); $(".gem-max-moves").removeAttribute("aria-invalid");
    syncURL(); draw();
  });
  $(".gem-chart-legend").addEventListener("click", event => {
    const button = event.target.closest("button[data-remove]");
    if (button) { selected.delete(button.dataset.remove); changed(); }
  });
  $(".gem-edit-toggle").addEventListener("click", () => {
    editing = !editing; selectedPoint = null;
    $(".gem-edit-status").textContent = ""; draw();
  });
  $(".gem-edit-reset").addEventListener("click", () => {
    for (const id of selected) delete edits[id];
    selectedPoint = null; saveEdits(); renderPicker(); draw();
  });

  async function report(run) {
    if (data.has(run.id)) return data.get(run.id);
    if (requests.has(run.id)) return requests.get(run.id);
    const request = (async () => {
      let value;
      if (run.source) {
        const response=await fetch(new URL(`../imports/${encodeURIComponent(run.id)}.json`,import.meta.url));
        if(!response.ok) throw new Error(`Couldn’t load history (${response.status})`);
        value=await response.json();
      } else {
        const response=await benchmarkFetch(`/api/benchmark/v1/runs/${encodeURIComponent(run.id)}/comparison`,{signal:AbortSignal.timeout(60000)});
        if(!response.ok) throw new Error(`Couldn’t load history (${response.status})`);
        value=await response.json();
      }
      histories.set(run.id,value.series || {});
      const progress=value.series?.progress || [];
      const result=correctedGemSeries(gemSeries({available:progress.length>0,points:progress.map(p=>({move:p.moves,gems:p.gems})),moves:progress.at(-1)?.moves,total:run.gems_total||100}),run.id);
      data.set(run.id,result); errors.delete(run.id);
      return result;
    })().finally(() => requests.delete(run.id));
    requests.set(run.id, request);
    return request;
  }
  async function load() {
    const token = ++generation;
    if (!active) return;
    loading = true; draw();
    const queue = selectedRuns().filter(run => !data.has(run.id));
    // Keep large selections from flooding the live server with history reads.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length && token === generation && active) {
        const run = queue.shift();
        try { await report(run); } catch (error) { errors.set(run.id, error.message); }
        if (token === generation) draw();
      }
    }));
    if (token !== generation) return;
    loading = false; renderPicker(); draw();
  }
  function drawProgress() {
    const chosen=selectedRuns();
    const entries=chosen.map(run=>{
      const series={...histories.get(run.id)};
      const exclusion=fullSeries(run)?.exclusion;
      if(exclusion) for(const key of ['progress','performance','thinking']) series[key]=series[key]?.map(p=>({...p,gems:p.gems===null?null:Math.max(0,p.gems-(p.moves>=exclusion.move?1:0))}));
      if(settings.axis==='moves' && settings.metric==='gems') {
        const value=limitGemSeries(fullSeries(run),maxMoves);
        series.progress=value?.points.map(p=>({moves:p.move,gems:p.gems})) || [];
      } else if(settings.axis==='moves' && maxMoves!==null) {
        const points=(series.progress||[]).filter(p=>p.moves<=maxMoves);
        if(points.length && points.at(-1).moves<maxMoves && maxMoves<(series.progress.at(-1)?.moves||0)) points.push({...points.at(-1),moves:maxMoves});
        series.progress=points;
      }
      return {...run,series:runCapControl.checked ? capRunHistory(series) : series};
    });
    renderProgressChart({host:$('.progress-chart'),legend:$('.progress-legend'),notice:$('.progress-notice'),entries,axis:settings.axis,metric:settings.metric,logX:logX(),
      selectedIds:new Set(focusedId?[focusedId]:[]), name:displayModelName, detail, markerIndex, fullRange:settings.range==='full', color:modelColor,onSelect:id=>{focusedId=id;onFocus?.(id);draw();}});
    $('.gem-chart-heading h2').textContent=settings.metric==='gems'?'Gems collected':'Rooms visited';
    $('.gem-chart-count').textContent=loading?`Loading ${chosen.filter(run=>histories.has(run.id)).length} / ${chosen.length}`:'';
    const status=document.getElementById('comparison-status');status.classList.toggle('error',chosen.some(run=>errors.has(run.id)));
    status.textContent=loading?'Loading run history…':chosen.some(run=>errors.has(run.id))?'Some histories couldn’t load · Refresh to retry':'';
    if(loading) { $('.progress-notice').hidden=false; $('.progress-notice').textContent='Loading recorded history…'; }
    $('.gem-chart-note').textContent=settings.axis==='thinking_ms'
      ? 'Thinking time sums completed episodes, including model and network waiting. Fast mode counts at 2× elapsed time. Tool execution and interrupted intervals are excluded.'
      : 'Lines connect recorded milestones. Token and cost comparisons use recorded responses, including retries; unreported usage is excluded.';
    const edited=chosen.some(run=>fullSeries(run)?.edited);
    $('.gem-adjustment-note').textContent=[settings.axis==='moves'&&settings.metric==='gems'&&edited?'Edited curves shown. Reset curve edits to return to recorded history.':'',...chosen.filter(run=>fullSeries(run)?.exclusion).map(run=>`${displayModelName(run.model)}: ${fullSeries(run).exclusion.room} gem excluded.`)].filter(Boolean).join(' ');
    $('.gem-adjustment-note').hidden=!$('.gem-adjustment-note').textContent;
    $('.gem-edit-reset').disabled=!edited;
    $('.gem-edit-toggle').textContent='Edit curve'; $('.gem-edit-toggle').setAttribute('aria-pressed','false');
    onChange();
  }
  function editingSeries(run) {
    const history = histories.get(run.id);
    const index = runCapControl.checked ? runCapIndex(history) : -1;
    if (index === 0) return null;
    const cutoff = index > 0 ? history.performance[index - 1].moves : Infinity;
    return limitGemSeries(fullSeries(run), Math.min(maxMoves ?? Infinity, cutoff));
  }
  function draw() {
    if (!active) return;
    $('.progress-chart').hidden=editing; $('.progress-legend').hidden=editing; $('.progress-notice').hidden=editing;
    $('.gem-plot').hidden=!editing; $('.gem-chart-legend').hidden=!editing;
    $('.gem-edit-controls').hidden=settings.axis!=='moves'||settings.metric!=='gems';
    if(!editing) { plot=null; drawProgress(); return; }
    const chosen = selectedRuns();
    const series = chosen.map(run => ({ run, data: editingSeries(run), color: modelColor(run), marker: markerIndex(run.id) })).filter(item => item.data);
    const screenshot = document.documentElement.classList.contains("screenshot-mode");
    const handles = editing && !screenshot;
    const svg = $(".gem-chart"), width = Math.max(360, svg.clientWidth || 1000);
    svg.classList.toggle("editing", handles); svg.classList.toggle("dragging", Boolean(drag));
    svg.setAttribute("role", handles ? "group" : "img");
    svg.setAttribute("aria-label", handles ? "Edit gem curves. Focus a point and use arrow keys; Shift moves faster." : "Gems collected by move");
    $(".gem-edit-toggle").setAttribute("aria-pressed", String(editing));
    $(".gem-edit-toggle").textContent = editing ? "Done editing" : "Edit curve";
    $(".gem-edit-reset").disabled = !chosen.some(run => fullSeries(run)?.edited);
    $(".gem-edit-help").textContent = editing ? "Drag a point, or focus it and use arrow keys (Shift for larger steps). Recorded runs stay unchanged." : "Drag points to reshape a curve. Edits are saved in this browser.";
    const labelFont = width < 550 ? 11 : 13;
    const measure = document.createElement("canvas").getContext("2d");
    measure.font = `550 ${labelFont}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const labels = series.map(item => {
      const text = displayModelName(item.run.model);
      return { item, text, measuredWidth: measure.measureText(text).width + 44 };
    });
    const labelSpace = Math.min(width * .45, Math.max(0, ...labels.map(label => label.measuredWidth))) + 24;
    const height = Math.max(Math.min(620, Math.max(330, width * .43)), labels.length * 40 + 110);
    const left = width < 550 ? 48 : 66, right = width - labelSpace - 12, top = 30, bottom = height - 58;
    const xDivisions = width < 550 ? 3 : 6;
    const xAxis = drag?.xAxis || axisExtent(maxMoves ?? Math.max(1, ...series.map(item => item.data.moves)), xDivisions);
    if (!drag && maxMoves !== null) xAxis.max = maxMoves;
    const logAxis = logX() ? logarithmicScale(xAxis.max, xDivisions) : null;
    const peak = Math.max(1, ...series.flatMap(item => item.data.points.map(point => point.gems)));
    const yAxis = drag?.yAxis || ($(".gem-range").value === "100" ? { max: Math.max(100, peak), step: 20 } : axisExtent(peak));
    const x = move => left + (logAxis ? logAxis.position(move) : move / xAxis.max) * (right - left);
    const moveAt = fraction => logAxis ? logAxis.valueAt(fraction) : fraction * xAxis.max;
    const y = gems => bottom - gems / yAxis.max * (bottom - top);
    let markup = `<title>Gems collected by move</title><desc>${escape(series.map(item => `${displayModelName(item.run.model)}: ${item.data.collected} gems at ${item.data.moves} moves`).join(". "))}</desc>`;
    for (let value = 0; value <= yAxis.max; value += yAxis.step) markup += `<line class="gem-grid" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/><text class="gem-axis" x="${left - 12}" y="${y(value) + 4}" text-anchor="end">${number(value)}</text>`;
    const xTicks = logAxis?.ticks ?? [];
    if (!logAxis) {
      for (let value = 0; value < xAxis.max - xAxis.step * .35; value += xAxis.step) xTicks.push(value);
      xTicks.push(xAxis.max);
    }
    for (const value of xTicks) markup += `<line class="gem-grid gem-grid-vertical" x1="${x(value)}" x2="${x(value)}" y1="${top}" y2="${bottom}"/><text class="gem-axis" x="${x(value)}" y="${bottom + 25}" text-anchor="middle">${number(value)}</text>`;
    markup += `<text class="gem-axis-label" x="${left}" y="16">Gems collected</text><text class="gem-axis-label" x="${(left + right) / 2}" y="${height - 8}" text-anchor="middle">${logAxis ? 'Moves (log scale)' : 'Moves'}</text>`;
    for (const item of series) {
      const points = item.data.points;
      markup += `<g style="--series:${item.color}"><path class="gem-comparison-line" d="${gemLinePath(points, x, y)}"/>`;
      for (let i = 0; i < points.length; i++) if (i === points.length - 1 || (i > 0 && (handles || points[i].gems !== points[i - 1].gems))) {
        const point = points[i], editable = handles && i > 0 && point.key;
        const focused = selectedPoint?.runId === item.run.id && selectedPoint?.key === point.key;
        const label = `${displayModelName(item.run.model)} · move ${number(point.move)} · ${number(point.gems)} gems`;
        const marker = gemMarker(item.marker, editable ? 7 : 4.5);
        markup += `<g class="gem-comparison-point${editable ? " gem-edit-point" : ""}${focused ? " selected" : ""}" transform="translate(${x(point.move)},${y(point.gems)})"${editable ? ` data-run="${escape(item.run.id)}" data-point="${escape(point.key)}" tabindex="0" role="button" aria-label="${escape(label)}. ${marker.name} marker. Drag or use arrow keys to edit."` : ""}><title>${escape(label)} · ${marker.name}</title>${editable ? '<circle class="gem-point-hit" r="10"/>' : ""}${marker.body}</g>`;
      }
      markup += "</g>";
    }
    const endLabels = layoutEndLabels(labels.map(label => ({ ...label,
      x: x(label.item.data.moves) + 12, y: y(label.item.data.collected),
      width: Math.min(label.measuredWidth, labelSpace - 24)
    })), top + 18, bottom - 18, 40);
    for (const label of endLabels) {
      const nameWidth = label.width - 44;
      const fit = label.measuredWidth > label.width ? ` textLength="${nameWidth}" lengthAdjust="spacingAndGlyphs"` : "";
      const badgeX = label.x + nameWidth + 27;
      markup += `<g style="--series:${label.item.color}"><path class="gem-end-connector" d="M${label.x - 7},${label.y}L${label.x - 3},${label.labelY}"/><text class="gem-end-label" x="${label.x}" y="${label.labelY}" style="font-size:${labelFont}px"${fit}>${escape(label.text)}</text><circle class="gem-end-score-ring" cx="${badgeX}" cy="${label.labelY}" r="17"/><text class="gem-end-score" x="${badgeX}" y="${label.labelY}">${score(label.item.data)}</text></g>`;
    }
    if (!series.length) markup += `<text class="gem-empty" x="${(left + right) / 2}" y="${height / 2}" text-anchor="middle">${loading && chosen.length ? "Loading gem history…" : chosen.length ? "No gem history available" : "Choose runs to compare"}</text>`;
    markup += `<line class="gem-crosshair" x1="0" x2="0" y1="${top}" y2="${bottom}" visibility="hidden"/>`;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`); svg.style.height = `${height}px`;
    svg.innerHTML = markup;
    $(".gem-tooltip").hidden = true;
    $(".gem-chart-count").textContent = `${series.length} ${series.length === 1 ? "run" : "runs"}${maxMoves === null ? "" : ` · through move ${number(maxMoves)}`}`;
    $(".gem-chart-legend").innerHTML = chosen.map(run => {
      const full = fullSeries(run), value = editingSeries(run), duplicate = chosen.filter(item => item.model === run.model).length > 1;
      const marker = gemMarker(markerIndex(run.id), 5);
      return `<div class="gem-legend-item" style="--series:${modelColor(run)}"><svg class="gem-legend-marker" viewBox="0 0 28 20" role="img" aria-label="${marker.name} markers"><path class="gem-marker-line" d="M0,10H28"/><g class="gem-comparison-point" transform="translate(14,10)">${marker.body}</g></svg><div><strong>${escape(displayModelName(run.model))}</strong><small>${escape(detail(run))}${duplicate ? ` · ${escape(run.id.slice(-6))}` : ""}${full?.edited ? " · Edited curve" : ""}</small><span>${value ? `${score(value)} · ${number(value.moves)}${value.moves < full.moves ? ` / ${number(full.moves)}` : ""} moves` : escape(errors.get(run.id) || (full ? "No history in this range" : "Loading…"))}</span></div><button type="button" data-remove="${escape(run.id)}" aria-label="Remove ${escape(displayModelName(run.model))} ${escape(run.id.slice(-6))}">×</button></div>`;
    }).join("");
    const notes = series.filter(item => item.data.exclusion).map(item => `${displayModelName(item.run.model)}: ${item.data.exclusion.room} gem excluded.`);
    if (series.some(item => item.data.edited)) notes.push("Edited curves shown.");
    $(".gem-adjustment-note").textContent = notes.join(" ");
    $(".gem-adjustment-note").hidden = !notes.length;
    plot = { x, y, moveAt, xAxis, yAxis, left, right, top, bottom, width, height, series, move: 0 };
    const status = document.getElementById("comparison-status");
    const failed = chosen.some(run => errors.has(run.id));
    status.classList.toggle("error", failed);
    status.textContent = loading ? `Loading history · ${series.length}/${chosen.length} runs` : failed ? "Some histories couldn’t load · Refresh to retry" : `${series.length} runs compared`;
    onChange();
  }
  function inspect(move) {
    if (!plot?.series.length || document.documentElement.classList.contains("screenshot-mode")) return;
    plot.move = Math.max(0, Math.min(plot.xAxis.max, Math.round(move)));
    const tooltip = $(".gem-tooltip");
    tooltip.innerHTML = `<strong>Move ${number(plot.move)}</strong>` + plot.series.map(item => {
      const value = gemsAt(item.data, plot.move);
      return `<span><i style="background:${item.color}"></i>${escape(displayModelName(item.run.model))}<b>${value === null ? "—" : `${number(value)} gems`}</b></span>`;
    }).join("");
    tooltip.hidden = false;
    tooltip.style.left = `${Math.max(8, Math.min(plot.width - tooltip.offsetWidth - 8, plot.x(plot.move) + 14))}px`;
    const crosshair = $(".gem-crosshair");
    crosshair.setAttribute("x1", plot.x(plot.move)); crosshair.setAttribute("x2", plot.x(plot.move)); crosshair.setAttribute("visibility", "visible");
  }
  function updatePoint(runId, key, position) {
    const run = runs.find(run => run.id === runId), full = run && fullSeries(run);
    const value = moveGemPoint(full, key, position);
    if (!value) return;
    if (!edits[runId] || typeof edits[runId] !== "object" || Array.isArray(edits[runId])) edits[runId] = {};
    edits[runId][key] = value;
    selectedPoint = { runId, key };
    draw();
    $(".gem-edit-status").textContent = `${displayModelName(run.model)} · move ${number(value.move)} · ${number(value.gems)} gems`;
  }
  function finishDrag(cancel = false) {
    if (!drag) return;
    const previous = drag; drag = null;
    const svg = $(".gem-chart");
    if (svg.hasPointerCapture(previous.pointerId)) svg.releasePointerCapture(previous.pointerId);
    if (cancel) { edits[previous.runId] = previous.before; $(".gem-edit-status").textContent = "Drag cancelled."; }
    else saveEdits();
    renderPicker(); draw();
    [...svg.querySelectorAll(".gem-edit-point")].find(point => point.dataset.run === previous.runId && point.dataset.point === previous.key)?.focus({ preventScroll: true });
  }
  $(".gem-chart").addEventListener("pointerdown", event => {
    if (!editing || drag || !plot || event.button !== 0 || document.documentElement.classList.contains("screenshot-mode")) return;
    const point = event.target.closest(".gem-edit-point");
    if (!point) return;
    event.preventDefault();
    const runId = point.dataset.run, key = point.dataset.point;
    drag = { runId, key, pointerId: event.pointerId, before: structuredClone(edits[runId] || {}), xAxis: { ...plot.xAxis }, yAxis: { ...plot.yAxis } };
    selectedPoint = { runId, key };
    event.currentTarget.setPointerCapture(event.pointerId);
    point.focus();
  });
  $(".gem-chart").addEventListener("pointermove", event => {
    if (!plot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = ((event.clientX - rect.left) * plot.width / rect.width - plot.left) / (plot.right - plot.left);
    const move = plot.moveAt(Math.max(0, Math.min(1, fraction)));
    if (drag && drag.pointerId === event.pointerId) {
      const gems = (plot.bottom - (event.clientY - rect.top) * plot.height / rect.height) / (plot.bottom - plot.top) * plot.yAxis.max;
      updatePoint(drag.runId, drag.key, { move, gems: Math.max(0, Math.min(plot.yAxis.max, gems)) });
      return;
    }
    if (editing) return;
    inspect(move);
  });
  $(".gem-chart").addEventListener("pointerup", event => { if (event.pointerId === drag?.pointerId) finishDrag(); });
  $(".gem-chart").addEventListener("pointercancel", event => { if (event.pointerId === drag?.pointerId) finishDrag(true); });
  $(".gem-chart").addEventListener("lostpointercapture", event => { if (event.pointerId === drag?.pointerId) finishDrag(true); });
  $(".gem-chart").addEventListener("pointerleave", () => { $(".gem-tooltip").hidden = true; $(".gem-crosshair")?.setAttribute("visibility", "hidden"); });
  $(".gem-chart").addEventListener("keydown", event => {
    if (drag && event.key === "Escape") { event.preventDefault(); finishDrag(true); return; }
    const point = event.target.closest(".gem-edit-point");
    if (editing && point && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const runId = point.dataset.run, key = point.dataset.point, run = runs.find(run => run.id === runId);
      const current = fullSeries(run).points.find(point => point.key === key);
      const moveStep = event.shiftKey ? Math.max(10, Math.round(plot.xAxis.max / 100)) : 1;
      updatePoint(runId, key, { move: current.move + (event.key === "ArrowRight" ? moveStep : event.key === "ArrowLeft" ? -moveStep : 0),
        gems: current.gems + (event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0) * (event.shiftKey ? 5 : 1) });
      saveEdits(); renderPicker();
      [...$(".gem-chart").querySelectorAll(".gem-edit-point")].find(point => point.dataset.run === runId && point.dataset.point === key)?.focus();
      return;
    }
    if (!plot || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    inspect(event.key === "Home" ? 0 : event.key === "End" ? plot.xAxis.max : plot.move + (event.key === "ArrowRight" ? 1 : -1) * Math.max(1, Math.round(plot.xAxis.max / 100)));
  });
  new ResizeObserver(draw).observe($(".gem-plot"));
  return {
    draw, load,
    canScreenshot: () => !loading && selectedRuns().some(run => {
      const history = histories.get(run.id);
      const series = runCapControl.checked ? capRunHistory(history) : history;
      return progressSeries({series}, settings.axis, settings.metric,
        logX() && settings.axis === 'cost_usd' ? LOG_COST_MINIMUM : 0).linePoints.length;
    }),
    setActive(value) { if (!value) finishDrag(true); active = value; root.hidden = !value; if (!value) { generation++; loading = false; } },
    setFocus(id) { focusedId=id; draw(); },
    setSelection(ids) { selected.clear(); for(const id of ids) if(runs.some(run=>run.id===id)) selected.add(id); renderPicker(); },
    setRuns(value, defaults) {
      finishDrag(true);
      runs=selectRuns(value,{sort:'company'});
      for(const run of runs) markerIndex(run.id);
      selected.clear(); for(const id of defaults) if(runs.some(run=>run.id===id)) selected.add(id);
      data.clear(); histories.clear(); errors.clear(); renderPicker();
    }
  };
}
