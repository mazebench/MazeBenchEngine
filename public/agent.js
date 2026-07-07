(() => {
  const data = window.__AGENT_DATA__ || {
    worlds: [],
    apiUrl: "/api/agent/runs",
    modelsApiBase: "/api/agent/models",
    environment: {},
    remote: {}
  };
  const statusEl = document.getElementById("agent-status");
  const runsEl = document.getElementById("agent-runs");

  const PROVIDERS = [
    {
      id: "codex",
      name: "Codex",
      sub: "Codex CLI — your ChatGPT login",
      envKey: "codex",
      logo: '<img src="/logos/codex.png" alt="" loading="lazy">'
    },
    {
      id: "claude",
      name: "Claude Code",
      sub: "Claude Code — your Claude subscription",
      envKey: "claude",
      logo: '<img src="/logos/claude.png" alt="" loading="lazy">'
    },
    {
      id: "prime",
      name: "Prime Intellect",
      sub: "Verifiers evals via Prime Inference",
      envKey: "prime",
      logo: '<img src="/logos/prime.png" alt="" loading="lazy">'
    }
  ];

  const state = {
    provider: null,
    modelId: null,
    customModel: "",
    reasoning: "",
    worldId: data.worlds[0] ? data.worlds[0].id : null,
    levelId: null, // null = use the world's default from its metadata
    mode: "text",
    catalogs: {},
    openFolders: new Set()
  };

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  function escapeText(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  function currentWorld() {
    return data.worlds.find((world) => world.id === state.worldId) || data.worlds[0] || null;
  }

  function effectiveLevelId() {
    const world = currentWorld();
    if (!world) return null;
    return state.levelId && world.levels.some((level) => level.id === state.levelId)
      ? state.levelId
      : world.default_level_id;
  }

  function levelLabel(levelId) {
    return String(levelId || "").replace(/^level_/, "");
  }

  // ---- provider picker ----------------------------------------------------

  function renderProviders() {
    const host = document.getElementById("provider-picker");
    host.innerHTML = PROVIDERS.map((provider) => {
      const available = Boolean(data.environment?.[provider.envKey]);
      return `<button type="button" class="provider-card${state.provider === provider.id ? " is-selected" : ""}"
          data-provider="${provider.id}" role="radio" aria-checked="${state.provider === provider.id}">
        <span class="provider-card__logo">${provider.logo}</span>
        <span class="provider-card__name">${escapeText(provider.name)}</span>
        <span class="provider-card__sub">${escapeText(provider.sub)}</span>
        <span class="provider-card__avail ${available ? "is-ok" : "is-missing"}">${available ? "installed" : "not on PATH"}</span>
      </button>`;
    }).join("");

    host.querySelectorAll(".provider-card").forEach((card) => {
      card.addEventListener("click", () => selectProvider(card.dataset.provider));
    });
  }

  function selectProvider(providerId) {
    if (state.provider === providerId) return;
    state.provider = providerId;
    state.modelId = null;
    state.customModel = "";
    state.reasoning = "";
    document.getElementById("run-codex-fast").checked = false;

    const isPrime = providerId === "prime";
    document.getElementById("world-section").hidden = isPrime;
    document.getElementById("local-settings").hidden = isPrime;
    document.getElementById("prime-settings").hidden = !isPrime;

    renderProviders();
    renderModels();
    loadModels(providerId);
  }

  // ---- model picker ---------------------------------------------------------

  async function loadModels(providerId) {
    if (state.catalogs[providerId]) {
      renderModels();
      return;
    }

    const host = document.getElementById("model-picker");
    host.innerHTML = '<span class="muted">Loading models…</span>';

    try {
      const catalog = await api(`${data.modelsApiBase}/${encodeURIComponent(providerId)}`);
      state.catalogs[providerId] = catalog;
    } catch (error) {
      state.catalogs[providerId] = { models: [], note: error.message };
    }

    if (state.provider === providerId) {
      autoSelectModel();
      renderModels();
    }
  }

  // Pick the strongest model by default: the catalog's recommendation, else
  // the first entry, else fall back to a custom id box.
  function autoSelectModel() {
    if (state.modelId !== null) return;
    const catalog = state.catalogs[state.provider] || { models: [] };
    state.modelId = catalog.default_model_id || catalog.models[0]?.id || "__custom__";
  }

  function selectedModel() {
    const catalog = state.catalogs[state.provider] || { models: [] };
    return catalog.models.find((model) => model.id === state.modelId) || null;
  }

  function modelChip(model) {
    return `<button type="button" class="chip${state.modelId === model.id ? " is-selected" : ""}"
        data-model-id="${escapeText(model.id)}" role="radio" aria-checked="${state.modelId === model.id}">
      <span class="chip__label">${escapeText(model.label)}${model.fast ? ' <span class="chip__badge">FAST</span>' : ""}</span>
      ${model.description ? `<span class="chip__sub">${escapeText(model.description)}</span>` : ""}
    </button>`;
  }

  function renderModels() {
    const host = document.getElementById("model-picker");
    const noteEl = document.getElementById("model-note");
    const catalog = state.catalogs[state.provider];

    if (!catalog) {
      host.innerHTML = '<span class="muted">Loading models…</span>';
      noteEl.hidden = true;
      renderReasoning();
      return;
    }

    noteEl.textContent = catalog.note || "";
    noteEl.hidden = !catalog.note;

    const customChip = { id: "__custom__", label: "Custom…", description: "type any model id" };
    const grouped = catalog.models.some((model) => model.group);

    if (grouped) {
      // Prime: one folder per inference provider; click a folder to browse it.
      const groups = new Map();
      catalog.models.forEach((model) => {
        const key = model.group || "other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(model);
      });
      const selected = catalog.models.find((model) => model.id === state.modelId);

      host.innerHTML = `<div class="model-folders">${[...groups.entries()]
        .map(([group, models]) => {
          const open = state.openFolders.has(group);
          const containsSelected = models.some((model) => model.id === state.modelId);
          return `<div class="model-folder${open ? " is-open" : ""}${containsSelected ? " has-selected" : ""}">
            <button type="button" class="model-folder__head" data-folder="${escapeText(group)}" aria-expanded="${open}">
              <span class="model-folder__glyph">${open ? "▾" : "▸"}</span>
              <span class="model-folder__name">${escapeText(group)}</span>
              <span class="model-folder__count">${models.length}</span>
              ${containsSelected && !open ? `<span class="model-folder__selected">${escapeText(selected?.label || "")}</span>` : ""}
            </button>
            ${open ? `<div class="chip-row model-folder__body">${models.map(modelChip).join("")}</div>` : ""}
          </div>`;
        })
        .join("")}</div>
        <div class="chip-row" style="margin-top: 10px">${modelChip(customChip)}</div>`;

      host.querySelectorAll(".model-folder__head").forEach((head) => {
        head.addEventListener("click", () => {
          const group = head.dataset.folder;
          if (state.openFolders.has(group)) state.openFolders.delete(group);
          else state.openFolders.add(group);
          renderModels();
        });
      });
    } else {
      host.innerHTML = [...catalog.models, customChip].map(modelChip).join("");
    }

    host.querySelectorAll(".chip[data-model-id]").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.modelId = chip.dataset.modelId;
        if (state.modelId !== "__custom__") state.customModel = "";
        state.reasoning = "";
        renderModels();
      });
    });

    const customWrap = document.getElementById("model-custom");
    customWrap.hidden = state.modelId !== "__custom__";
    if (state.modelId === "__custom__" && catalog.models.length) {
      document.getElementById("model-custom-input").focus();
    }

    renderReasoning();
  }

  function renderReasoning() {
    const row = document.getElementById("reasoning-row");
    const host = document.getElementById("reasoning-picker");
    const fastSwitch = document.getElementById("fast-switch");

    if (state.provider !== "codex") {
      row.hidden = true;
      return;
    }

    const model = selectedModel();
    const levels =
      model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
        ? model.reasoning_levels
        : ["low", "medium", "high", "xhigh"];
    const defaultLevel = model?.default_reasoning || "";

    row.hidden = false;
    host.innerHTML = [
      { id: "", label: defaultLevel ? `default (${defaultLevel})` : "default" },
      ...levels.map((level) => ({ id: level, label: level }))
    ]
      .map(
        (level) => `<button type="button" class="chip chip--small${state.reasoning === level.id ? " is-selected" : ""}"
            data-reasoning="${escapeText(level.id)}">${escapeText(level.label)}</button>`
      )
      .join("");
    host.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.reasoning = chip.dataset.reasoning;
        renderReasoning();
      });
    });

    // Fast mode only where the catalog says the model supports it (default
    // model: show it — the CLI ignores the flag when unsupported).
    fastSwitch.hidden = Boolean(model) && !model.fast;
  }

  // ---- world + level pickers ------------------------------------------------

  function worldMosaic(world) {
    const urls = (world.preview_urls || []).slice(0, 4);
    if (!urls.length) {
      return '<span class="world-tile__nosignal">▦</span>';
    }
    return urls.map((url) => `<img src="${escapeText(url)}" alt="" loading="lazy">`).join("");
  }

  function renderWorlds() {
    const host = document.getElementById("world-picker");
    host.innerHTML = data.worlds
      .map(
        (world) => `<button type="button" class="world-tile${state.worldId === world.id ? " is-selected" : ""}"
            data-world-id="${escapeText(world.id)}" role="radio" aria-checked="${state.worldId === world.id}">
          <span class="world-tile__screen">${worldMosaic(world)}</span>
          <span class="world-tile__name">${escapeText(world.title)}</span>
          <span class="world-tile__meta">${world.world_width}×${world.world_height} · ${world.level_count} level${world.level_count === 1 ? "" : "s"}</span>
        </button>`
      )
      .join("");

    host.querySelectorAll(".world-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        state.worldId = tile.dataset.worldId;
        state.levelId = null;
        document.getElementById("level-picker").hidden = true;
        renderWorlds();
        renderLevelSummary();
      });
    });
  }

  function renderLevelSummary() {
    const host = document.getElementById("level-summary");
    const world = currentWorld();

    if (!world) {
      host.innerHTML = '<span class="muted">No worlds available.</span>';
      return;
    }

    const levelId = effectiveLevelId();
    const level = world.levels.find((entry) => entry.id === levelId) || null;
    const isDefault = levelId === world.default_level_id && !state.levelId;
    const picker = document.getElementById("level-picker");

    host.innerHTML = `
      <span class="level-summary__thumb">${
        level?.preview_url
          ? `<img src="${escapeText(level.preview_url)}" alt="">`
          : `<span>${escapeText(levelLabel(levelId))}</span>`
      }</span>
      <span class="level-summary__text">
        <strong>${escapeText(levelLabel(levelId))}</strong>
        <small>${isDefault ? "world default start" : "custom start level"}</small>
      </span>
      <button type="button" id="level-change">${picker.hidden ? "Change…" : "Close"}</button>
      ${!isDefault ? '<button type="button" id="level-reset">Use world default</button>' : ""}`;

    document.getElementById("level-change").addEventListener("click", () => {
      picker.hidden = !picker.hidden;
      if (!picker.hidden) renderLevelGrid();
      renderLevelSummary();
    });
    document.getElementById("level-reset")?.addEventListener("click", () => {
      state.levelId = null;
      picker.hidden = true;
      renderLevelSummary();
    });
  }

  function renderLevelGrid() {
    const picker = document.getElementById("level-picker");
    const world = currentWorld();

    if (!world) return;

    const axis = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const selectedId = effectiveLevelId();
    picker.innerHTML = `<p class="muted picker-note">Pick where the agent starts. The outlined room is the world's default start from its metadata.</p>
      <div class="level-grid" style="grid-template-columns: repeat(${world.world_width}, var(--level-cell, 44px))">
        ${world.levels
          .map((level) => {
            const column = axis.indexOf(level.column) + 1;
            const row = axis.indexOf(level.row) + 1;
            const isDefault = level.id === world.default_level_id;
            const isSelected = level.id === selectedId;
            return `<button type="button" class="level-cell${isSelected ? " is-selected" : ""}${isDefault ? " is-default" : ""}"
                style="grid-column: ${column}; grid-row: ${row}"
                data-level-id="${escapeText(level.id)}" title="${escapeText(levelLabel(level.id))}${isDefault ? " (default)" : ""}">
              ${level.preview_url ? `<img src="${escapeText(level.preview_url)}" alt="" loading="lazy">` : `<span>${escapeText(levelLabel(level.id))}</span>`}
            </button>`;
          })
          .join("")}
      </div>`;

    picker.querySelectorAll(".level-cell").forEach((cell) => {
      cell.addEventListener("click", () => {
        const world = currentWorld();
        state.levelId = cell.dataset.levelId === world.default_level_id ? null : cell.dataset.levelId;
        picker.hidden = true;
        renderLevelSummary();
      });
    });
  }

  // ---- online world download --------------------------------------------

  document.getElementById("online-world-pull")?.addEventListener("click", async () => {
    const input = document.getElementById("online-world-id");
    const worldId = (input.value || "").trim();

    if (!worldId) {
      setStatus("Paste a world id first (it looks like mbw_… — find it in the world's URL on the site).", true);
      return;
    }

    try {
      setStatus(`Downloading ${worldId}…`);
      const result = await api(`/api/remote/worlds/${encodeURIComponent(worldId)}/pull`, {
        method: "POST",
        body: JSON.stringify({ kind: "online" })
      });
      setStatus(`${result.message} Reloading…`);
      window.location.reload();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // ---- run settings ---------------------------------------------------------

  document.querySelectorAll("#mode-picker .segmented__option").forEach((option) => {
    option.addEventListener("click", () => {
      state.mode = option.dataset.mode;
      document.querySelectorAll("#mode-picker .segmented__option").forEach((other) => {
        const selected = other === option;
        other.classList.toggle("is-selected", selected);
        other.setAttribute("aria-pressed", String(selected));
      });
    });
  });

  // Container mode requires Docker installed AND its daemon running. Otherwise
  // force the toggle off and lock it so a run can never be launched that would
  // immediately fail.
  function syncContainerAvailability() {
    const input = document.getElementById("run-container");
    if (!input) return;
    const label = input.closest(".switch");
    const hint = label ? label.querySelector(".switch__label small") : null;
    const env = data.environment || {};
    const ready = Boolean(env.docker);

    input.disabled = !ready;
    if (label) label.classList.toggle("is-disabled", !ready);

    if (ready) {
      if (hint) hint.textContent = "isolated from your files";
      if (label) label.removeAttribute("title");
      return;
    }

    input.checked = false;
    if (env.docker_installed) {
      if (hint) hint.textContent = "needs Docker running — start Docker";
      if (label) {
        label.title =
          "Docker is installed but its daemon isn't running. Start Docker, then reload. Until then, runs use the per-CLI host sandbox.";
      }
    } else {
      if (hint) hint.textContent = "needs Docker — not installed";
      if (label) {
        label.title =
          "Install Docker to isolate agent runs. Without it, runs use the per-CLI host sandbox instead.";
      }
    }
  }

  function describeEnvironment() {
    const env = data.environment || {};
    const found = [];
    const missing = [];
    [["codex", "Codex CLI"], ["claude", "Claude Code"], ["prime", "Prime CLI"]].forEach(
      ([key, label]) => (env[key] ? found : missing).push(label)
    );
    // Docker has three states: ready, installed-but-stopped, and absent.
    if (env.docker) found.push("Docker");
    else if (env.docker_installed) missing.push("Docker (installed, daemon not running)");
    else missing.push("Docker");

    const parts = [];
    if (found.length) parts.push(`Available: ${found.join(", ")}.`);
    if (missing.length) parts.push(`Not available: ${missing.join(", ")}.`);
    if (!env.docker) parts.push("Without Docker, agents run on the per-CLI host sandbox.");
    document.getElementById("agent-environment").textContent = parts.join(" ");
  }

  // ---- launch ---------------------------------------------------------------

  function resolvedModelName() {
    if (state.modelId === "__custom__") {
      return (document.getElementById("model-custom-input").value || "").trim();
    }
    return state.modelId || "";
  }

  document.getElementById("launch-run")?.addEventListener("click", async () => {
    if (state.modelId === "__custom__" && !resolvedModelName() && (state.catalogs[state.provider]?.models || []).length) {
      setStatus("Type a model id or pick one from the list.", true);
      return;
    }

    const body =
      state.provider === "prime"
        ? {
            kind: "prime",
            model_name: resolvedModelName(),
            n: Number(document.getElementById("run-prime-n").value) || 1,
            r: Number(document.getElementById("run-prime-r").value) || 1,
            max_turns: Number(document.getElementById("run-prime-turns").value) || 8
          }
        : {
            kind: "local",
            model: state.provider,
            game_id: state.worldId,
            level_id: effectiveLevelId(),
            moves: Number(document.getElementById("run-moves").value) || 20,
            mode: state.mode,
            model_name: resolvedModelName(),
            reasoning: state.provider === "codex" ? state.reasoning : "",
            codex_fast: state.provider === "codex" && document.getElementById("run-codex-fast").checked,
            container: document.getElementById("run-container").checked,
            video: document.getElementById("run-video").checked,
            tools: document.getElementById("run-tools").checked
          };

    try {
      setStatus("Launching…");
      const payload = await api(data.apiUrl, { method: "POST", body: JSON.stringify(body) });
      setStatus(payload.message);
      window.location.href = payload.run.url;
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // ---- runs list (unchanged behavior) ---------------------------------------

  function runCard(run) {
    const statusClass =
      run.status === "running" || run.status === "stopping"
        ? "agent-chip--running"
        : run.status === "finished"
          ? "agent-chip--done"
          : "agent-chip--failed";
    const summary = [
      run.model_name || run.model,
      `${escapeText(run.game_title || run.game_id)} / ${escapeText(levelLabel(run.level_id))}`,
      `${run.turns}/${run.moves} moves`,
      `${run.gem_count ?? 0} gems${run.solved ? " — solved!" : ""}`
    ].join(" &middot; ");

    return `<div class="world-card agent-run-card" data-run-id="${escapeText(run.id)}">
      <div class="card-body">
        <h3 class="card-title"><span class="agent-chip ${statusClass}">${escapeText(run.status)}</span> ${escapeText(run.model)} on ${escapeText(run.game_title || run.game_id)}</h3>
        <p class="card-by">${summary}<br>${escapeText(new Date(run.created_at).toLocaleString())}</p>
        <div class="card-actions">
          <a class="button" href="${escapeText(run.url)}">Watch</a>
          ${run.has_video ? `<a class="button" href="/agent-runs/${encodeURIComponent(run.id)}/files/maze_replay.mp4">Video</a>` : ""}
          ${run.status === "running" ? '<button class="button--coral" type="button" data-action="stop">Stop</button>' : ""}
        </div>
      </div>
    </div>`;
  }

  let refreshTimer = null;

  async function refreshRuns() {
    try {
      const payload = await api(data.apiUrl);
      const runs = payload.runs || [];
      runsEl.innerHTML = runs.length
        ? runs.map(runCard).join("")
        : '<div class="empty-state"><span class="glyph">▶</span><p>No runs yet. Launch one above — you can watch it live.</p></div>';
      runsEl.querySelectorAll('[data-action="stop"]').forEach((button) => {
        button.addEventListener("click", async (event) => {
          const runId = event.target.closest("[data-run-id]").dataset.runId;
          try {
            await api(`${data.apiUrl}/${encodeURIComponent(runId)}/stop`, { method: "POST" });
            setStatus(`Stopping ${runId}…`);
            refreshRuns();
          } catch (error) {
            setStatus(error.message, true);
          }
        });
      });
      const anyRunning = runs.some((run) => run.status === "running" || run.status === "stopping");
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshRuns, anyRunning ? 3000 : 15000);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  // ---- boot -----------------------------------------------------------------

  const firstAvailable = PROVIDERS.find((provider) => data.environment?.[provider.envKey]);
  renderWorlds();
  renderLevelSummary();
  syncContainerAvailability();
  describeEnvironment();
  refreshRuns();
  selectProvider((firstAvailable || PROVIDERS[0]).id);
})();
