import { benchmarkFetch } from "./benchmark-api.mjs";
import "./run-charts.mjs";
import { runTabVisible } from "./run-tabs.mjs";
import { costAvailability } from './cost-availability.mjs';

const chart = document.getElementById("token-chart");
const current = document.getElementById("token-current");
const detail = document.getElementById("token-detail");
const tooltip = document.getElementById("token-tooltip");
const id = new URLSearchParams(location.search).get("id");
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const short = value => value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(Math.round(value));
const clock = value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const left = 62, right = 1070, top = 22, bottom = 185;
let data = null;
let busy = false;
let fetchedAt = 0, signature = "";
const pointTime = point => Number.isFinite(point.active_ms) ? point.active_ms : point.timestamp;

function elapsed(ms) {
  const minutes = Math.max(0, ms) / 60000;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${Math.floor(minutes % 60) ? ` ${Math.floor(minutes % 60)}m` : ''}`;
  return minutes < 1 ? `${Math.round(minutes * 60)}s` : `${Math.round(minutes)}m`;
}

function render(value) {
  data = value;
  const totals = value.totals;
  if (totals) document.dispatchEvent(new CustomEvent("run-tokens", { detail: totals }));
  for (const [id, key] of [["token-total-input", "input_tokens"], ["token-total-cached", "cached_input_tokens"], ["token-total-output", "output_tokens"]]) {
    document.getElementById(id).textContent = totals ? number.format(totals[key] || 0) : "—";
  }
  document.getElementById("token-cache-rate").textContent = totals?.input_tokens ? `${Math.round(totals.cached_input_tokens / totals.input_tokens * 100)}% of input cached` : "—";
  const pricing = value.api_estimate;
  const availability = costAvailability(value);
  document.getElementById("token-api-cost").textContent = availability.label;
  const source = document.getElementById("token-pricing-source");
  if (source) { source.hidden = !availability.source; if (availability.source) source.href = availability.source; }
  const rates = pricing?.rates_per_million;
  const contextPricing = pricing?.context_tiers?.length ? pricing.context_tiers.map(tier => `Above ${number.format(tier.threshold)} input tokens: ${rateLabel(tier.rates[0])} input, ${rateLabel(tier.rates[1])} cached input and ${rateLabel(tier.rates[3])} output per million.`).join(' ')
    : pricing?.long_context ? `Requests above ${number.format(pricing.long_context.threshold)} input tokens use ${pricing.long_context.input_multiplier}× input/cache and ${pricing.long_context.output_multiplier}× output rates.` : 'No long-context premium configured.';
  document.getElementById("token-pricing-detail").textContent = availability.reason || (rates
    ? `${pricing.basis} ${pricing.pricing_date ? `Rates checked ${pricing.pricing_date}` : 'Configured rates'}: ${rateLabel(rates.input)} input, ${rateLabel(rates.cached_input)} cached input, ${rateLabel(rates.cache_writes)} cache writes, and ${rateLabel(rates.output)} output per million tokens.${pricing.service_tiers?.length > 1 ? ' Displayed rates are for the current speed; each response uses its recorded speed.' : ''} ${contextPricing} ${pricing.request_count ?? 'Unknown number of'} reported responses counted, with duplicate records removed. Unreported usage and non-token fees are excluded.`
    : pricing?.basis || "No verified API price or detailed usage is available for this record.");
  if (!value.available || !value.samples.length) {
    current.textContent = value.totals ? "Context not reported" : "Waiting for token data";
    chart.innerHTML = '<text x="550" y="110" text-anchor="middle" class="token-empty"></text>';
    chart.firstElementChild.textContent = value.totals ? "Token totals are shown below." : "Token usage appears after the first model response.";
    detail.textContent = `${value.context_window ? `Context window ${number.format(value.context_window)} tokens · ` : ''}${value.reason || "Updates after each model response."}`;
    return;
  }
  const samples = value.samples;
  const start = pointTime(samples[0]);
  const end = Math.max(start + 1000, pointTime(samples.at(-1)));
  const max = Math.max(1, value.context_window || 0, value.compaction_threshold || 0, ...samples.map(s => s.tokens)) * 1.08;
  const x = time => left + (time - start) / (end - start) * (right - left);
  const y = tokens => bottom - tokens / max * (bottom - top);
  // Hold each reported value until the next report; a compaction is a drop,
  // not a gradual decrease during the time spent waiting for its response.
  const points = samples.flatMap((sample, index) => [
    ...(index ? [`${x(pointTime(sample)).toFixed(1)},${y(samples[index - 1].tokens).toFixed(1)}`] : []),
    `${x(pointTime(sample)).toFixed(1)},${y(sample.tokens).toFixed(1)}`
  ]).join(" ");
  const grid = Array.from({ length: 5 }, (_, index) => {
    const tokens = index * max / 4;
    return `<line x1="${left}" x2="${right}" y1="${y(tokens)}" y2="${y(tokens)}" class="token-grid"/><text x="${left - 10}" y="${y(tokens) + 4}" text-anchor="end" class="token-axis">${short(tokens)}</text>`;
  }).join("");
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const time = start + index / 5 * (end - start);
    return `<text x="${x(time)}" y="205" text-anchor="middle" class="token-axis">${elapsed(time - start)}</text>`;
  }).join("");
  const threshold = Number.isFinite(value.compaction_threshold) ? value.compaction_threshold : null;
  const trigger = threshold === null ? "" : `<rect x="${left}" y="${top}" width="${right - left}" height="${Math.max(0, y(threshold) - top)}" class="token-warning-band"/><line x1="${left}" x2="${right}" y1="${y(threshold)}" y2="${y(threshold)}" class="token-trigger-line"/><text x="${right}" y="${y(threshold) - 7}" text-anchor="end" class="token-trigger-text">Compact at ${number.format(threshold)}</text>`;
  const markers = value.compactions.map((event, index) => {
    if (event.timestamp < samples[0].timestamp || event.timestamp > samples.at(-1).timestamp) return '';
    const px = x(pointTime(event));
    if (px < left || px > right) return "";
    return `<line x1="${px}" x2="${px}" y1="${top}" y2="${bottom}" class="token-compaction-line"/><circle cx="${px}" cy="${y(event.after_tokens ?? 0)}" r="4" class="token-compaction-dot"><title>Compaction ${index + 1}: ${event.before_tokens ?? "unknown"} → ${event.after_tokens ?? "pending"} tokens</title></circle>`;
  }).join("");
  const active = value.time_axis?.kind === 'active', axisLabel = active ? 'Active runtime' : 'Elapsed runtime';
  chart.innerHTML = `<defs><linearGradient id="token-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#62d9ef" stop-opacity="0.2"/><stop offset="100%" stop-color="#62d9ef" stop-opacity="0.01"/></linearGradient></defs>${grid}${trigger}<polygon points="${left},${bottom} ${points} ${x(pointTime(samples.at(-1)))},${bottom}" fill="url(#token-fill)"/><polyline points="${points}" class="token-series"/>${markers}<circle cx="${x(pointTime(samples.at(-1)))}" cy="${y(value.current_tokens)}" r="4" class="token-current-dot"/>${ticks}<text x="550" y="224" text-anchor="middle" class="token-axis">${axisLabel}</text><line id="token-crosshair" y1="${top}" y2="${bottom}" class="token-crosshair" visibility="hidden"/>`;
  current.textContent = threshold === null
    ? `${number.format(value.current_tokens)} context tokens`
    : `${number.format(value.current_tokens)} / ${number.format(threshold)} · ${Math.round(value.current_tokens / threshold * 100)}% of trigger`;
  current.classList.toggle("near-compaction", threshold !== null && value.current_tokens >= threshold * 0.85);
  const count = value.compactions.length;
  detail.textContent = `${value.context_window ? `Context window ${number.format(value.context_window)} tokens · ` : ''}${value.compactions_available === false ? 'Compaction history unreported' : `${count} compaction${count === 1 ? "" : "s"}`}${value.telemetry_source?.startsWith('deepseek-') && threshold === null ? ' · Auto-compaction trigger unreported' : ''}${value.time_axis?.excluded_ms >= 1000 ? ` · ${elapsed(value.time_axis.excluded_ms)} downtime excluded` : ''} · Last reported ${clock(value.updated_at)}`;
  detail.title = [value.context_basis, value.reason, value.time_axis?.basis].filter(Boolean).join(' ');
  chart.setAttribute("aria-label", `${current.textContent}. ${detail.textContent}. Context tokens over ${axisLabel.toLowerCase()}.`);
}

function rateLabel(rate) { return Number.isFinite(rate) ? `$${rate}` : 'unavailable'; }

chart.addEventListener("pointermove", event => {
  if (!data?.samples?.length) return;
  const bounds = chart.getBoundingClientRect();
  const px = (event.clientX - bounds.left) / bounds.width * 1100;
  const start = pointTime(data.samples[0]);
  const end = Math.max(start + 1000, pointTime(data.samples.at(-1)));
  const time = start + Math.max(0, Math.min(1, (px - left) / (right - left))) * (end - start);
  const sample = data.samples.reduce((best, value) => Math.abs(pointTime(value) - time) < Math.abs(pointTime(best) - time) ? value : best);
  tooltip.textContent = `${elapsed(pointTime(sample) - start)}${data.time_axis?.kind === 'active' ? ' active' : ''} · ${clock(sample.timestamp)} · ${number.format(sample.tokens)} context tokens`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(8, Math.min(bounds.width - 250, event.clientX - bounds.left + 12))}px`;
  const cursor = chart.querySelector("#token-crosshair");
  const cx = left + (pointTime(sample) - start) / (end - start) * (right - left);
  cursor.setAttribute("x1", cx);
  cursor.setAttribute("x2", cx);
  cursor.setAttribute("visibility", "visible");
});
chart.addEventListener("pointerleave", () => {
  tooltip.hidden = true;
  chart.querySelector("#token-crosshair")?.setAttribute("visibility", "hidden");
});

async function refresh() {
  if (busy || !id || !runTabVisible("analysis")) return;
  if (Date.now() - fetchedAt < (document.body.dataset.runnerActive === "true" ? 5000 : 60000)) return;
  busy = true;
  try {
    const response = await benchmarkFetch(`/api/benchmark/v1/runs/${encodeURIComponent(id)}/tokens`);
    if (!response.ok) throw new Error("Token telemetry unavailable");
    const value = await response.json(), next = JSON.stringify(value);
    fetchedAt = Date.now();
    if (next !== signature) { render(value); signature = next; }
  } catch {
    detail.textContent = "Token telemetry unavailable · retrying…";
  } finally { busy = false; }
}
document.addEventListener("visibilitychange", refresh);
document.addEventListener("run-tab-change", refresh);
setInterval(refresh, 5000);
