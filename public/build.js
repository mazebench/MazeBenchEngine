(() => {
  const data = window.__BUILD_DATA__ || { worlds: [], master: null, apiUrl: "/api/build/worlds" };
  const statusEl = document.getElementById("build-status");
  const masterEl = document.getElementById("build-master");
  const worldsEl = document.getElementById("build-worlds");
  const remoteSection = document.getElementById("build-remote-section");
  const remoteEl = document.getElementById("build-remote");

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...options
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }

    return payload;
  }

  async function refreshWorlds() {
    const payload = await api(data.apiUrl);
    data.worlds = payload.worlds || [];
    renderWorlds();
  }

  function escapeText(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function formatWhen(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }

  function mosaic(previewUrls) {
    const urls = (previewUrls || []).slice(0, 4);
    if (!urls.length) {
      return '<div class="screen-nosignal"><span class="glyph">\u25a6</span></div>';
    }
    return `<div class="screen-mosaic">${urls
      .map((url) => `<img class="mosaic-cell" src="${escapeText(url)}" alt="" loading="lazy">`)
      .join("")}</div>`;
  }

  function renderMaster() {
    if (!masterEl) return;

    if (!data.master) {
      masterEl.innerHTML = `<div class="empty-state"><span class="glyph">?</span><p>Master world not found.</p></div>`;
      return;
    }

    masterEl.innerHTML = `
      <div class="world-card">
        <a class="card-screen" href="${escapeText(data.master.play_url)}" aria-label="Play ${escapeText(data.master.name)}">
          ${mosaic(data.master.preview_urls)}
          <div class="screen-fx"></div>
          <div class="screen-badges"><span class="badge">MASTER</span></div>
          <div class="screen-play">PLAY</div>
        </a>
        <div class="card-body">
          <h3 class="card-title">${escapeText(data.master.name)}</h3>
          <p class="card-by">The world agents are benchmarked on</p>
          <div class="card-stats"><span><b>${data.master.level_count}</b> levels</span></div>
          <div class="card-actions">
            <a class="button" href="${escapeText(data.master.author_url)}">Edit Levels</a>
            <a class="button" href="${escapeText(data.master.world_map_url)}">World Map</a>
            <a class="button" href="${escapeText(data.master.flyover_url)}">Flyover</a>
          </div>
        </div>
      </div>`;
  }

  function worldCard(world) {
    const tags = [world.kind === "online" ? "ONLINE COPY" : "DRAFT"];
    if (world.remote_id) tags.push("SYNCED");

    return `
      <div class="world-card" data-world-id="${escapeText(world.id)}">
        <a class="card-screen" href="${escapeText(world.play_url)}" aria-label="Play ${escapeText(world.title)}">
          ${mosaic(world.preview_urls)}
          <div class="screen-fx"></div>
          <div class="screen-badges"><span class="badge">SIZE ${world.world_width}x${world.world_height}</span></div>
          <div class="screen-play">PLAY</div>
        </a>
        <div class="card-body">
          <h3 class="card-title" data-role="title">${escapeText(world.title)}</h3>
          <p class="card-by">${world.updated_at ? `Updated ${escapeText(formatWhen(world.updated_at))}` : ""}</p>
          <div class="card-stats"><span><b>${world.level_count}</b> level${world.level_count === 1 ? "" : "s"}</span></div>
          <div class="tags">${tags.map((tag) => `<span class="tag">${escapeText(tag)}</span>`).join("")}</div>
          <div class="card-actions">
            <a class="button" href="${escapeText(world.author_url)}">Edit</a>
            <a class="button" href="${escapeText(world.world_map_url)}">Map</a>
            <button type="button" data-action="rename">Rename</button>
            <a class="button" href="${world.export_url}" download="${escapeText(world.title || world.id)}.json">Export</a>
            <span data-role="sync-actions"></span>
            <button type="button" data-action="delete">Delete</button>
          </div>
        </div>
      </div>`;
  }

  function renderWorlds() {
    if (!worldsEl) return;

    if (!data.worlds.length) {
      worldsEl.innerHTML = `<div class="empty-state"><span class="glyph">\u25a6</span><p>No local worlds yet. Create one below, copy the master world, or import a JSON export.</p></div>`;
      return;
    }

    worldsEl.innerHTML = data.worlds.map(worldCard).join("");

    worldsEl.querySelectorAll(".world-card").forEach((card) => {
      const worldId = card.dataset.worldId;
      const world = data.worlds.find((entry) => entry.id === worldId);

      card.querySelector('[data-action="rename"]').addEventListener("click", async () => {
        const title = window.prompt("New world title:", world.title);
        if (!title || !title.trim()) return;

        try {
          const payload = await api(`${data.apiUrl}/${encodeURIComponent(worldId)}`, {
            method: "PATCH",
            body: JSON.stringify({ title: title.trim() })
          });
          setStatus(payload.message);
          await refreshWorlds();
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!window.confirm(`Delete "${world.title}"? This removes the local files.`)) return;

        try {
          const payload = await api(`${data.apiUrl}/${encodeURIComponent(worldId)}`, { method: "DELETE" });
          setStatus(payload.message);
          await refreshWorlds();
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      const syncHost = card.querySelector('[data-role="sync-actions"]');
      if (syncHost && data.remote && data.remote.connected) {
        const pushButton = document.createElement("button");
        pushButton.type = "button";
        pushButton.textContent = world.remote_id ? "Push Update" : "Push to Site";
        pushButton.addEventListener("click", async () => {
          try {
            setStatus(`Pushing ${world.title}…`);
            const payload = await api("/api/remote/push", {
              method: "POST",
              body: JSON.stringify({ game_id: world.id })
            });
            setStatus(payload.message);
            await refreshWorlds();
          } catch (error) {
            setStatus(error.message, true);
          }
        });
        syncHost.appendChild(pushButton);

        if (world.remote_id) {
          const pullButton = document.createElement("button");
          pullButton.type = "button";
          pullButton.textContent = "Pull Latest";
          pullButton.addEventListener("click", async () => {
            if (!window.confirm(`Overwrite the local copy of "${world.title}" with the site version?`)) return;
            try {
              setStatus(`Pulling ${world.title}…`);
              const payload = await api(`/api/remote/worlds/${encodeURIComponent(world.remote_id)}/pull`, {
                method: "POST",
                body: JSON.stringify({})
              });
              setStatus(payload.message);
              await refreshWorlds();
            } catch (error) {
              setStatus(error.message, true);
            }
          });
          syncHost.appendChild(pullButton);
        }
      }
    });
  }

  function renderRemotePanel() {
    if (!remoteSection || !remoteEl) return;
    remoteSection.hidden = false;
    const remote = data.remote || {};

    if (!remote.connected) {
      remoteEl.innerHTML = `
        <p class="muted">Connect your ${escapeText(remote.origin || "mazebench.com")} account to sync drafts both ways. Drafts stay private — publishing is a separate step on the site.</p>
        <div class="card-actions">
          <button id="remote-link" class="button--primary" type="button">Connect via Browser</button>
        </div>
        <details style="margin-top: 12px">
          <summary class="muted" style="cursor: pointer">Or paste a session token manually</summary>
          <div class="form-grid" style="margin-top: 10px; grid-template-columns: minmax(0, 1fr) auto">
            <label class="field"><span>Session token (mazebench_session cookie)</span><input id="remote-token" type="password" autocomplete="off"></label>
            <button id="remote-connect" type="button">Connect</button>
          </div>
          <p class="muted">On ${escapeText(remote.origin || "the site")}, sign in, open DevTools &rarr; Application &rarr; Cookies, and copy the <code>mazebench_session</code> value.</p>
        </details>`;

      document.getElementById("remote-link")?.addEventListener("click", async () => {
        try {
          const payload = await api("/api/remote/link/start");
          window.open(payload.url, "_blank");
          setStatus("Approve the link on the site tab; this page will pick it up when you return. (If the site does not support device links yet, use the manual token instead.)");
        } catch (error) {
          setStatus(error.message, true);
        }
      });

      document.getElementById("remote-connect")?.addEventListener("click", async () => {
        try {
          const token = document.getElementById("remote-token")?.value || "";
          setStatus("Verifying token…");
          const status = await api("/api/remote/connect", { method: "POST", body: JSON.stringify({ token }) });
          data.remote = status;
          setStatus(`Connected as ${status.user?.display_name || status.user?.name || "your account"}.`);
          renderRemotePanel();
          renderWorlds();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
      return;
    }

    remoteEl.innerHTML = `
      <p class="muted">Connected to ${escapeText(remote.origin)} as <strong>${escapeText(
        remote.user?.display_name || remote.user?.name || remote.user?.mazebench_user_id || "you"
      )}</strong>.</p>
      <div class="card-actions">
        <button id="remote-refresh" type="button">Show My Site Drafts</button>
        <button id="remote-disconnect" class="button--coral" type="button">Disconnect</button>
      </div>
      <div id="remote-worlds" class="remote-world-list"></div>`;

    document.getElementById("remote-disconnect")?.addEventListener("click", async () => {
      try {
        data.remote = await api("/api/remote/disconnect", { method: "POST" });
        setStatus("Disconnected.");
        renderRemotePanel();
        renderWorlds();
      } catch (error) {
        setStatus(error.message, true);
      }
    });

    document.getElementById("remote-refresh")?.addEventListener("click", async () => {
      const host = document.getElementById("remote-worlds");
      host.innerHTML = '<p class="author-panel__copy">Loading…</p>';
      try {
        const payload = await api("/api/remote/worlds?view=drafts");
        const linkedRemoteIds = new Set(data.worlds.map((world) => world.remote_id).filter(Boolean));
        const worlds = payload.worlds || [];
        host.innerHTML = worlds.length
          ? worlds
              .map(
                (world) => `<div class="world-card" data-remote-id="${escapeText(world.id)}">
                  <div class="card-body">
                    <h3 class="card-title">${escapeText(world.title)}</h3>
                    <p class="card-by">${world.world_width && world.world_height ? `${world.world_width}&times;${world.world_height} world &middot; ` : ""}${world.updated_at ? `updated ${escapeText(formatWhen(world.updated_at))}` : ""}</p>
                    ${linkedRemoteIds.has(world.id) ? '<div class="tags"><span class="tag">LINKED</span></div>' : ""}
                    <div class="card-actions">
                      <button type="button" data-action="pull">${linkedRemoteIds.has(world.id) ? "Pull Latest" : "Pull to Local"}</button>
                    </div>
                  </div>
                </div>`
              )
              .join("")
          : '<p class="muted">No drafts on the site yet. Push a local world up!</p>';
        host.querySelectorAll('[data-action="pull"]').forEach((button) => {
          button.addEventListener("click", async (event) => {
            const remoteId = event.target.closest("[data-remote-id]").dataset.remoteId;
            try {
              setStatus("Pulling…");
              const result = await api(`/api/remote/worlds/${encodeURIComponent(remoteId)}/pull`, {
                method: "POST",
                body: JSON.stringify({})
              });
              setStatus(result.message);
              await refreshWorlds();
            } catch (error) {
              setStatus(error.message, true);
            }
          });
        });
      } catch (error) {
        host.innerHTML = `<p class="author-panel__copy">${escapeText(error.message)}</p>`;
      }
    });
  }

  async function createWorld(body) {
    try {
      const payload = await api(data.apiUrl, { method: "POST", body: JSON.stringify(body) });
      setStatus(payload.message);
      await refreshWorlds();
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  document.getElementById("create-world")?.addEventListener("click", () => {
    createWorld({
      title: document.getElementById("new-world-title")?.value || "",
      world_width: Number(document.getElementById("new-world-width")?.value || 3),
      world_height: Number(document.getElementById("new-world-height")?.value || 3)
    });
  });

  document.getElementById("copy-master")?.addEventListener("click", () => {
    createWorld({ source_game_id: "maze", title: "" });
  });

  const importInput = document.getElementById("import-world-file");
  document.getElementById("import-world")?.addEventListener("click", () => importInput?.click());
  importInput?.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = "";
    if (!file) return;

    try {
      const editorState = JSON.parse(await file.text());
      await createWorld({ editor_state: editorState, title: editorState.title || "" });
    } catch (error) {
      setStatus(`Import failed: ${error.message}`, true);
    }
  });

  const query = new URLSearchParams(window.location.search);
  if (query.get("linked") === "1") {
    setStatus("Account linked successfully.");
  } else if (query.get("link_error")) {
    setStatus(`Account link failed: ${query.get("link_error")}`, true);
  }

  renderMaster();
  renderWorlds();
  renderRemotePanel();
})();
