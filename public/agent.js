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
      envKey: "codex",
      logo: '<img src="/logos/codex.png" alt="" loading="lazy">'
    },
    {
      id: "claude",
      name: "Claude Code",
      envKey: "claude",
      logo: '<img src="/logos/claude.png" alt="" loading="lazy">'
    },
    {
      id: "prime",
      name: "Prime Intellect",
      envKey: "uv",
      logo: '<img src="/logos/prime.png" alt="" loading="lazy">'
    }
  ];
  const RUN_COMPANY_NAMES = {
    codex: "OpenAI",
    claude: "Anthropic",
    prime: "Prime Intellect"
  };
  const RUN_STATUS_LABELS = {
    waiting: "Waiting",
    running: "Running",
    paused: "Paused",
    stopping: "Stopping",
    stopped: "Stopped",
    finished: "Completed",
    failed: "Failed"
  };

  const MODELS_LOADING_MARKUP =
    '<div class="models-loading" role="status" aria-live="polite"><span class="inline-spinner" aria-hidden="true"></span><span class="models-loading__label">Loading models</span></div>';
  // Route, Gem, and Door Open from Lucide Icons (ISC License).
  const RUN_METRIC_ICONS = {
    moves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="6" cy="19" r="3"></circle><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"></path><circle cx="18" cy="5" r="3"></circle></svg>',
    gems: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M10.5 3 8 9l4 13 4-13-2.5-6"></path><path d="M17 3a2 2 0 0 1 1.6.8l3 4a2 2 0 0 1 .013 2.382l-7.99 10.986a2 2 0 0 1-3.247 0l-7.99-10.986A2 2 0 0 1 2.4 7.8l2.998-3.997A2 2 0 0 1 7 3z"></path><path d="M2 9h20"></path></svg>',
    rooms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M11 20H2"></path><path d="M11 4.562v16.157a1 1 0 0 0 1.242.97L19 20V5.562a2 2 0 0 0-1.515-1.94l-4-1A2 2 0 0 0 11 4.561z"></path><path d="M11 4H8a2 2 0 0 0-2 2v14"></path><path d="M14 12h.01"></path><path d="M22 20h-3"></path></svg>'
  };
  const resizeAnimations = new WeakMap();
  const visibilityAnimations = new WeakMap();
  const selectionTargets = new WeakMap();

  const state = {
    provider: null,
    modelId: null,
    customModel: "",
    reasoning: null,
    reasoningChosen: false,
    worldId: null,
    levelId: null, // null = use the world's default from its metadata
    mode: null,
    isolation: null,
    catalogs: {},
    openFolders: new Set(),
    modelQuery: ""
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

  function tweenResize(element, mutate, duration = 380) {
    if (!element) {
      mutate();
      return;
    }

    resizeAnimations.get(element)?.cancel();
    const startHeight = element.getBoundingClientRect().height;
    mutate();
    const endHeight = element.getBoundingClientRect().height;

    if (
      Math.abs(startHeight - endHeight) < 1 ||
      !element.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const previousOverflow = element.style.overflow;
    element.style.overflow = "clip";
    const animation = element.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    resizeAnimations.set(element, animation);
    const cleanup = () => {
      if (resizeAnimations.get(element) === animation) resizeAnimations.delete(element);
      element.style.overflow = previousOverflow;
    };
    animation.addEventListener("finish", cleanup, { once: true });
    animation.addEventListener("cancel", cleanup, { once: true });
  }

  function tweenVisibility(element, show, duration = 380, onComplete) {
    if (!element) {
      onComplete?.();
      return;
    }
    const current = visibilityAnimations.get(element);
    if (current?.show === show) return;
    current?.animation.cancel();

    if (show && !element.hidden) {
      onComplete?.();
      return;
    }
    if (!show && element.hidden) {
      onComplete?.();
      return;
    }
    if (!element.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.hidden = !show;
      onComplete?.();
      return;
    }

    if (show) element.hidden = false;
    const fullHeight = element.getBoundingClientRect().height;
    const previousOverflow = element.style.overflow;
    element.style.overflow = "clip";
    const animation = element.animate(
      show
        ? [{ height: "0px", opacity: 0 }, { height: `${fullHeight}px`, opacity: 1 }]
        : [{ height: `${fullHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    const entry = { animation, show };
    visibilityAnimations.set(element, entry);
    const cleanup = (finished) => {
      if (visibilityAnimations.get(element) !== entry) return;
      visibilityAnimations.delete(element);
      element.style.overflow = previousOverflow;
      if (finished && !show) element.hidden = true;
      if (finished) onComplete?.();
    };
    animation.addEventListener("finish", () => cleanup(true), { once: true });
    animation.addEventListener("cancel", () => cleanup(false), { once: true });
  }

  async function waitForVisibilityTween(element) {
    const entry = element ? visibilityAnimations.get(element) : null;
    if (!entry) return;
    try {
      await entry.animation.finished;
    } catch {
      // Reversed or cancelled by a newer selection.
    }
  }

  function selectedRect(host, selector) {
    const selected = typeof selector === "function" ? selector(host) : host?.querySelector(selector);
    if (!host || !selected) return null;
    const hostRect = host.getBoundingClientRect();
    const rect = selected.getBoundingClientRect();
    return {
      left: rect.left - hostRect.left + host.scrollLeft,
      top: rect.top - hostRect.top + host.scrollTop,
      width: rect.width,
      height: rect.height
    };
  }

  function renderSelectionSlider(host, selector, fromRect, variant) {
    if (!host) return;
    host.querySelector(":scope > .selection-slider")?.remove();
    if (variant === "model") {
      selectionTargets.delete(host);
      return;
    }
    selectionTargets.set(host, { selector, variant });
    const toRect = selectedRect(host, selector);
    if (!toRect) return;

    const slider = document.createElement("span");
    slider.className = `selection-slider selection-slider--${variant}`;
    slider.setAttribute("aria-hidden", "true");
    Object.assign(slider.style, {
      left: `${toRect.left}px`,
      top: `${toRect.top}px`,
      width: `${toRect.width}px`,
      height: `${toRect.height}px`
    });
    host.appendChild(slider);

    if (
      variant === "world" ||
      !fromRect ||
      !slider.animate ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    slider.animate(
      [
        {
          left: `${fromRect.left}px`,
          top: `${fromRect.top}px`,
          width: `${fromRect.width}px`,
          height: `${fromRect.height}px`
        },
        {
          left: `${toRect.left}px`,
          top: `${toRect.top}px`,
          width: `${toRect.width}px`,
          height: `${toRect.height}px`
        }
      ],
      { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  }

  function syncSelectionSlider(host) {
    const target = selectionTargets.get(host);
    const slider = host?.querySelector(":scope > .selection-slider");
    if (!target || !slider) return;
    const rect = selectedRect(host, target.selector);
    if (!rect) return;
    Object.assign(slider.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
  }

  function syncAllSelectionSliders() {
    ["provider-picker", "model-picker", "world-picker", "reasoning-picker"].forEach((id) => {
      syncSelectionSlider(document.getElementById(id));
    });
  }

  function modelSelectionElement(host) {
    return [...(host?.querySelectorAll(".chip.is-selected") || [])].find((chip) => {
      const folder = chip.closest(".model-folder");
      return chip.offsetParent !== null && (!folder || folder.classList.contains("is-open"));
    })
      || host?.querySelector(".model-folder.has-selected .model-folder__head")
      || null;
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

  function composerSettingsReady() {
    return Boolean(
      state.provider &&
      state.modelId &&
      state.reasoningChosen &&
      (state.provider === "prime" || state.worldId)
    );
  }

  function runOptionsReady() {
    return Boolean(
      composerSettingsReady() &&
      state.mode &&
      (state.provider === "prime" || state.isolation)
    );
  }

  function moveBudget() {
    const input = document.getElementById(state.provider === "prime" ? "run-prime-turns" : "run-moves");
    return Math.max(0, Math.floor(Number(input?.value) || 0));
  }

  function runReady() {
    return runOptionsReady() && moveBudget() > 0;
  }

  function syncComposerSteps(animate = true) {
    const hasProvider = Boolean(state.provider);
    const hasModel = Boolean(state.modelId);
    const showTarget = hasProvider && hasModel && state.reasoningChosen && state.provider !== "prime";
    const showSettings = composerSettingsReady();
    const showRun = runReady();
    const visibility = [
      [document.querySelector(".composer-section--model"), hasProvider],
      [document.querySelector(".composer-section--reasoning"), hasProvider && hasModel],
      [document.getElementById("world-section"), showTarget],
      [document.querySelector(".composer-section--settings"), showSettings],
      [document.querySelector(".composer-section--run"), showRun]
    ];

    visibility.forEach(([element, show]) => {
      if (!element) return;
      if (animate) tweenVisibility(element, show, 440);
      else element.hidden = !show;
    });
  }

  // ---- provider picker ----------------------------------------------------

  function renderProviders(selectionFrom = null) {
    const host = document.getElementById("provider-picker");
    host.innerHTML = PROVIDERS.map((provider) => {
      const available = Boolean(data.environment?.[provider.envKey]);
      return `<button type="button" class="provider-card${state.provider === provider.id ? " is-selected" : ""}"
          data-provider="${provider.id}" role="radio" aria-checked="${state.provider === provider.id}">
        <span class="provider-card__logo">${provider.logo}</span>
        <span class="provider-card__name">${escapeText(provider.name)}</span>
        <span class="provider-card__avail ${available ? "is-ok" : "is-missing"}">${available ? "ACTIVE" : "INACTIVE"}</span>
      </button>`;
    }).join("");

    host.querySelectorAll(".provider-card").forEach((card) => {
      card.addEventListener("click", () => selectProvider(card.dataset.provider));
    });
    renderSelectionSlider(host, ".provider-card.is-selected", selectionFrom, "provider");
  }

  function selectProvider(providerId) {
    if (state.provider === providerId) return;
    const providerHost = document.getElementById("provider-picker");
    const providerSelectionFrom = selectedRect(providerHost, ".provider-card.is-selected");
    state.provider = providerId;
    state.modelId = null;
    state.customModel = "";
    state.modelQuery = "";
    state.worldId = null;
    state.levelId = null;
    renderWorlds(null, false);
    renderLevelSummary();
    const modelSearchInput = document.getElementById("model-search-input");
    if (modelSearchInput) modelSearchInput.value = "";
    state.reasoning = null;
    state.reasoningChosen = false;
    resetRunOptions();
    document.getElementById("run-codex-fast").checked = false;

    providerHost.querySelectorAll(".provider-card").forEach((card) => {
      const selected = card.dataset.provider === providerId;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-checked", String(selected));
    });
    renderSelectionSlider(providerHost, ".provider-card.is-selected", providerSelectionFrom, "provider");

    const isPrime = providerId === "prime";
    tweenResize(document.querySelector(".settings-stage"), () => {
      document.getElementById("local-settings").hidden = isPrime;
      document.getElementById("prime-settings").hidden = !isPrime;
    }, 440);
    tweenResize(document.querySelector(".model-browser"), () => {
      renderModels();
    }, 440);
    syncComposerSteps();
    loadModels(providerId, { fresh: !state.catalogs[providerId] });
  }

  // ---- model picker ---------------------------------------------------------

  async function loadModels(providerId, { fresh = false } = {}) {
    if (state.catalogs[providerId] && !fresh) {
      return;
    }

    const host = document.getElementById("model-picker");
    tweenResize(document.querySelector(".model-browser"), () => {
      host.innerHTML = MODELS_LOADING_MARKUP;
    });
    const refreshButton = document.getElementById("refresh-models");
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = "Refreshing…";
    }

    try {
      const suffix = fresh ? `?refresh=1&t=${Date.now()}` : "";
      const catalog = await api(`${data.modelsApiBase}/${encodeURIComponent(providerId)}${suffix}`);
      state.catalogs[providerId] = catalog;
    } catch (error) {
      state.catalogs[providerId] = { models: [], note: error.message };
    } finally {
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = "↻ Refresh";
      }
    }

    if (state.provider === providerId) {
      await waitForVisibilityTween(document.querySelector(".composer-section--model"));
      if (state.provider !== providerId) return;
      const models = state.catalogs[providerId]?.models || [];
      if (state.modelId !== "__custom__" && !models.some((model) => model.id === state.modelId)) {
        state.modelId = null;
      }
      tweenResize(document.querySelector(".model-browser"), () => {
        renderModels(null, true);
      });
    }
  }

  function selectedModel() {
    const catalog = state.catalogs[state.provider] || { models: [] };
    return catalog.models.find((model) => model.id === state.modelId) || null;
  }

  function modelPrice(pricing) {
    if (!pricing) return "";
    const money = (value) => Number(value).toFixed(3).replace(/\.?0+$/, "");
    const input = Number.isFinite(pricing.input) ? `$${money(pricing.input)}` : "";
    const output = Number.isFinite(pricing.output) ? `$${money(pricing.output)}` : "";
    return input && output ? `${input} in / ${output} out per MTok` : "";
  }

  function modelChip(model, { showGroup = false } = {}) {
    const details = modelPrice(model.pricing);
    return `<button type="button" class="chip${state.modelId === model.id ? " is-selected" : ""}"
        data-model-id="${escapeText(model.id)}" role="radio" aria-checked="${state.modelId === model.id}">
      ${showGroup && model.group ? `<span class="chip__eyebrow">${escapeText(model.group)}</span>` : ""}
      <span class="chip__topline">
        <span class="chip__label">${escapeText(model.label)}</span>
      </span>
      ${details ? `<span class="chip__sub">${escapeText(details)}</span>` : ""}
    </button>`;
  }

  function catalogTime(catalog) {
    const value = catalog.updated_at || catalog.checked_at;
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${catalog.updated_at ? "updated" : "checked"} ${date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    })}`;
  }

  function revealModelChoices(host) {
    if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const choices = [...host.querySelectorAll(
      ".model-recent .chip, .model-search-results .chip, .model-folders > .model-folder, .model-grid--primary > .chip, .model-custom-row > .chip"
    )].filter((choice) => choice.offsetParent !== null);

    choices.forEach((choice, index) => {
      choice.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ],
        {
          delay: index * 28,
          duration: 260,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards"
        }
      );
    });

    const selectedTarget = modelSelectionElement(host);
    const selectedIndex = Math.max(0, choices.findIndex((choice) => choice === selectedTarget || choice.contains(selectedTarget)));
    host.querySelector(":scope > .selection-slider")?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      {
        delay: selectedIndex * 28,
        duration: 220,
        easing: "ease-out",
        fill: "backwards"
      }
    );
  }

  function renderModels(selectionFrom = null, reveal = false) {
    const host = document.getElementById("model-picker");
    const noteEl = document.getElementById("model-note");
    const metaEl = document.getElementById("model-meta");
    const searchWrap = document.getElementById("model-search");
    const catalog = state.catalogs[state.provider];

    if (!catalog) {
      host.innerHTML = MODELS_LOADING_MARKUP;
      noteEl.hidden = true;
      metaEl.textContent = "";
      searchWrap.hidden = true;
      renderReasoning();
      return;
    }

    const showCatalogNote = Boolean(catalog.note) && !catalog.models.length;
    noteEl.textContent = showCatalogNote ? catalog.note : "";
    noteEl.hidden = !showCatalogNote;
    metaEl.textContent = [catalog.source, catalogTime(catalog)].filter(Boolean).join(" · ");

    const customChip = { id: "__custom__", label: "Custom…", description: "type any model id" };
    const grouped = catalog.models.some((model) => model.group);
    searchWrap.hidden = !grouped;

    if (grouped) {
      // Prime: recent additions stay visible up front, with provider folders for
      // the full live catalog and a search path for quickly narrowing 100+ ids.
      const groups = new Map();
      catalog.models.forEach((model) => {
        const key = model.group || "other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(model);
      });
      const selected = catalog.models.find((model) => model.id === state.modelId);
      const query = state.modelQuery.trim().toLowerCase();
      const filteredModels = query
        ? catalog.models.filter((model) => `${model.group || ""}/${model.label} ${model.id}`.toLowerCase().includes(query))
        : [];
      const recentModels = [...catalog.models]
        .filter((model) => model.created_at)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 6);
      const folderMarkup = [...groups.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([group, models]) => {
          const open = state.openFolders.has(group);
          const containsSelected = models.some((model) => model.id === state.modelId);
          const orderedModels = [...models].sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.label.localeCompare(b.label));
          return `<div class="model-folder${open ? " is-open" : ""}${containsSelected ? " has-selected" : ""}">
            <button type="button" class="model-folder__head" data-folder="${escapeText(group)}" aria-expanded="${open}">
              <span class="model-folder__glyph">›</span>
              <span class="model-folder__name">${escapeText(group)}</span>
              <span class="model-folder__count">${models.length}</span>
              ${containsSelected && !open ? `<span class="model-folder__selected">${escapeText(selected?.label || "")}</span>` : ""}
            </button>
            <div class="model-folder__reveal" aria-hidden="${!open}"${open ? "" : " inert"}>
              <div class="model-folder__clip">
                <div class="model-grid model-folder__body">${orderedModels.map((model) => modelChip(model)).join("")}</div>
              </div>
            </div>
          </div>`;
        })
        .join("");

      host.innerHTML = query
        ? `<div class="model-search-results">
            <div class="model-section-title">${filteredModels.length} match${filteredModels.length === 1 ? "" : "es"}</div>
            ${filteredModels.length ? `<div class="model-grid">${filteredModels.map((model) => modelChip(model, { showGroup: true })).join("")}</div>` : '<p class="muted model-empty">No models match that search.</p>'}
          </div>
          <div class="model-custom-row">${modelChip(customChip)}</div>`
        : `${recentModels.length ? `<div class="model-recent"><div class="model-section-title">Recently added</div><div class="model-grid">${recentModels.map((model) => modelChip(model, { showGroup: true })).join("")}</div></div>` : ""}
          <div class="model-folders">${folderMarkup}</div>
          <div class="model-custom-row">${modelChip(customChip)}</div>`;

      host.querySelectorAll(".model-folder__head").forEach((head) => {
        head.addEventListener("click", () => {
          const folder = head.closest(".model-folder");
          const reveal = folder.querySelector(".model-folder__reveal");
          const selectedLabel = head.querySelector(".model-folder__selected");
          const group = head.dataset.folder;
          const opening = !state.openFolders.has(group);
          const from = selectedRect(host, modelSelectionElement);

          head.setAttribute("aria-expanded", String(opening));

          if (opening) {
            state.openFolders.add(group);
            folder.classList.add("is-open");
            reveal.removeAttribute("inert");
            reveal.setAttribute("aria-hidden", "false");
            selectedLabel?.remove();
          } else {
            state.openFolders.delete(group);
            folder.classList.remove("is-open");
            reveal.setAttribute("inert", "");
            reveal.setAttribute("aria-hidden", "true");
            if (folder.classList.contains("has-selected") && !head.querySelector(".model-folder__selected")) {
              const label = selectedModel()?.label || "";
              head.insertAdjacentHTML("beforeend", `<span class="model-folder__selected">${escapeText(label)}</span>`);
            }
          }

          renderSelectionSlider(host, modelSelectionElement, from, "model");
          requestAnimationFrame(syncAllSelectionSliders);
        });
      });
    } else {
      host.innerHTML = `<div class="model-grid model-grid--primary">${[...catalog.models, customChip].map((model) => modelChip(model)).join("")}</div>`;
    }

    host.querySelectorAll(".chip[data-model-id]").forEach((chip) => {
      chip.addEventListener("click", () => {
        const from = selectedRect(host, modelSelectionElement);
        tweenResize(document.querySelector(".model-browser"), () => {
          state.modelId = chip.dataset.modelId;
          if (state.modelId !== "__custom__") state.customModel = "";
          state.reasoning = null;
          state.reasoningChosen = false;
          resetRunOptions();
          renderModels(from);
        });
        syncComposerSteps();
      });
    });

    const customWrap = document.getElementById("model-custom");
    customWrap.hidden = state.modelId !== "__custom__";
    if (state.modelId === "__custom__" && catalog.models.length) {
      document.getElementById("model-custom-input").focus();
    }

    renderReasoning();
    renderPrimeMode();
    renderSelectionSlider(host, modelSelectionElement, selectionFrom, "model");
    if (reveal) requestAnimationFrame(() => revealModelChoices(host));
  }

  // Both Codex and Claude Code expose reasoning effort per model. The installed
  // Claude CLI accepts five possible values, but not every Claude model supports
  // all (or any) of them, so its catalog supplies the valid subset.
  function reasoningOptions() {
    const catalog = state.catalogs[state.provider] || {};

    if (state.provider === "prime") {
      // Passed through to the eval as --sampling.reasoning-effort. OpenAI
      // reasoning models and Claude (extended thinking) honor it; models that
      // don't support reasoning simply ignore it. "" = off (no effort sent).
      return ["low", "medium", "high"];
    }

    if (state.provider === "claude") {
      const model = selectedModel();
      return model && Array.isArray(model.reasoning_levels) ? model.reasoning_levels : [];
    }

    const model = selectedModel();
    return model && Array.isArray(model.reasoning_levels) && model.reasoning_levels.length
      ? model.reasoning_levels
      : ["low", "medium", "high", "xhigh"];
  }

  function renderReasoning(selectionFrom = null) {
    const row = document.getElementById("reasoning-row");
    const host = document.getElementById("reasoning-picker");
    const fastSwitch = document.getElementById("fast-switch");

    if (!state.modelId || (state.provider !== "codex" && state.provider !== "claude" && state.provider !== "prime")) {
      row.hidden = true;
      return;
    }

    const model = selectedModel();
    const levels = reasoningOptions();
    const choices = state.provider === "prime" || (state.provider === "claude" && levels.length === 0)
      ? [{ id: "", label: "off" }, ...levels.map((level) => ({ id: level, label: level }))]
      : levels.map((level) => ({ id: level, label: level }));
    if (state.reasoning !== null && !choices.some((choice) => choice.id === state.reasoning)) {
      state.reasoning = null;
      state.reasoningChosen = false;
    }

    row.hidden = false;
    host.innerHTML = choices
      .map(
        (level) => `<button type="button" class="chip chip--small${state.reasoning === level.id ? " is-selected" : ""}"
            data-reasoning="${escapeText(level.id)}">${escapeText(level.label)}</button>`
      )
      .join("");
    host.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const from = selectedRect(host, ".chip.is-selected");
        state.reasoning = chip.dataset.reasoning;
        state.reasoningChosen = true;
        renderReasoning(from);
        syncComposerSteps();
      });
    });

    // Fast mode is a Codex-only tier; only offer it when the model supports it.
    fastSwitch.hidden = state.provider !== "codex" || (Boolean(model) && !model.fast);
    renderSelectionSlider(host, ".chip.is-selected", selectionFrom, "reasoning");
  }

  // ---- world + level pickers ------------------------------------------------

  function worldMosaic(world) {
    const urls = (world.preview_urls || []).slice(0, 4);
    if (!urls.length) {
      return '<span class="world-tile__nosignal">▦</span>';
    }
    return urls.map((url) => `<img src="${escapeText(url)}" alt="" loading="lazy">`).join("");
  }

  function renderWorlds(selectionFrom = null, syncSteps = true) {
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
        const from = selectedRect(host, ".world-tile.is-selected");
        const levelPicker = document.getElementById("level-picker");
        state.worldId = tile.dataset.worldId;
        state.levelId = null;
        renderWorlds(from);
        if (levelPicker.hidden) renderLevelSummary();
        else tweenVisibility(levelPicker, false, 440, renderLevelSummary);
      });
    });
    renderSelectionSlider(host, ".world-tile.is-selected", selectionFrom, "world");
    if (syncSteps) syncComposerSteps();
  }

  function renderLevelSummary() {
    const host = document.getElementById("level-summary");
    const world = currentWorld();

    if (!state.worldId && data.worlds.length) {
      host.innerHTML = '<span class="muted">Choose a world</span>';
      return;
    }

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
      <span class="level-summary__actions">
        <button type="button" id="level-change">${picker.hidden ? "Change…" : "Close"}</button>
        ${!isDefault ? '<button type="button" id="level-reset">Use world default</button>' : ""}
      </span>`;

    document.getElementById("level-change").addEventListener("click", () => {
      const opening = picker.hidden;
      if (opening) {
        renderLevelGrid();
        tweenVisibility(picker, true, 480);
        renderLevelSummary();
      } else {
        tweenVisibility(picker, false, 440, renderLevelSummary);
      }
    });
    document.getElementById("level-reset")?.addEventListener("click", () => {
      state.levelId = null;
      if (picker.hidden) {
        renderLevelSummary();
      } else {
        tweenVisibility(picker, false, 440, renderLevelSummary);
      }
    });
  }

  function renderLevelGrid() {
    const picker = document.getElementById("level-picker");
    const world = currentWorld();

    if (!world) return;

    const axis = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const selectedId = effectiveLevelId();
    picker.innerHTML = `<p class="muted picker-note">Pick where the agent starts. The outlined room is the world's default start from its metadata.</p>
      <div class="level-grid" style="grid-template-columns: repeat(${world.world_width}, minmax(0, 1fr))">
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
        tweenVisibility(picker, false, 440, renderLevelSummary);
      });
    });
  }

  // ---- run settings ---------------------------------------------------------

  // Text/Vision segmented control. Both the local #mode-picker and the Prime
  // #prime-mode-picker drive the same state.mode, so selecting in one syncs the
  // visual state of both.
  function syncRunSettingCards() {
    const localSettings = document.getElementById("local-settings");
    const primeSettings = document.getElementById("prime-settings");
    const hasObservation = Boolean(state.mode);
    const hasAccess = Boolean(state.isolation);

    const setCardVisibility = (card, show) => {
      if (!card) return;
      card.classList.toggle("is-gated", !show);
      card.toggleAttribute("inert", !show);
      card.setAttribute("aria-hidden", String(!show));
    };

    setCardVisibility(localSettings?.querySelector(".setting-card--access"), hasObservation);
    setCardVisibility(localSettings?.querySelector(".setting-card--budget"), hasObservation && hasAccess);
    setCardVisibility(primeSettings?.querySelector(".setting-card--budget"), hasObservation);
  }

  function setMode(mode, syncSteps = true) {
    state.mode = mode;
    document.querySelectorAll(".segmented__option[data-mode]").forEach((option) => {
      const selected = option.dataset.mode === mode;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    document.querySelectorAll("#mode-picker, #prime-mode-picker").forEach((picker) => {
      picker.classList.toggle("has-selection", Boolean(mode));
      picker.classList.toggle("is-second", mode === "vision");
    });
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
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

    // An invalidated Vision choice must be selected again instead of silently
    // falling back to Text.
    if (!canVision && state.mode === "vision") state.mode = null;
    setMode(state.mode, false);

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
  function setIsolation(value, syncSteps = true) {
    state.isolation = value === "full" || value === "docker" ? value : null;
    document.querySelectorAll(".segmented__option[data-isolation]").forEach((option) => {
      const selected = option.dataset.isolation === state.isolation;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-pressed", String(selected));
    });
    const picker = document.getElementById("isolation-picker");
    picker?.classList.toggle("has-selection", Boolean(state.isolation));
    picker?.classList.toggle("is-second", state.isolation === "full");
    syncRunSettingCards();
    if (syncSteps) syncComposerSteps();
  }

  function resetRunOptions() {
    ["run-moves", "run-prime-turns"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "0";
    });
    setMode(null, false);
    setIsolation(null, false);
  }

  // Docker mode needs Docker installed AND its daemon running. When it isn't,
  // disable that option and clear it so access must be chosen again.
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
      if (state.isolation === "docker") setIsolation(null);
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

    const environmentEl = document.getElementById("agent-environment");
    environmentEl.classList.toggle("is-ready", missing.length === 0);
    environmentEl.classList.toggle("is-warning", missing.length > 0);
    environmentEl.textContent = missing.length
      ? `Needs attention: ${missing.join(", ")}. ${!env.docker ? "Full access remains available." : ""}`
      : `System ready · ${found.join(" · ")}`;
  }

  // ---- launch ---------------------------------------------------------------

  function resolvedModelName() {
    if (state.modelId === "__custom__") {
      return (document.getElementById("model-custom-input").value || "").trim();
    }
    return state.modelId || "";
  }

  document.getElementById("launch-run")?.addEventListener("click", async () => {
    if (!runReady()) return;
    if (state.modelId === "__custom__" && !resolvedModelName() && (state.catalogs[state.provider]?.models || []).length) {
      setStatus("Type a model id or pick one from the list.", true);
      return;
    }

    const body =
      state.provider === "prime"
        ? {
            kind: "prime",
            model_name: resolvedModelName(),
            max_turns: moveBudget(),
            vision: state.mode === "vision",
            reasoning: state.reasoning,
            video: false
          }
        : {
            kind: "local",
            model: state.provider,
            game_id: state.worldId,
            level_id: effectiveLevelId(),
            moves: moveBudget(),
            mode: state.mode,
            vision_view: "",
            model_name: resolvedModelName(),
            reasoning: state.provider === "codex" || state.provider === "claude" ? state.reasoning : "",
            codex_fast: state.provider === "codex" && document.getElementById("run-codex-fast").checked,
            container: state.isolation === "docker",
            video: false,
            tools: state.isolation === "full"
          };

    body.count = 1;

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

  const runsView = { page: 1, pageSize: 5, provider: "", model: "", status: "", query: "", sort: "newest" };
  const runProgressCache = new Map();

  function formatRunDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }

  function runProgressLabel(run) {
    if (run.status === "waiting") return "Waiting";
    const eta = Number(run.progress?.eta_ms);
    if (run.status === "finished") return "Complete";
    if (run.status === "paused") return "Paused";
    if (run.status === "stopping") return "Stopping…";
    if (run.status === "stopped") return "Stopped";
    if (run.status === "failed") return "Failed";
    if (Number.isFinite(eta) && Number(run.progress?.current) > 0) {
      return eta <= 0 ? "Finishing…" : `~${formatRunDuration(eta)} left`;
    }
    return "Estimating…";
  }

  function runStatusClass(status) {
    if (status === "running" || status === "stopping") return "agent-chip--running";
    if (status === "waiting" || status === "paused") return "agent-chip--paused";
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
    const modelName = run.model_name || run.model;
    const providerName = {
      codex: "Codex",
      claude: "Claude Code",
      prime: "Prime Intellect"
    }[run.provider || run.model] || run.model;
    const reasoningEffort = String(run.reasoning || (run.provider === "prime" ? "off" : "auto")).toLowerCase();
    const showStartRoom = Boolean(run.level_id) && !run.start_room_is_default;
    const createdAt = escapeText(run.created_at ? new Date(run.created_at).toLocaleString() : "");
    const continuation = run.continued
      ? ` · continued ×${run.continued}`
      : run.continue_of
        ? " · continued"
        : "";
    const progress = run.progress || {};
    const progressCurrent = Number(progress.current) || 0;
    const progressTotal = Math.max(1, Number(progress.total) || Number(run.moves) || 1);
    const progressTarget = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const progressFrom = runProgressCache.get(run.id) ?? 0;
    const showProgress = progressTarget < 100;
    if (!showProgress) runProgressCache.delete(run.id);

    const actions = [
      run.pausable ? '<button class="button" type="button" data-action="pause">Pause</button>' : "",
      run.resumable ? '<button class="button--primary" type="button" data-action="resume">Resume</button>' : "",
      run.continuable ? '<button class="button" type="button" data-action="continue">Continue</button>' : "",
      run.status === "running" || run.status === "stopping" || (run.status === "paused" && run.pause_reason === "manual")
        ? `<button class="button--coral" type="button" data-action="stop">${run.provider === "prime" ? "Cancel" : "Stop"}</button>`
        : "",
      '<button class="button--ghost run-trash" type="button" data-action="delete" title="Delete run" aria-label="Delete run">Delete</button>'
    ]
      .filter(Boolean)
      .join("");

    return `<article class="agent-run-card" data-run-id="${escapeText(run.id)}" data-provider="${escapeText(run.model)}">
      <a class="run-card__open" href="${escapeText(run.url)}" aria-label="Open ${escapeText(modelName)} run"></a>
      <div class="run-card__status">
        <span class="agent-chip ${runStatusClass(run.status)}">${escapeText(statusLabel)}</span>
        <span>${createdAt}${continuation}</span>
      </div>
      <div class="run-card__main">
        <div class="run-card__identity">
          <span class="run-card__provider">${escapeText(providerName)}</span>
          <h3 title="${escapeText(modelName)}">${escapeText(modelName)}</h3>
          <div class="run-card__details">
            <span class="run-card__world">${escapeText(run.game_title || run.game_id)}</span>
            ${showStartRoom ? `<span class="run-card__badge">Start ${escapeText(levelLabel(run.level_id))}</span>` : ""}
            <span class="run-card__badge run-card__badge--reasoning">${escapeText(reasoningEffort)} reasoning</span>
          </div>
        </div>
        <div class="run-card__metrics" aria-label="Run results">
          <div class="run-metric run-metric--moves">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.moves}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.turns)}<em>/ ${escapeText(run.moves)}</em></strong><small>Moves</small></span>
          </div>
          <div class="run-metric run-metric--gems">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.gems}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.gem_count ?? 0)}<em>/ ${escapeText(run.gem_total ?? "—")}</em></strong><small>Gems</small></span>
          </div>
          <div class="run-metric run-metric--rooms">
            <span class="run-metric__icon" aria-hidden="true">${RUN_METRIC_ICONS.rooms}</span>
            <span class="run-metric__copy"><strong>${escapeText(run.room_count ?? 0)}<em>/ ${escapeText(run.room_total ?? "—")}</em></strong><small>Rooms</small></span>
          </div>
        </div>
        <div class="run-card__actions">${actions}</div>
      </div>
      ${showProgress ? `<div class="run-card__progress">
        <div class="run-card__progress-copy"><span>${escapeText(progressCurrent)} / ${escapeText(progressTotal)} moves</span><strong>${escapeText(runProgressLabel(run))}</strong></div>
        <div class="run-card__progress-track" role="progressbar" aria-label="Run progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressTarget)}">
          <span class="run-card__progress-fill${run.status === "paused" ? " is-paused" : ""}" data-progress-target="${progressTarget}" style="width:${progressFrom}%"></span>
        </div>
      </div>` : ""}
    </article>`;
  }

  function runsQuery() {
    const params = new URLSearchParams({
      page: String(runsView.page),
      page_size: String(runsView.pageSize),
      sort: runsView.sort
    });
    if (runsView.provider) params.set("provider", runsView.provider);
    if (runsView.model) params.set("model", runsView.model);
    if (runsView.status) params.set("status", runsView.status);
    if (runsView.query) params.set("q", runsView.query);
    return params.toString();
  }

  function syncFilterSelect(id, values, current, allLabel, format = (value) => value) {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = [`<option value="">${allLabel}</option>`]
      .concat(values.map((value) => `<option value="${escapeText(value)}">${escapeText(format(value))}</option>`))
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
      syncFilterSelect(
        "runs-provider",
        payload.providers || [],
        runsView.provider,
        "All",
        (value) => RUN_COMPANY_NAMES[value] || value
      );
      syncFilterSelect("runs-model", payload.models || [], runsView.model, "All");
      syncFilterSelect(
        "runs-status",
        payload.statuses || [],
        runsView.status,
        "All",
        (value) => RUN_STATUS_LABELS[value] || value
      );

      tweenResize(runsEl, () => {
        runsEl.innerHTML = runs.length
          ? runs.map(runCard).join("")
          : total
            ? '<div class="empty-state"><span class="glyph">▤</span><p>No matching runs.</p></div>'
            : '<div class="empty-state"><span class="glyph">▶</span><p>No runs yet.</p></div>';
        wireRunActions();
      });
      requestAnimationFrame(() => {
        runsEl.querySelectorAll(".run-card__progress-fill").forEach((bar) => {
          const card = bar.closest("[data-run-id]");
          const target = Number(bar.dataset.progressTarget) || 0;
          bar.style.width = `${target}%`;
          if (card) runProgressCache.set(card.dataset.runId, target);
        });
      });

      const pages = payload.pages || 1;
      const pager = document.getElementById("runs-pager");
      pager.hidden = pages <= 1;
      document.getElementById("runs-page-label").textContent = `Page ${payload.page || 1} of ${pages}`;
      document.getElementById("runs-prev").disabled = (payload.page || 1) <= 1;
      document.getElementById("runs-next").disabled = (payload.page || 1) >= pages;

      const active = payload.active || runs.some((run) => ["waiting", "running", "stopping"].includes(run.status));
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
    onFilter("runs-status", "status");
    onFilter("runs-sort", "sort");
    onFilter("runs-page-size", "pageSize", (value) => Number(value) || 5);

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

  function wireModelCatalog() {
    document.getElementById("refresh-models")?.addEventListener("click", () => {
      loadModels(state.provider, { fresh: true });
    });

    document.getElementById("model-search-input")?.addEventListener("input", (event) => {
      const host = document.getElementById("model-picker");
      const from = selectedRect(host, modelSelectionElement);
      tweenResize(document.querySelector(".model-browser"), () => {
        state.modelQuery = event.target.value;
        renderModels(from);
      });
    });
  }

  function wireConfigurationSummary() {
    ["run-moves", "run-prime-turns"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", () => {
        syncComposerSteps();
      });
    });
  }

  function wireSelectionResize() {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncAllSelectionSliders);
    };

    window.addEventListener("resize", schedule, { passive: true });
    if (!("ResizeObserver" in window)) return;

    const observer = new ResizeObserver(schedule);
    ["provider-picker", "model-picker", "world-picker", "reasoning-picker"].forEach((id) => {
      const host = document.getElementById(id);
      if (host) observer.observe(host);
    });
  }

  // ---- boot -----------------------------------------------------------------

  renderProviders();
  renderWorlds();
  renderLevelSummary();
  document.querySelectorAll(".segmented__option[data-isolation]").forEach((option) => {
    option.addEventListener("click", () => {
      if (option.disabled) return;
      setIsolation(option.dataset.isolation);
    });
  });
  syncIsolationPicker();
  syncRunSettingCards();
  describeEnvironment();
  wireModelCatalog();
  wireConfigurationSummary();
  wireSelectionResize();
  wireRunsToolbar();
  refreshRuns();
  syncComposerSteps(false);
})();
