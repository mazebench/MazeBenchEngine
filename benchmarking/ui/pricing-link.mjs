const nav = document.querySelector('.topbar nav');
if (nav && !nav.querySelector('[data-object-lab-link]')) {
  const link = document.createElement('a');
  link.href = new URL('../../object-lab/', import.meta.url).href;
  link.textContent = 'Object lab'; link.dataset.objectLabLink = '';
  link.style.cssText = 'color:var(--cyan);font-size:12px;white-space:nowrap';
  nav.append(link);
}
if (nav && !nav.querySelector('[data-pricing-link]')) {
  const link = document.createElement('a');
  link.href = new URL('./pricing.html', import.meta.url).href;
  link.textContent = 'Pricing'; link.dataset.pricingLink = '';
  link.style.cssText = 'color:var(--cyan);font-size:12px;white-space:nowrap';
  nav.append(link);
}
if (nav && !nav.querySelector('[data-archive-link]')) {
  const link = document.createElement('a');
  link.href = new URL('./archive.html', import.meta.url).href;
  link.textContent = 'Older runs'; link.dataset.archiveLink = '';
  link.style.cssText = 'color:var(--cyan);font-size:12px;white-space:nowrap';
  nav.append(link);
}
