import { registerPresentationVersions } from '../benchmarking/run-version-label.mjs';

export function setupCurrentVersionBadge(parent, { benchmark = false } = {}) {
  if (!parent || parent.querySelector('.current-version')) return;
  const badge = document.createElement('span');
  badge.className = 'current-version';
  badge.setAttribute('aria-label', 'Engine and world version');
  badge.hidden = true;
  const title = parent.querySelector('.page-title');
  if (title) title.after(badge); else parent.append(badge);
  const selector = benchmark ? document.querySelector('select#world') : null;
  let pending = false, signature = '';
  const refresh = async () => {
    if (pending || document.hidden) return;
    pending = true;
    try {
      let value;
      const urls = [`http://${location.hostname}:8085/api/versions/current`, '/api/versions/current'];
      for (const url of urls) {
        try {
          const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
          if (response.ok) { value = await response.json(); break; }
        } catch { /* The main server is the fallback when the report service is off. */ }
      }
      if (!value) throw new Error('Version unavailable');
      registerPresentationVersions(value.versions);
      const world = selector?.value || 'main-world';
      const version = benchmark ? (value.benchmarks?.[world] || (world === 'main-world' ? value.benchmark : null)) : value.current;
      if (!version) throw new Error('Version unavailable');
      badge.textContent = version.label;
      badge.title = (benchmark ? `New ${selector?.selectedOptions?.[0]?.textContent || 'Main World'} benchmark runs: pinned engine and current world.` : 'Current Play engine and world.') +
        (version.engine_build_pending ? ' Engine source changes are awaiting a build.' : '');
      badge.setAttribute('aria-label', `Engine and world ${version.label}`);
      badge.hidden = false;
      const next = JSON.stringify(value.versions);
      if (next !== signature) { signature = next; document.dispatchEvent(new CustomEvent('mazebench:versions-updated')); }
    } catch {
      badge.textContent = 'Version unavailable';
      badge.title = 'Could not verify the current engine and world version. Retrying automatically.';
      badge.hidden = false;
    } finally { pending = false; }
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  selector?.addEventListener('change', refresh);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('pagehide', () => { clearInterval(timer); selector?.removeEventListener('change', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); }, { once: true });
  return badge;
}
