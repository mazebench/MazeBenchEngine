import { benchmarkFetch } from './benchmark-api.mjs';
import { pricingRows, configuredModels } from './pricing-data.mjs';
import { providerName, runCardValues } from './run-library.mjs';
import { installPricingSnapshot } from '../token-pricing.mjs';

const $ = id => document.getElementById(id);
const state = { models: configuredModels(), runs: [], catalogs: {}, coverage: 'all', speed: 'all', runsOnly: false, query: '' };
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(value) : '—';
const statusNames = { missing: 'Missing', partial: 'Incomplete', unpublished: 'Unpublished', estimated: 'Estimate', configured: 'Configured' };
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderRow(row) {
  const tr = element('tr'); tr.dataset.model = row.model; tr.dataset.speed = row.speed; tr.dataset.coverage = row.status;
  const company = runCardValues({ model: row.model, provider: row.provider });
  const model = element('td'), identity = element('div', null, 'pricing-model');
  if (company.logo) { const img = element('img', null, company.monochromeLogo ? 'monochrome' : ''); img.src = company.logo; img.alt = company.company; identity.append(img); }
  const name = element('div'); name.append(element('strong', row.slug), element('small', `${providerName(row.provider)} · ${row.speed === 'fast' ? 'Fast' : 'Standard'}`));
  identity.append(name); model.append(identity); tr.append(model);
  for (const index of [0, 1, 3]) { const td = element('td', money(row.price?.rates[index]), 'rate'); if (!Number.isFinite(row.price?.rates[index])) td.title = 'Rate missing'; tr.append(td); }
  const coverage = element('td'), badge = element('span', statusNames[row.status], `pricing-badge ${row.status}`); badge.title = row.reason; coverage.append(badge); tr.append(coverage);
  const detailsCell = element('td'), details = element('details'); details.append(element('summary', 'Details'));
  if (row.reason) details.append(element('p', row.reason));
  if (row.gap) { const link = element('a', `Source · checked ${row.gap.checked_at} ↗`); link.href = row.gap.source; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); }
  if (row.price) {
    const p = element('p'), source = element('a', 'Pricing source ↗'); source.href = row.price.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; p.append(source);
    p.append(document.createElement('br'), document.createTextNode(row.price.checked_at ? `Checked ${row.price.checked_at}` : 'Check date unavailable'));
    details.append(p, element('p', `Cache write: ${money(row.price.rates[2])}${row.price.rates[4] != null ? ` · Extended cache write: ${money(row.price.rates[4])}` : ''} per 1M.`));
    if (row.price.time_schedule) {
      const peak = row.price.time_schedule.peak_rates;
      details.append(element('p', `Showing ${row.price.price_period} rates now. Peak: ${money(peak[0])} input · ${money(peak[1])} cached · ${money(peak[3])} output per 1M.`));
    }
    if (row.price.long) {
      const premium = row.price.long;
      details.append(element('p', `Above ${premium.threshold.toLocaleString()} input tokens per request: ${premium.input_multiplier}× input/cache and ${premium.output_multiplier}× output.`));
    }
    for (const tier of row.price.context_tiers || []) details.append(element('p', `Above ${tier.threshold.toLocaleString()} input tokens: ${money(tier.rates[0])} input · ${money(tier.rates[1])} cached · ${money(tier.rates[3])} output per 1M.`));
    if (row.price.note) details.append(element('p', row.price.note));
    if (row.price.effective_at) details.append(element('p', `Effective ${row.price.effective_at.slice(0, 10)}.`));
    if (row.price.estimated) details.append(element('p', row.price.estimated));
  }
  if (row.stale) details.append(element('p', 'Provider catalog is stale; refresh to check current availability.'));
  const ids = element('p', 'Model IDs: '); ids.append(element('code', row.ids.join(', '))); details.append(ids);
  detailsCell.append(details); tr.append(detailsCell); return tr;
}
function render() {
  const rows = pricingRows(state);
  const relevant = rows.filter(row => (!state.runsOnly || row.runs) && (state.speed === 'all' || row.speed === state.speed) &&
    `${row.slug} ${row.ids.join(' ')} ${providerName(row.provider)} ${runCardValues({ model: row.model, provider: row.provider }).company}`.toLowerCase().includes(state.query));
  for (const button of $('coverage-filter').querySelectorAll('button')) {
    const value = button.dataset.value;
    button.querySelector('span').textContent = relevant.filter(row => value === 'all' || row.status === value).length;
  }
  const visible = relevant.filter(row => state.coverage === 'all' || row.status === state.coverage);
  $('pricing-rows').replaceChildren(...visible.map(renderRow)); $('pricing-empty').hidden = visible.length > 0;
}
async function load(force = false) {
  const button = $('refresh-pricing'), status = $('pricing-status');
  if (button.disabled) return;
  button.disabled = true; status.classList.remove('warning'); status.textContent = 'Loading model catalog and saved runs…';
  const failures = [];
  const staleSources = [];
  await Promise.allSettled([['models', '/models' + (force ? '?force=1' : '')], ['runs', '/runs'], ['pricing', '/pricing' + (force ? '?force=1' : '')]].map(async ([kind, endpoint]) => {
    try {
      const response = await benchmarkFetch('/api/benchmark/v1' + endpoint, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (kind === 'pricing') {
        if (value.version !== 1 || !value.entries) throw new Error();
        installPricingSnapshot(value); render();
        $('pricing-sources').replaceChildren(...Object.entries(value.sources || {}).map(([id, source]) => {
          const stale = source.error || !source.checked_at || Date.now() - Date.parse(source.checked_at) > 7 * 3600000;
          if (stale) staleSources.push(id);
          const p = element('p'), link = element('a', id === 'modelsdev' ? 'models.dev (catalog fallback)' : id);
          link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          p.append(link, document.createTextNode(` · ${source.checked_at ? new Date(source.checked_at).toLocaleString() : 'Not checked'}${stale ? ` · ${source.error || 'Check overdue'}; keeping previous rates` : ' · Up to date'}`)); return p;
        }));
        if (value.storage_error) { failures.push('persistent cache'); $('pricing-sources').append(element('p', value.storage_error)); }
        return;
      }
      if (!Array.isArray(value[kind])) throw new Error();
      state[kind] = value[kind]; if (kind === 'models') state.catalogs = value.catalogs || {};
      render(); status.textContent = kind === 'models' ? 'Catalog loaded · checking saved runs…' : 'Saved runs loaded · checking model catalog…';
    } catch { failures.push(kind); }
  }));
  const stale = Object.values(state.catalogs).filter(value => value.stale).length;
  status.classList.toggle('warning', Boolean(failures.length || stale || staleSources.length));
  status.textContent = failures.length ? `Could not load ${failures.join(' and ')}. Showing available entries; the list may be incomplete. Refresh to retry.`
    : staleSources.length ? `${staleSources.length} pricing source${staleSources.length === 1 ? ' needs' : 's need'} a retry. Last working rates are retained; see sources below.`
      : stale ? `${stale} provider catalog${stale === 1 ? ' is' : 's are'} stale. Saved runs and cached models are included.`
        : 'Prices update automatically · new models and published rates are picked up without a code change.';
  button.disabled = false;
}
for (const [id, key] of [['coverage-filter', 'coverage'], ['speed-filter', 'speed']]) $(id).addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  state[key] = button.dataset.value; for (const item of $(id).querySelectorAll('button')) item.setAttribute('aria-pressed', String(item === button)); render();
});
$('pricing-search').addEventListener('input', event => { state.query = event.target.value.trim().toLowerCase(); render(); });
$('runs-only').addEventListener('click', event => { state.runsOnly = !state.runsOnly; event.currentTarget.setAttribute('aria-pressed', String(state.runsOnly)); render(); });
$('refresh-pricing').addEventListener('click', () => load(true));
render(); load();
setInterval(() => { if (!document.hidden) load(); }, 300000);
