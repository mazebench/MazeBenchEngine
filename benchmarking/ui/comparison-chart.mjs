// Adapted from MazeJam’s published leaderboard-progress.mjs.
import {X_AXES, RUN_CAP_LABEL, LOG_COST_MINIMUM, progressSeries, linearPath, logarithmicScale} from './comparison-chart-data.mjs';
import {gemMarker} from './gem-comparison-markers.mjs';
import {layoutEndLabels} from './gem-comparison-data.mjs';
import {formatLevelDuration} from './ice-level-timings.mjs';

const NS = 'http://www.w3.org/2000/svg';
const compact = new Intl.NumberFormat(undefined, {notation:'compact', maximumFractionDigits:2});
const number = value => Math.round(value).toLocaleString();
const dollars = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits:6});
const compactDollars = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD', notation:'compact', maximumSignificantDigits:3});
const timeTick = milliseconds => {
  if (milliseconds >= 3_600_000) return `${compact.format(milliseconds / 3_600_000)}h`;
  if (milliseconds >= 60_000) return `${compact.format(milliseconds / 60_000)}m`;
  if (milliseconds > 0 && milliseconds < 1000) return `${number(milliseconds)}ms`;
  return `${compact.format(milliseconds / 1000)}s`;
};
const node = (tag, attrs={}) => {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
};
const text = (x, y, value, anchor='middle') => {
  const element = node('text', {x, y, 'text-anchor':anchor, class:'progress-tick'});
  element.textContent = value;
  return element;
};
const html = (tag, className, value) => {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
};

// Round the domain up to readable intervals without rounding the recorded points.
export function scale(maximum, divisions, integer=false) {
  const rawStep = (maximum || 1) / divisions;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const interval = [1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) * magnitude;
  const step = integer ? Math.max(1, Math.ceil(interval)) : interval;
  const intervals = Math.ceil((maximum || 1) / step);
  return {maximum:step * intervals, ticks:Array.from({length:intervals + 1}, (_, index) => index * step)};
}

