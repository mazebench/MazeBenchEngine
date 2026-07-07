(() => {
  const data = window.__BUILD_DATA__ || { worlds: [], master: null, apiUrl: "/api/build/worlds" };
  const statusEl = document.getElementById("build-status");
  const worldsEl = document.getElementById("build-worlds");

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
            <button type="button" data-action="delete">Delete</button>
          </div>
        </div>
      </div>`;
  }

  function renderWorlds() {
    if (!worldsEl) return;

    if (!data.worlds.length) {
      worldsEl.innerHTML = `<div class="empty-state"><span class="glyph">\u25a6</span><p>No local worlds yet. Create one below, duplicate the Maze Bench Environment, download a published world, or import a JSON export.</p></div>`;
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

  document.getElementById("download-world")?.addEventListener("click", async () => {
    const input = document.getElementById("download-world-id");
    const worldId = (input.value || "").trim();

    if (!worldId) {
      setStatus("Paste a published world id first (it looks like mbw_… — find it in the world's URL on the site).", true);
      return;
    }

    try {
      setStatus(`Downloading ${worldId}…`);
      // Pull as an editable local draft, then open it straight in the editor.
      const result = await api(`/api/remote/worlds/${encodeURIComponent(worldId)}/pull`, {
        method: "POST",
        body: JSON.stringify({ kind: "draft" })
      });
      setStatus(`${result.message} Opening the editor…`);
      window.location.href = result.world.author_url;
    } catch (error) {
      setStatus(error.message, true);
    }
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

  renderWorlds();
})();
