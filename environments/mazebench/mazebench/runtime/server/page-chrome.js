const { escapeHtml } = require("./support");

// Site chrome ported from the MazeJam repo (functions/_shared/page-chrome.js)
// so the local site looks exactly like the hosted one. Keep the markup and the
// nav script in sync with MazeJam when its design changes; the CSS lives in
// public/site.css (copied verbatim from MazeJam's public/site.css).

const BRAND_MARK_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><rect x="5.5" y="5.5" width="53" height="53" rx="12" fill="none" stroke="#34e7f0" stroke-width="3"/><path d="M18 46 V18 h28 v28 h-9 v-19 h-10 v19" fill="none" stroke="#34e7f0" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ACCOUNT_ICON_SVG = `<svg class="account-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 12.2a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4Zm0 2c-4.2 0-7.4 2.3-7.4 5.2 0 .8.6 1.4 1.4 1.4h12c.8 0 1.4-.6 1.4-1.4 0-2.9-3.2-5.2-7.4-5.2Z"></path></svg>`;

const TOPBAR_NAV_SCRIPT = `(() => {
      const bar = document.currentScript && document.currentScript.closest(".topbar");
      if (!bar || bar.dataset.navReady) return;
      bar.dataset.navReady = "1";
      const drops = Array.from(bar.querySelectorAll("details.nav-dropdown"));
      drops.forEach((drop) => {
        drop.addEventListener("toggle", () => {
          if (drop.open) drops.forEach((other) => { if (other !== drop) other.open = false; });
        });
      });
      document.addEventListener("click", (event) => {
        drops.forEach((drop) => {
          if (drop.open && !drop.contains(event.target)) drop.open = false;
        });
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") drops.forEach((drop) => { drop.open = false; });
      });
      const path = window.location.pathname;
      const view = new URLSearchParams(window.location.search).get("view") || "";
      bar.querySelectorAll(".topbar-nav a[href]").forEach((link) => {
        const url = new URL(link.getAttribute("href"), window.location.origin);
        const linkView = url.searchParams.get("view") || "";
        const samePath = url.pathname === path || (url.pathname !== "/" && path.startsWith(url.pathname + "/"));
        if (!samePath || (linkView && linkView !== view)) return;
        link.classList.add("is-active");
        const summary = link.closest("details") && link.closest("details").querySelector("summary");
        if (summary) summary.classList.add("is-active");
      });
    })();`;

function pageHead({ title, description = "", extraHeadHtml = "" } = {}) {
  const safeTitle = escapeHtml(title || "Maze Bench");
  const safeDescription = escapeHtml(
    description || "Maze Bench — ice-maze puzzles, a world editor, and coding-agent benchmark runs."
  );

  return `<meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}">
    <meta name="theme-color" content="#070811">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/site.css">
    ${extraHeadHtml}`;
}

function accountActionsHtml(remoteStatus) {
  // Only surface the account icon once connected; no "Connect" prompt when not.
  if (remoteStatus?.connected) {
    const name =
      remoteStatus.user?.name || remoteStatus.user?.display_name || remoteStatus.user?.mazebench_user_id || "Account";
    return `<a class="account-button account-icon-button" href="/build" title="${escapeHtml(name)} — synced with ${escapeHtml(
      remoteStatus.origin || "mazebench.com"
    )}">${ACCOUNT_ICON_SVG}</a>`;
  }

  return "";
}

function topbar({ rightHtml = "", extraNavHtml = "", extraHtml = "" } = {}) {
  return `<header class="topbar">
      <a class="brand-link" href="/"><span class="brand-mark" aria-hidden="true">${BRAND_MARK_SVG}</span>Maze Bench</a>
      <nav class="topbar-nav" aria-label="Site">
        <a class="nav-link play-nav-link" href="/play">Play</a>
        <a class="nav-link" href="/build">Build</a>
        <a class="nav-link" href="/agent">Agent</a>
        ${extraNavHtml}
      </nav>
      ${extraHtml}
      <div class="account-actions" aria-label="Account">${rightHtml}</div>
      <script>${TOPBAR_NAV_SCRIPT}</script>
    </header>`;
}

function siteFooter() {
  return `<footer class="site-footer">
      <span>Maze Bench (local)</span>
      <a class="text-link" href="/play">Play</a>
      <a class="text-link" href="/build">Build</a>
      <a class="text-link" href="/agent">Agent</a>
      <a class="text-link" href="https://mazebench.com">mazebench.com</a>
    </footer>`;
}

module.exports = {
  ACCOUNT_ICON_SVG,
  BRAND_MARK_SVG,
  TOPBAR_NAV_SCRIPT,
  accountActionsHtml,
  pageHead,
  siteFooter,
  topbar
};
