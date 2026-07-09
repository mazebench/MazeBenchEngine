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
      sub: "Verifiers v1 eval (uv run eval)",
      envKey: "uv",
      logo: '<img src="/logos/prime.png" alt="" loading="lazy">'
    }
  ];

  const MODELS_LOADING_MARKUP =
    '<div class="models-loading"><span class="inline-spinner" aria-hidden="true"></span><span class="muted">Loading models…</span></div>';

  const state = {
    provider: null,
    modelId: null,
    customModel: "",
    reasoning: "",
    worldId: data.worlds[0] ? data.worlds[0].id : null,
    levelId: null, // null = use the world's default from its metadata
    mode: "text",
    isolation: "docker",
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
    // Codex/Claude default to the model's own reasoning; Prime models only emit
    // reasoning when we ask for it (esp. Claude's extended thinking), so default
    // Prime to a real effort level so the reasoning feed populates out of the box.
    state.reasoning = providerId === "prime" ? "medium" : "";
    document.getElementById("run-codex-fast").checked = false;

    const isPrime = providerId === "prime";
    document.getElementById("world-section").hidden = isPrime;
    document.getElementById("local-settings").hidden = isPrime;
    document.getElementById("prime-settings").hidden = !isPrime;

    renderProviders();
    renderModels();
    loadModels(providerId);
    syncBatch();
  }

  // ---- model picker ---------------------------------------------------------

  async function loadModels(providerId) {
    if (state.catalogs[providerId]) {
      autoSelectModel();
      renderModels();
      return;
    }

    const host = document.getElementById("model-picker");
    host.innerHTML = MODELS_LOADING_MARKUP;

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
        // Codex reasoning levels are per-model, so reset on model change; Claude
        // and Prime effort is provider-wide, so keep the current choice.
        if (state.provider === "codex") state.reasoning = "";
        renderModels();
      });
    });

    const customWrap = document.getElementById("model-custom");
    customWrap.hidden = state.modelId !== "__custom__";
    if (state.modelId === "__custom__" && catalog.models.length) {
      document.getElementById("model-custom-input").focus();
    }

    renderReasoning();
    renderPrimeMode();
  }

  // Both Codex and Claude Code expose a reasoning-effort setting. Codex reads it
  // per model (from its cache); Claude Code's `--effort` accepts a fixed set.
  function reasoningOptions() {
    const catalog = state.catalogs[state.provider] || {};

    if (state.provider === "prime") {
      // Passed through to the eval as --sampling.reasoning-effort. OpenAI
      // reasoning models and Claude (extended thinking) honor it; models that
      // don't support reasoning simply ignore it. "" = off (no effort sent).
      return { levels: ["low", "medium", "high"], defaultLevel: "" };
    }

    if (state.provider === "claude") {
      return {
        levels:
          Array.isArray(catalog.reasoning_levels) && catalog.reasoning_levels.length
            ? catalog.reasoning_levels
            : ["low", "medium", "high", "xhigh", "max"],
        defaultLevel: catalog.reasoning_default || ""
      };
    }

    const model = selectedModel();
    return {
      levels:
        model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
          ? model.reasoning_levels
          : ["low", "medium", "high", "xhigh"],
      defaultLevel: model?.default_reasoning || ""
    };
  }

  function renderReasoning() {
    const row = document.getElementById("reasoning-row");
    const host = document.getElementById("reasoning-picker");
    const fastSwitch = document.getElementById("fast-switch");

    if (state.provider !== "codex" && state.provider !== "claude" && state.provider !== "prime") {
      row.hidden = true;
      return;
    }

    const model = selectedModel();
    const { levels, defaultLevel } = reasoningOptions();
    // The "" chip means "no reasoning effort". For Codex/Claude that's the
    // model's own default; for Prime it means reasoning is off entirely.
    const offLabel = state.provider === "prime" ? "off" : defaultLevel ? `default (${defaultLevel})` : "default";

    row.hidden = false;
    host.innerHTML = [
      { id: "", label: offLabel },
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

    // Fast mode is a Codex-only tier; only offer it when the model supports it.
    fastSwitch.hidden = state.provider !== "codex" || (Boolean(model) && !model.fast);
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

  // Text/Vision segmented control. Both the local #mode-picker and the Prime
  // #prime-mode-picker drive the same state.mode, so selecting in one syncs the
  // visual state of both.
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".segmented__option[data-mode]").forEach((option) => {
      const selected = option.dataset.mode === mode;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    // View distance only applies to rendered vision frames.
    const viewField = document.getElementById("vision-view-field");
    if (viewField) viewField.hidden = mode !== "vision";
  }

  document.querySelectorAll(".segmented__option[data-mode]").forEach((option) => {
    option.addEventListener("click", () => {
      if (option.disabled) return;
      setMode(option.dataset.mode);
    });
  });

  // Prime models differ in whether they accept image inputs and the catalog
  // can't tell us directly, so the server infers it (primeModelVision) and tags
  // each model with `vision`. A text-only model locks Vision off. A custom
  // (user-typed) id is unknown, so we trust the user and allow it.
  function primeModelAcceptsImages() {
    if (state.provider !== "prime") return true;
    if (state.modelId === "__custom__") return true;
    const model = selectedModel();
    return model ? Boolean(model.vision) : true;
  }

  function renderPrimeMode() {
    const picker = document.getElementById("prime-mode-picker");
    if (!picker) return;

    const visionOption = picker.querySelector('.segmented__option[data-mode="vision"]');
    const canVision = primeModelAcceptsImages();

    if (visionOption) {
      visionOption.disabled = !canVision;
      visionOption.classList.toggle("is-disabled", !canVision);
      visionOption.title = canVision ? "" : "This model is text-only — it can't accept image inputs.";
    }

    // Never leave a text-only model stuck in Vision mode, then re-sync visuals.
    if (!canVision && state.mode === "vision") state.mode = "text";
    setMode(state.mode);

    const note = document.getElementById("prime-vision-note");
    if (note) {
      const model = selectedModel();
      note.textContent = canVision ? "" : `${model ? model.label : "This model"} is text-only — Vision (image inputs) is unavailable.`;
      note.hidden = canVision;
    }
  }

  // Isolation is a two-way choice — Docker (isolated container) or Full tools
  // (full host access). There is no host-sandbox middle mode: the codex/claude
  // workspace-write sandbox has no network, so it can't render vision frames.
  function setIsolation(value) {
    state.isolation = value === "full" ? "full" : "docker";
    document.querySelectorAll(".segmented__option[data-isolation]").forEach((option) => {
      const selected = option.dataset.isolation === state.isolation;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
  }

  // Docker mode needs Docker installed AND its daemon running. When it isn't,
  // disable that option and fall back to Full tools so a run can never be
  // launched that would immediately fail.
  function syncIsolationPicker() {
    const dockerOption = document.querySelector('.segmented__option[data-isolation="docker"]');
    if (!dockerOption) return;
    const env = data.environment || {};
    const ready = Boolean(env.docker);
    const hint = dockerOption.querySelector("small");

    dockerOption.disabled = !ready;
    dockerOption.classList.toggle("is-disabled", !ready);

    if (ready) {
      if (hint) hint.textContent = "isolated from your files";
      dockerOption.removeAttribute("title");
    } else {
      if (hint) hint.textContent = env.docker_installed ? "start Docker below" : "Docker not installed";
      dockerOption.title = env.docker_installed
        ? "Docker is installed but its daemon isn't running. Start it below, or use Full tools."
        : "Install Docker to isolate agent runs, or use Full tools.";
      // Never leave a run stuck on an unavailable Docker mode.
      if (state.isolation === "docker") setIsolation("full");
    }

    renderDockerAction();
  }

  let dockerStarting = false;

  // Show a "Start Docker" button only when Docker is installed but stopped.
  function renderDockerAction() {
    const host = document.getElementById("docker-action");
    if (!host) return;
    const env = data.environment || {};

    if (env.docker || !env.docker_installed) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }

    host.hidden = false;
    if (dockerStarting) {
      host.innerHTML = `<span class="docker-action__spinner" aria-hidden="true"></span><span class="docker-action__text">Starting Docker… this can take up to a minute.</span>`;
      return;
    }

    host.innerHTML = `<button id="start-docker" type="button" class="button--sky">Start Docker</button>
      <span class="docker-action__text muted">Docker is installed but not running.</span>`;
    document.getElementById("start-docker").addEventListener("click", startDocker);
  }

  async function refreshEnvironment() {
    const env = await api("/api/agent/environment");
    data.environment = env;
    return env;
  }

  async function startDocker() {
    dockerStarting = true;
    renderDockerAction();
    setStatus("Starting Docker…");

    let result;
    try {
      result = await api("/api/agent/docker/start", { method: "POST" });
    } catch (error) {
      dockerStarting = false;
      renderDockerAction();
      setStatus(error.message, true);
      return;
    }

    if (!result.started) {
      // The server could not auto-start it (e.g. Linux) — show its guidance.
      dockerStarting = false;
      renderDockerAction();
      setStatus(result.message, true);
      return;
    }

    // Poll the environment until the daemon is reachable (up to ~90s).
    const deadline = Date.now() + 90000;
    const poll = async () => {
      try {
        const env = await refreshEnvironment();
        if (env.docker) {
          dockerStarting = false;
          setIsolation("docker"); // the user clearly wants containers
          syncIsolationPicker();
          describeEnvironment();
          setStatus("Docker is running — Docker mode enabled.");
          return;
        }
      } catch (error) {
        /* transient — keep polling */
      }

      if (Date.now() < deadline) {
        setTimeout(poll, 3000);
      } else {
        dockerStarting = false;
        renderDockerAction();
        setStatus("Docker is taking a while to start — reload once it's ready.", true);
      }
    };
    setTimeout(poll, 3000);
  }

  function describeEnvironment() {
    const env = data.environment || {};
    const found = [];
    const missing = [];
    [["codex", "Codex CLI"], ["claude", "Claude Code"], ["uv", "uv (Prime evals)"]].forEach(
      ([key, label]) => (env[key] ? found : missing).push(label)
    );
    // Docker has three states: ready, installed-but-stopped, and absent.
    if (env.docker) found.push("Docker");
    else if (env.docker_installed) missing.push("Docker (installed, daemon not running)");
    else missing.push("Docker");

    const parts = [];
    if (found.length) parts.push(`Available: ${found.join(", ")}.`);
    if (missing.length) parts.push(`Not available: ${missing.join(", ")}.`);
    if (!env.docker) parts.push("Without Docker, runs need Full tool access (there is no host-sandbox mode).");
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
            max_turns: Number(document.getElementById("run-prime-turns").value) || 20,
            vision: state.mode === "vision",
            reasoning: state.reasoning,
            video: true
          }
        : {
            kind: "local",
            model: state.provider,
            game_id: state.worldId,
            level_id: effectiveLevelId(),
            moves: Number(document.getElementById("run-moves").value) || 20,
            mode: state.mode,
            vision_view: state.mode === "vision" ? document.getElementById("run-vision-view")?.value || "" : "",
            model_name: resolvedModelName(),
            reasoning: state.provider === "codex" || state.provider === "claude" ? state.reasoning : "",
            codex_fast: state.provider === "codex" && document.getElementById("run-codex-fast").checked,
            container: state.isolation === "docker",
            video: document.getElementById("run-video").checked,
            tools: state.isolation === "full"
          };

    body.count = Math.max(1, Math.min(8, Math.floor(Number(document.getElementById("run-batch").value) || 1)));

    try {
      setStatus(body.count > 1 ? `Launching ${body.count} runs…` : "Launching…");
      const payload = await api(data.apiUrl, { method: "POST", body: JSON.stringify(body) });
      setStatus(payload.message);
      // A batch stays on this page and surfaces in the runs list; a single run
      // jumps straight to its live view.
      if ((payload.runs || []).length > 1) {
        runsView.page = 1;
        refreshRuns();
        document.querySelector('[aria-label="Runs"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.location.href = payload.run.url;
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // Claude Code can't run multiple concurrent instances, so lock its batch to 1.
  function syncBatch() {
    const input = document.getElementById("run-batch");
    const note = document.getElementById("batch-note");
    if (!input) return;
    const isClaude = state.provider === "claude";
    input.disabled = isClaude;
    if (isClaude) input.value = "1";
    note.textContent = isClaude ? "Claude Code runs one at a time — batch is limited to a single run." : "";
    note.hidden = !isClaude;
  }

  // ---- runs list (unchanged behavior) ---------------------------------------

  const runsView = { page: 1, pageSize: 10, provider: "", model: "", query: "", sort: "newest" };

  function runStatusClass(status) {
    if (status === "running" || status === "stopping") return "agent-chip--running";
    if (status === "paused") return "agent-chip--paused";
    if (status === "finished") return "agent-chip--done";
    return "agent-chip--failed";
  }

  function runCard(run) {
    const statusLabel =
      run.status === "paused"
        ? run.pause_reason === "quota"
          ? "paused · out of funds"
          : "paused"
        : run.status;
    const summary = [
      run.model_name || run.model,
      `${escapeText(run.game_title || run.game_id)} / ${escapeText(levelLabel(run.level_id))}`,
      `${run.turns}/${run.moves} moves`,
      `${run.gem_count ?? 0} gems${run.solved ? " — solved!" : ""}`
    ].join(" &middot; ");

    const actions = [
      `<a class="button" href="${escapeText(run.url)}">Watch</a>`,
      run.has_video
        ? `<a class="button" href="/agent-runs/${encodeURIComponent(run.id)}/files/maze_replay.mp4">Video</a>`
        : "",
      run.pausable ? '<button class="button" type="button" data-action="pause">Pause</button>' : "",
      run.resumable ? '<button class="button--primary" type="button" data-action="resume">Resume</button>' : "",
      run.continuable ? '<button class="button" type="button" data-action="continue">Continue</button>' : "",
      run.status === "running" || run.status === "stopping"
        ? '<button class="button--coral" type="button" data-action="stop">Stop</button>'
        : "",
      '<button class="button--ghost run-trash" type="button" data-action="delete" title="Delete run" aria-label="Delete run">🗑</button>'
    ]
      .filter(Boolean)
      .join("");

    return `<div class="world-card agent-run-card" data-run-id="${escapeText(run.id)}">
      <div class="card-body">
        <h3 class="card-title"><span class="agent-chip ${runStatusClass(run.status)}">${escapeText(statusLabel)}</span> ${escapeText(run.model)} on ${escapeText(run.game_title || run.game_id)}</h3>
        <p class="card-by">${summary}<br>${escapeText(run.created_at ? new Date(run.created_at).toLocaleString() : "")}${run.continued ? ` &middot; continued ×${run.continued}` : run.continue_of ? " &middot; continued" : ""}</p>
        <div class="card-actions">${actions}</div>
      </div>
    </div>`;
  }

  function runsQuery() {
    const params = new URLSearchParams({
      page: String(runsView.page),
      page_size: String(runsView.pageSize),
      sort: runsView.sort
    });
    if (runsView.provider) params.set("provider", runsView.provider);
    if (runsView.model) params.set("model", runsView.model);
    if (runsView.query) params.set("q", runsView.query);
    return params.toString();
  }

  function syncFilterSelect(id, values, current, allLabel) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeText(value)}">${escapeText(value)}</option>`))
      .join("");
    select.value = values.includes(current) ? current : "";
  }

  const ACTION_LABELS = { pause: "Paused", resume: "Resumed", stop: "Stopping" };

  function wireRunActions() {
    runsEl.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        const runId = event.target.closest("[data-run-id]").dataset.runId;
        const action = button.dataset.action;
        try {
          if (action === "delete") {
            if (!window.confirm("Delete this run and its artifacts? This can't be undone.")) return;
            await api(`${data.apiUrl}/${encodeURIComponent(runId)}`, { method: "DELETE" });
            setStatus(`Deleted ${runId}.`);
          } else if (action === "continue") {
            const answer = window.prompt("How many more moves should it run?", "10");
            if (answer === null) return;
            const moves = Math.max(1, Math.min(500, Math.floor(Number(answer) || 0)));
            if (!moves) {
              setStatus("Enter a positive number of moves.", true);
              return;
            }
            const payload = await api(`${data.apiUrl}/${encodeURIComponent(runId)}/continue`, {
              method: "POST",
              body: JSON.stringify({ moves })
            });
            setStatus(payload.message);
            window.location.href = payload.run.url;
            return;
          } else {
            const payload = await api(`${data.apiUrl}/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
            // A quota resume relaunches as a new continuation run — go watch it.
            if (action === "resume" && payload.run && payload.run.id !== runId) {
              setStatus(`Resuming as run ${payload.run.id}…`);
              window.location.href = payload.run.url;
              return;
            }
            setStatus(`${ACTION_LABELS[action] || action} ${runId}.`);
          }
          refreshRuns();
        } catch (error) {
          setStatus(error.message, true);
        }
      });
    });
  }

  let refreshTimer = null;

  async function refreshRuns() {
    try {
      const payload = await api(`${data.apiUrl}?${runsQuery()}`);
      const runs = payload.runs || [];
      const total = payload.total ?? runs.length;

      document.getElementById("runs-total").textContent = total ? `${total} run${total === 1 ? "" : "s"}` : "";
      syncFilterSelect("runs-provider", payload.providers || [], runsView.provider, "All providers");
      syncFilterSelect("runs-model", payload.models || [], runsView.model, "All models");

      runsEl.innerHTML = runs.length
        ? runs.map(runCard).join("")
        : total
          ? '<div class="empty-state"><span class="glyph">▤</span><p>No runs match your filters.</p></div>'
          : '<div class="empty-state"><span class="glyph">▶</span><p>No runs yet. Launch one above — you can watch it live.</p></div>';
      wireRunActions();

      const pages = payload.pages || 1;
      const pager = document.getElementById("runs-pager");
      pager.hidden = pages <= 1;
      document.getElementById("runs-page-label").textContent = `Page ${payload.page || 1} of ${pages}`;
      document.getElementById("runs-prev").disabled = (payload.page || 1) <= 1;
      document.getElementById("runs-next").disabled = (payload.page || 1) >= pages;

      const active = payload.active || runs.some((run) => run.status === "running" || run.status === "stopping");
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshRuns, active ? 3000 : 15000);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function wireRunsToolbar() {
    const search = document.getElementById("runs-search");
    let searchTimer = null;
    search?.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        runsView.query = search.value.trim();
        runsView.page = 1;
        refreshRuns();
      }, 300);
    });

    const onFilter = (id, key, cast) =>
      document.getElementById(id)?.addEventListener("change", (event) => {
        runsView[key] = cast ? cast(event.target.value) : event.target.value;
        runsView.page = 1;
        refreshRuns();
      });
    onFilter("runs-provider", "provider");
    onFilter("runs-model", "model");
    onFilter("runs-sort", "sort");
    onFilter("runs-page-size", "pageSize", (value) => Number(value) || 10);

    document.getElementById("runs-prev")?.addEventListener("click", () => {
      if (runsView.page > 1) {
        runsView.page -= 1;
        refreshRuns();
      }
    });
    document.getElementById("runs-next")?.addEventListener("click", () => {
      runsView.page += 1;
      refreshRuns();
    });
  }

  // ---- boot -----------------------------------------------------------------

  const firstAvailable = PROVIDERS.find((provider) => data.environment?.[provider.envKey]);
  renderWorlds();
  renderLevelSummary();
  document.querySelectorAll(".segmented__option[data-isolation]").forEach((option) => {
    option.addEventListener("click", () => {
      if (option.disabled) return;
      setIsolation(option.dataset.isolation);
    });
  });
  syncIsolationPicker();
  describeEnvironment();
  wireRunsToolbar();
  refreshRuns();
  selectProvider((firstAvailable || PROVIDERS[0]).id);
})();
