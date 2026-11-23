import { codingLabel, codingMode } from '../capabilities.mjs';
import { versionPresentation } from '../run-version-label.mjs';
import { modelGroupId, modelSpeed } from './model-label.mjs';

const mode = run => run.observation_mode === 'vision' ? 'vision' : 'ascii';
const world = run => run.world || 'main-world';
const provider = run => run.provider || 'codex';
const version = run => versionPresentation(run.benchmark_version).label;
const effort = run => run.effort || 'default';
const sequence = run => world(run) === 'slotski' ? run.sequence_enabled !== false : null;
const codingOrder = { off: 0, python: 1, any: 2 };
const numbers = new Intl.NumberFormat();

function condition(run) {
  return JSON.stringify([mode(run), codingMode(run), effort(run), modelSpeed(run), version(run), sequence(run)]);
}

function preference(left, right) {
  // A fresh failed launch must not replace a real run of the same condition.
  return Number(Boolean(right.runner_active)) - Number(Boolean(left.runner_active))
    || Number(right.action_count > 0) - Number(left.action_count > 0)
    || String(right.created_at || '').localeCompare(String(left.created_at || ''))
    || left.id.localeCompare(right.id);
}

// Pairs only describe a launch batch. Observation modes and independently
// launched conditions still belong to the same model's replay switcher.
export function selectRunVariants(current, runs = []) {
  if (!current?.id || !current.model) return [];
  const peers = runs.filter(run => run.id && modelGroupId(run.model) === modelGroupId(current.model)
    && provider(run) === provider(current) && world(run) === world(current));
  const variants = new Map();
  for (const peer of peers.sort(preference)) {
    const key = condition(peer);
    if (!variants.has(key)) variants.set(key, peer);
  }
  // Keep the open replay selected, with its latest counters, even when the
  // library contains an older snapshot or a newer repeat of that condition.
  variants.set(condition(current), current);
  return [...variants.values()].sort((a, b) => mode(a).localeCompare(mode(b))
    || codingOrder[codingMode(a)] - codingOrder[codingMode(b)]
    || effort(a).localeCompare(effort(b))
    || modelSpeed(a).localeCompare(modelSpeed(b))
    || version(a).localeCompare(version(b))
    || a.id.localeCompare(b.id));
}

function extraDetails(run, peers) {
  return [
    new Set(peers.map(effort)).size > 1 && `${effort(run)} reasoning`,
    new Set(peers.map(modelSpeed)).size > 1 && (modelSpeed(run) === 'fast' ? 'Fast' : 'Standard'),
    new Set(peers.map(version)).size > 1 && version(run),
    new Set(peers.map(sequence)).size > 1 && (sequence(run) ? 'Batched moves' : 'Single moves')
  ].filter(Boolean).join(' · ');
}

const icons = {
  ascii: '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/>',
  vision: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'
};

export class RunVariantSwitcher {
  constructor(root) {
    this.root = root;
    this.groups = new Map();
    this.cards = new Map();
    root.className = 'run-variants';
    root.setAttribute('aria-label', 'Model run variants');
  }

  update(current, library) {
    const peers = selectRunVariants(current, library);
    this.root.hidden = peers.length < 2;
    if (this.root.hidden) return;
    const wanted = new Set(peers.map(run => run.id));
    for (const [id, card] of this.cards) {
      if (!wanted.has(id)) { card.remove(); this.cards.delete(id); }
    }
    for (const observation of ['ascii', 'vision']) {
      const runs = peers.filter(run => mode(run) === observation);
      let group = this.groups.get(observation);
      if (!runs.length) { if (group) group.hidden = true; continue; }
      if (!group) {
        group = document.createElement('div');
        group.className = 'run-variant-group';
        group.innerHTML = `<h2><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[observation]}</svg>${observation === 'vision' ? 'Vision' : 'ASCII'}</h2><div class="run-variant-cards"></div>`;
        this.groups.set(observation, group);
      }
      group.hidden = false;
      const targetIndex = observation === 'ascii' || !this.groups.has('ascii') ? 0 : 1;
      if (this.root.children[targetIndex] !== group) this.root.insertBefore(group, this.root.children[targetIndex] || null);
      const cards = group.lastElementChild;
      runs.forEach((run, index) => {
        let card = this.cards.get(run.id);
        if (!card) {
          card = document.createElement('a');
          card.className = 'run-variant-card';
          card.href = `./run.html?id=${encodeURIComponent(run.id)}`;
          card.innerHTML = '<span class="run-variant-heading"><span class="run-variant-name"></span><span class="run-variant-check" aria-hidden="true">✓</span></span><span class="run-variant-details"></span><span class="run-variant-result"><strong></strong><span></span></span>';
          this.cards.set(run.id, card);
        }
        const selected = run.id === current.id;
        if (selected) card.setAttribute('aria-current', 'page');
        else card.removeAttribute('aria-current');
        card.querySelector('.run-variant-check').hidden = !selected;
        card.querySelector('.run-variant-name').textContent = codingLabel(run);
        const details = card.querySelector('.run-variant-details');
        details.textContent = extraDetails(run, peers);
        details.hidden = !details.textContent;
        const numbered = ['ice-maze', 'slotski'].includes(world(run));
        const score = `${numbers.format((numbered ? run.levels_solved : run.gems_collected) || 0)} ${numbered ? 'levels' : 'gems'}`;
        const actions = `${numbers.format(run.action_count || 0)} actions`;
        card.querySelector('strong').textContent = score;
        card.querySelector('.run-variant-result > span').textContent = actions;
        card.title = [run.status, `${effort(run)} reasoning`, modelSpeed(run), version(run), run.created_at && new Date(run.created_at).toLocaleString()].filter(Boolean).join(' · ');
        card.setAttribute('aria-label', `${observation === 'vision' ? 'Vision' : 'ASCII'}, ${codingLabel(run)}, ${details.textContent ? `${details.textContent}, ` : ''}${score}, ${actions}, ${run.status || 'saved'}${selected ? ', current replay' : ''}`);
        if (cards.children[index] !== card) cards.insertBefore(card, cards.children[index] || null);
      });
    }
  }
}