export function renderProgressChart({host, legend, notice, entries, axis, metric, selectedIds, name, color, onSelect, detail=()=>'', markerIndex, fullRange=false, logX=false}) {
  host.replaceChildren();
  legend.replaceChildren();
  const costAxis = axis === 'cost_usd';
  const thinkingAxis = axis === 'thinking_ms';
  const minimum = logX && costAxis ? LOG_COST_MINIMUM : 0;
  const axisNumber = costAxis ? value => dollars.format(value) : thinkingAxis ? formatLevelDuration : number;
  const axisTick = costAxis ? value => (minimum && value < 1 ? dollars.format(value) : compactDollars.format(value))
    : thinkingAxis ? timeTick : value => compact.format(value);
  const metricLabel = metric === 'gems' ? 'Gems' : 'Rooms';
  const series = entries.map(entry => ({entry, ...progressSeries(entry, axis, metric, minimum)}));
  const available = series.filter(s => s.linePoints.length), missing = series.filter(s => !s.linePoints.length);
  const belowMinimum = missing.filter(s => s.belowMinimum).length;
  const capped = entries.filter(entry => entry.series?.capped).length;
  const noHistory = missing.length - belowMinimum;
  const estimated = available.some(s => s.estimated);
  const missingReason = s => s.belowMinimum ? `Cost below ${axisNumber(minimum)}`
    : s.entry.series?.unavailable?.[axis] || 'History unavailable';
  notice.textContent = [
    noHistory ? `${noHistory} ${noHistory === 1 ? 'run has' : 'runs have'} no usable ${costAxis ? 'cost' : X_AXES[axis].toLowerCase()} history.` : '',
    belowMinimum ? `${belowMinimum} ${belowMinimum === 1 ? 'run is' : 'runs are'} below ${axisNumber(minimum)}.` : '',
    capped ? `${capped} ${capped === 1 ? 'run' : 'runs'} capped at ${RUN_CAP_LABEL}.` : '',
    estimated ? 'Est. = estimated history.' : ''
  ].filter(Boolean).join(' ');
  notice.hidden = !notice.textContent;
  notice.title = missing.length ? 'Unavailable: ' + missing.map(s => name(s.entry.model)).join(', ') : '';
  if (!available.length) {
    const emptyMessage = belowMinimum ? `No runs reached ${axisNumber(minimum)} in estimated API cost.`
      : entries.length ? 'No history for this comparison yet. Try Moves or adjust the filters.' : 'Choose runs to compare.';
    host.append(html('p', 'progress-empty', emptyMessage));
    for (const s of missing) { const button=html('button','progress-legend-item progress-missing',name(s.entry.model)+' · '+detail(s.entry)+' · '+missingReason(s)); button.type='button'; button.dataset.chartRunId=s.entry.id; button.setAttribute('aria-pressed',String(selectedIds.has(s.entry.id))); button.addEventListener('click',()=>onSelect(s.entry.id)); legend.append(button); }
    return;
  }

  const width = Math.max(280, host.clientWidth), mobile = width < 600;
  const labelFont = mobile ? 11 : 12;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `550 ${labelFont}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const labelLimit = Math.min(mobile ? width * .42 : width * .28, 240);
  const labels = available.map(s => {
    const fullName = name(s.entry.model);
    let caption = fullName;
    while (caption.length > 1 && measure.measureText(caption).width > labelLimit) caption = caption.slice(0, -2) + '…';
    return {s, caption, fullName, width:measure.measureText(caption).width};
  });
  const height = Math.max(mobile ? 330 : 450, available.length * 22 + 118);
  const pad = {left:mobile ? 40 : 52, right:Math.max(...labels.map(label => label.width)) + 28, top:38, bottom:64};
  const xMax = Math.max(...available.map(s => s.linePoints.at(-1).x));
  const xDivisions = mobile ? 3 : 5;
  const xUnit = !thinkingAxis ? 1 : logX || xMax < 60_000 ? 1000 : xMax < 3_600_000 ? 60_000 : 3_600_000;
  const xScale = logX ? logarithmicScale(xMax / xUnit, xDivisions, minimum) : scale(xMax / xUnit, xDivisions, !costAxis && !thinkingAxis);
  const axisCaption = logX ? `${X_AXES[axis]} (log scale)` : X_AXES[axis];
  const yScale = scale(Math.max(fullRange ? (metric === 'gems' ? 100 : 256) : 0,
    ...available.flatMap(s => s.linePoints.map(p => p.y))), 4, true);
  const x = value => pad.left + (logX ? xScale.position(value / xUnit) : value / xUnit / xScale.maximum) * (width - pad.left - pad.right);
  const y = value => height - pad.bottom - value / yScale.maximum * (height - pad.top - pad.bottom);
  const endLabels = new Map(layoutEndLabels(labels.map(label => {
    const last = label.s.linePoints.at(-1);
    return {...label, x:x(last.x) + 12, y:y(last.y)};
  }), pad.top, height - pad.bottom, 22).map(label => [label.s.entry.id, label]));
  const chart = node('svg', {viewBox:`0 0 ${width} ${height}`, role:'img', 'aria-label':`${metricLabel} by ${axisCaption} for ${available.length} runs`, class:'progress-svg'});
  for (const value of yScale.ticks) {
    chart.append(node('line', {x1:pad.left, x2:width-pad.right, y1:y(value), y2:y(value), class:value === 0 ? 'progress-grid progress-baseline' : 'progress-grid'}));
    chart.append(text(pad.left-12, y(value)+4, number(value), 'end'));
  }
  const xTicks = xScale.ticks;
  xTicks.forEach((value, index) => {
    const start = index === 0 || (logX && !minimum && index === 1 && xTicks.length > 2);
    const anchor = start ? 'start' : index === xTicks.length-1 ? 'end' : 'middle';
    chart.append(text(x(value * xUnit), height-pad.bottom+24, axisTick(value * xUnit), anchor));
  });
  const axisLabel = text((pad.left+width-pad.right)/2, height-14, axisCaption);
  const scoreLabel = text(pad.left, 20, metricLabel, 'start');
  axisLabel.classList.add('progress-axis-label');
  scoreLabel.classList.add('progress-axis-label');
  chart.append(axisLabel, scoreLabel);

  const plot = node('g');
  const labelLayer = node('g');
  const tooltip = html('div', 'progress-tooltip');
  tooltip.hidden = true;
  const hoverMarker = node('circle', {r:8, fill:'none', stroke:'#edf2ff', 'stroke-width':1.5, visibility:'hidden', 'pointer-events':'none'});
  const markerIds = new Map(entries.map(entry => entry.id).sort().map((id, index) => [id, index]));
  const runElements = new Map();
  let highlightedId = null;
  function highlight(id) {
    if (id === highlightedId) return;
    highlightedId = id;
    chart.toggleAttribute('data-highlighting', Boolean(id));
    for (const [runId, {group, button, endGroup}] of runElements) {
      group.toggleAttribute('data-highlighted', runId === id);
      button.toggleAttribute('data-highlighted', runId === id);
      endGroup.setAttribute('opacity', !id || runId === id ? '1' : '.75');
    }
    if (id && runElements.has(id)) plot.append(runElements.get(id).group);
  }
  function restoreHighlight() {
    const focused = legend.querySelector(':focus-visible');
    highlight(focused?.dataset.chartRunId || [...selectedIds][0] || null);
  }
  function clearHover() {
    tooltip.hidden = true;
    hoverMarker.setAttribute('visibility', 'hidden');
    restoreHighlight();
  }

  available.forEach((s, index) => {
    const selected = selectedIds.has(s.entry.id), accent = color(s.entry);
    const shape = gemMarker(markerIndex ? markerIndex(s.entry.id) : markerIds.get(s.entry.id), 4);
    const group = node('g', {class:'progress-series', 'data-run-id':s.entry.id, 'data-marker-shape':shape.name, 'data-selected':selected});
    const path = linearPath(s.linePoints, x, y);
    const hit = node('path', {d:path, fill:'none', stroke:'transparent', 'stroke-width':14, class:'progress-hit', 'aria-hidden':true});
    const line = node('path', {d:path, fill:'none', stroke:accent, 'vector-effect':'non-scaling-stroke', class:'progress-line', 'data-run-id':s.entry.id});
    const title = node('title');
    title.textContent = name(s.entry.model) + (s.estimated ? ' · Estimated history' : s.checkpoints ? ' · Recorded checkpoints' : '');
    line.append(title);
    group.append(hit, line);
    const definition = node('defs'), symbol = node('g', {id:`progress-marker-${index}`});
    // Keep MazeBench's distinct shapes and a marker at every score-change vertex.
    symbol.innerHTML = shape.body;
    definition.append(symbol);
    group.append(definition);
    for (const point of s.points) {
      const vertex = node('use', {href:`#progress-marker-${index}`, x:x(point.x), y:y(point.y), fill:'#000', stroke:accent, 'stroke-width':1.6, 'stroke-linejoin':'round', class:'progress-vertex', 'data-x':point.x, 'data-y':point.y});
      const title = node('title');
      title.textContent = `${name(s.entry.model)} · ${number(point.y)} ${metric} · ${X_AXES[axis]}: ${axisNumber(point.x)} · ${shape.name}${s.estimated ? ' · Estimated history' : ''}`;
      vertex.append(title);
      group.append(vertex);
    }
    const end = endLabels.get(s.entry.id);
    const endGroup = node('g', {class:'progress-end', 'data-run-id':s.entry.id});
    const endpointLabel = node('text', {x:end.x, y:end.labelY, fill:accent,
      'font-size':labelFont, class:'progress-end-label', 'dominant-baseline':'middle'});
    endpointLabel.textContent = end.caption;
    const endpointTitle = node('title');
    endpointTitle.textContent = `${end.fullName} · ${detail(s.entry)}`;
    endpointLabel.append(endpointTitle);
    if (Math.abs(end.labelY - end.y) > 1) endGroup.append(node('path', {
      d:`M${end.x - 7},${end.y}L${end.x - 4},${end.labelY}`, fill:'none', stroke:accent,
      class:'progress-end-connector', 'aria-hidden':'true'
    }));
    endGroup.append(endpointLabel);
    endGroup.addEventListener('click', event => onSelect(s.entry.id, event.altKey));
    labelLayer.append(endGroup);
    group.addEventListener('click', event => onSelect(s.entry.id, event.altKey));
    plot.append(group);

    const button = html('button', 'progress-legend-item');
    button.type = 'button';
    button.dataset.chartRunId = s.entry.id;
    button.style.setProperty('--run-accent', accent);
    button.setAttribute('aria-pressed', String(selected));
    const swatch = node('svg', {viewBox:'0 0 28 20', width:28, height:20, class:'progress-key', 'aria-hidden':true});
    const keyLine = node('path', {d:'M1,10L27,10', stroke:accent, 'stroke-width':2, 'stroke-linecap':'round'});
    const keyMarker = node('g', {transform:'translate(14,10)', fill:'#000', stroke:accent, 'stroke-width':1.6, 'stroke-linejoin':'round'});
    keyMarker.innerHTML = shape.body;
    swatch.append(keyLine, keyMarker);
    const label = html('span', 'progress-legend-name'); label.append(html('strong', '', name(s.entry.model)), html('small', '', detail(s.entry))); button.append(swatch, label);
    const version = s.entry.benchmark_version?.label;
    if (version) button.append(html('small', 'progress-version', version));
    if (s.estimated) {
      const badge = html('small', 'progress-estimate', 'Est.');
      badge.title = 'Estimated history';
      button.append(badge);
    }
    button.title = [name(s.entry.model), version, shape.name, s.estimated ? 'Estimated history' : s.checkpoints ? 'Recorded checkpoints' : ''].filter(Boolean).join(' · ');
    button.addEventListener('click', event => onSelect(s.entry.id, event.altKey));
    for (const event of ['pointerenter', 'focus']) button.addEventListener(event, () => highlight(s.entry.id));
    for (const event of ['pointerleave', 'blur']) button.addEventListener(event, restoreHighlight);
    legend.append(button);
    runElements.set(s.entry.id, {group, button, endGroup});
  });
  // Selected runs remain readable at intersections.
  for (const [id, {group}] of runElements) if (selectedIds.has(id)) plot.append(group);
  chart.append(plot, labelLayer, hoverMarker);
  host.append(chart, tooltip);
  restoreHighlight();

  chart.addEventListener('pointermove', event => {
    const endpoint = event.target.closest?.('.progress-end');
    if (endpoint) { tooltip.hidden = true; hoverMarker.setAttribute('visibility', 'hidden'); highlight(endpoint.dataset.runId); return; }
    const bounds = chart.getBoundingClientRect();
    const px = (event.clientX-bounds.left)/bounds.width*width, py = (event.clientY-bounds.top)/bounds.height*height;
    if (px < pad.left-8 || px > width-pad.right+8 || py < pad.top-8 || py > height-pad.bottom+8) { clearHover(); return; }
    const hitId = event.target.closest?.('.progress-series')?.dataset.runId;
    let best = null;
    for (const s of available) {
      if (hitId && s.entry.id !== hitId) continue;
      for (const point of s.points) {
        const distance = Math.hypot(x(point.x)-px, y(point.y)-py);
        if (!best || distance < best.distance) best = {s, point, distance};
      }
    }
    if (!best || best.distance > 28) {
      clearHover();
      if (hitId) highlight(hitId);
      return;
    }
    highlight(best.s.entry.id);
    const heading = html('strong', 'progress-tooltip-name', name(best.s.entry.model));
    const values = html('dl', 'progress-tooltip-values');
    for (const [label, value] of [[metricLabel, number(best.point.y)], [X_AXES[axis], axisNumber(best.point.x)]]) {
      values.append(html('dt', '', label), html('dd', '', value));
    }
    tooltip.replaceChildren(heading, values);
    if (best.s.estimated) tooltip.append(html('small', 'progress-tooltip-note', 'Estimated history'));
    else if (best.s.checkpoints) tooltip.append(html('small', 'progress-tooltip-note', 'Recorded checkpoint'));
    tooltip.hidden = false;
    tooltip.style.left = Math.max(8, Math.min(event.clientX-bounds.left+16, host.clientWidth-tooltip.offsetWidth-8)) + 'px';
    tooltip.style.top = Math.max(8, event.clientY-bounds.top-tooltip.offsetHeight-16) + 'px';
    hoverMarker.setAttribute('cx', x(best.point.x));
    hoverMarker.setAttribute('cy', y(best.point.y));
    hoverMarker.setAttribute('visibility', 'visible');
  });
  chart.addEventListener('pointerleave', clearHover);
  for (const s of missing) { const button = html('button', 'progress-legend-item progress-missing'); button.type='button'; button.dataset.chartRunId=s.entry.id; button.setAttribute('aria-pressed', String(selectedIds.has(s.entry.id))); button.textContent=name(s.entry.model)+' · '+detail(s.entry)+' · '+missingReason(s); button.addEventListener('click',()=>onSelect(s.entry.id)); legend.append(button); }
}
