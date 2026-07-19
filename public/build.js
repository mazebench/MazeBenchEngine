(() => {
  const GEM_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"></path><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"></path><path d="M2 9h20"></path></svg>';
  const data = window.__BUILD_DATA__ || { worlds: [], master: null, apiUrl: "/api/build/worlds" };
  const statusEl = document.getElementById("build-status");
  const worldsEl = document.getElementById("build-worlds");
  const createWorldModal = document.getElementById("create-world-modal");
  const createWorldForm = document.getElementById("create-world-form");
  const createWorldStatus = document.getElementById("create-world-status");
  const deleteWorldModal = document.getElementById("delete-world-modal");
  const deleteWorldMessage = document.getElementById("delete-world-message");
  let deleteWorldResolve = null;

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
    return Number.isNaN(date.getTime())
      ? ""
      : `Updated ${date.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
  }

  function screenPreview(world) {
    const previews = world.level_previews || {};
    const previewKeys = Object.keys(previews);
    const width = Math.max(1, Number(world.world_width) || 1);
    const height = Math.max(1, Number(world.world_height) || 1);

    if (!previewKeys.length) {
      return '<div class="screen-nosignal"><span class="glyph">◇</span><span>No signal</span></div>';
    }

    if (width > 5 || height > 5) {
      const source = previews[world.first_level_id] || previews[previewKeys[0]];
      return `<div class="screen-mosaic" style="grid-template-columns:1fr;aspect-ratio:1/1;height:84%"><img class="mosaic-cell" src="${escapeText(source)}" alt="" loading="lazy" decoding="async"></div>`;
    }

    const cells = [];
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const levelId = `level_${String.fromCharCode(65 + column)}x${String.fromCharCode(65 + row)}`;
        cells.push(
          previews[levelId]
            ? `<img class="mosaic-cell" src="${escapeText(previews[levelId])}" alt="" loading="lazy" decoding="async">`
            : '<div class="mosaic-cell"></div>'
        );
      }
    }

    const fitStyle = width / height >= 1.6 ? "width:86%" : "height:84%";
    return `<div class="screen-mosaic" style="grid-template-columns:repeat(${width},1fr);grid-template-rows:repeat(${height},1fr);aspect-ratio:${width}/${height};${fitStyle}">${cells.join("")}</div>`;
  }

  function newWorldCard() {
    return `<button type="button" class="world-card new-world-card" data-action="create" aria-label="Create a new world">
      <span class="card-screen new-world-card__screen"><span class="new-world-card__plus" aria-hidden="true"></span></span>
      <span class="card-body new-world-card__body"><span class="new-world-card__label">New World</span></span>
    </button>`;
  }

  function worldCard(world) {
    const updated = formatWhen(world.updated_at);
    const gemCount = Math.max(0, Math.trunc(Number(world.total_gems) || 0));
    const gemLabel = `${gemCount} ${gemCount === 1 ? "gem" : "gems"}`;

    return `
      <article class="world-card world-card--draft" data-world-id="${escapeText(world.id)}">
        <a class="world-card__link" href="${escapeText(world.author_url)}" aria-label="Edit ${escapeText(world.title)}"></a>
        <div class="card-screen">
          ${screenPreview(world)}
          <div class="screen-fx"></div>
          <div class="screen-badges"><span class="badge badge--status">Draft</span></div>
          ${updated ? `<span class="badge badge--updated">${escapeText(updated)}</span>` : ""}
          <span class="screen-gems" title="${gemLabel}" aria-label="${gemLabel}">${GEM_ICON_SVG}<span>${gemCount}</span></span>
        </div>
        <div class="card-body">
          <h3 class="card-title" data-role="title">${escapeText(world.title)}</h3>
          <div class="card-actions card-actions--draft">
            <a class="button" href="${escapeText(world.author_url)}">Edit</a>
            <a class="button" href="${escapeText(world.play_url)}">Play</a>
            <button class="draft-delete-button" type="button" data-action="delete">Delete</button>
          </div>
        </div>
      </article>`;
  }

  function renderWorlds() {
    if (!worldsEl) return;

    worldsEl.innerHTML = newWorldCard() + data.worlds.map(worldCard).join("");
    worldsEl.querySelector('[data-action="create"]')?.addEventListener("click", openCreateWorldModal);

    worldsEl.querySelectorAll(".world-card").forEach((card) => {
      const worldId = card.dataset.worldId;
      const world = data.worlds.find((entry) => entry.id === worldId);

      card.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
        if (!(await confirmDeleteWorld(`Delete “${world.title}”? This removes its local files and cannot be undone.`))) return;

        try {
          const payload = await api(`${data.apiUrl}/${encodeURIComponent(worldId)}`, { method: "DELETE" });
          setStatus(payload.message);
          await refreshWorlds();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
    });

    queueNewWorldCardHeightSync();
  }

  function queueNewWorldCardHeightSync() {
    window.requestAnimationFrame(() => {
      syncNewWorldCardHeight();
      window.requestAnimationFrame(syncNewWorldCardHeight);
    });
  }

  function syncNewWorldCardHeight() {
    const tile = worldsEl?.querySelector(".new-world-card");
    const draft = worldsEl?.querySelector(".world-card--draft");
    const draftBody = draft?.querySelector(".card-body");
    if (!tile || !draft || !draftBody) {
      tile?.style.removeProperty("--new-world-card-height");
      tile?.style.removeProperty("--new-world-card-body-height");
      return;
    }
    const draftRect = draft.getBoundingClientRect();
    const draftBodyRect = draftBody.getBoundingClientRect();
    if (draftRect.height <= 0 || draftBodyRect.height <= 0) return;
    tile.style.setProperty("--new-world-card-height", `${Math.round(draftRect.height)}px`);
    tile.style.setProperty("--new-world-card-body-height", `${Math.round(draftBodyRect.height)}px`);
  }

  function openCreateWorldModal() {
    if (!createWorldModal) return;
    createWorldForm?.reset();
    const title = document.getElementById("new-world-title");
    if (title) title.value = "Untitled World";
    if (createWorldStatus) createWorldStatus.textContent = "";
    createWorldModal.hidden = false;
    window.requestAnimationFrame(() => createWorldModal.classList.add("open"));
    window.setTimeout(() => title?.focus(), 30);
  }

  function closeCreateWorldModal() {
    createWorldModal?.classList.remove("open");
    window.setTimeout(() => {
      if (createWorldModal && !createWorldModal.classList.contains("open")) createWorldModal.hidden = true;
    }, 180);
    if (createWorldStatus) createWorldStatus.textContent = "";
  }

  function confirmDeleteWorld(message) {
    if (!deleteWorldModal) return Promise.resolve(window.confirm(message));
    if (deleteWorldResolve) deleteWorldResolve(false);
    deleteWorldMessage.textContent = message;
    deleteWorldModal.hidden = false;
    window.requestAnimationFrame(() => deleteWorldModal.classList.add("open"));
    document.getElementById("confirm-world-delete")?.focus();
    return new Promise((resolve) => {
      deleteWorldResolve = resolve;
    });
  }

  function closeDeleteWorldModal(confirmed = false) {
    deleteWorldModal?.classList.remove("open");
    window.setTimeout(() => {
      if (deleteWorldModal && !deleteWorldModal.classList.contains("open")) deleteWorldModal.hidden = true;
    }, 180);
    const resolve = deleteWorldResolve;
    deleteWorldResolve = null;
    resolve?.(Boolean(confirmed));
  }

  async function createWorld(body) {
    try {
      const payload = await api(data.apiUrl, { method: "POST", body: JSON.stringify(body) });
      setStatus(payload.message);
      await refreshWorlds();
      return true;
    } catch (error) {
      setStatus(error.message, true);
      if (createWorldStatus) createWorldStatus.textContent = error.message || "Could not create the world.";
      return false;
    }
  }

  createWorldForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const created = await createWorld({
      title: document.getElementById("new-world-title")?.value || "",
      world_width: Number(document.getElementById("new-world-width")?.value || 3),
      world_height: Number(document.getElementById("new-world-height")?.value || 3)
    });
    if (created) closeCreateWorldModal();
  });

  document.getElementById("cancel-create-world")?.addEventListener("click", closeCreateWorldModal);
  createWorldModal?.addEventListener("click", (event) => {
    if (event.target === createWorldModal) closeCreateWorldModal();
  });
  document.getElementById("cancel-world-delete")?.addEventListener("click", () => closeDeleteWorldModal(false));
  document.getElementById("confirm-world-delete")?.addEventListener("click", () => closeDeleteWorldModal(true));
  deleteWorldModal?.addEventListener("click", (event) => {
    if (event.target === deleteWorldModal) closeDeleteWorldModal(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (createWorldModal?.classList.contains("open")) closeCreateWorldModal();
    if (deleteWorldModal?.classList.contains("open")) closeDeleteWorldModal(false);
  });
  window.addEventListener("resize", queueNewWorldCardHeightSync);

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
