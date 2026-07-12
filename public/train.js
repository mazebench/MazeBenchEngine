(() => {
  const data = window.__TRAIN_DATA__ || {};
  const statusEl = document.getElementById("train-status");
  const readinessEl = document.getElementById("train-readiness");
  const launchButton = document.getElementById("launch-training");
  const state = {
    model: "",
    observationMode: "",
    readiness: null,
    defaults: null
  };

  function escapeText(value) {
    const element = document.createElement("span");
    element.textContent = String(value ?? "");
    return element.innerHTML;
  }

  function setStatus(message, error = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(error));
  }

  async function api(url, options) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  }

  function reveal(element, delay = 0) {
    if (!element || !element.hidden) return;
    window.setTimeout(() => {
      element.hidden = false;
      const height = element.getBoundingClientRect().height;
      if (!element.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      element.animate(
        [{ height: "0px", opacity: 0, transform: "translateY(8px)" }, { height: `${height}px`, opacity: 1, transform: "translateY(0)" }],
        { duration: 440, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
    }, delay);
  }

  function priceLabel(model) {
    const value = Number(model.training_price_per_mtok);
    if (!Number.isFinite(value)) return "";
    return value === 0 ? "FREE" : `$${value.toFixed(value < 0.1 ? 2 : 1)} / MTOK`;
  }

  function renderModels(models) {
    const loading = document.getElementById("train-model-loading");
    const picker = document.getElementById("train-model-picker");
    loading.hidden = true;
    picker.hidden = false;
    picker.innerHTML = models
      .map((model, index) => {
        const [company, ...nameParts] = String(model.id).split("/");
        const name = nameParts.join("/") || company;
        return `<button type="button" class="train-model-card" data-model="${escapeText(model.id)}" role="radio" aria-checked="false"${model.at_capacity ? " disabled" : ""} style="--model-index:${index}">
          <span class="train-model-card__company">${escapeText(company)}</span>
          <strong>${escapeText(name)}</strong>
          <span class="train-model-card__meta">${model.at_capacity ? "AT CAPACITY" : escapeText(priceLabel(model))}</span>
        </button>`;
      })
      .join("");

    picker.querySelectorAll(".train-model-card").forEach((card, index) => {
      card.animate?.(
        [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 240, delay: Math.min(index * 28, 280), easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }
      );
      card.addEventListener("click", () => selectModel(card.dataset.model));
    });
  }

  function selectModel(model) {
    state.model = model;
    document.querySelectorAll(".train-model-card").forEach((card) => {
      const selected = card.dataset.model === model;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-checked", String(selected));
    });
    document.getElementById("train-launch-model").textContent = model;
    reveal(document.getElementById("train-observation-section"));
    syncLaunch();
  }

  function selectObservation(mode) {
    state.observationMode = mode;
    const picker = document.getElementById("train-observation-picker");
    picker.classList.add("has-selection");
    picker.classList.toggle("is-second", mode === "vision");
    picker.querySelectorAll("[data-observation]").forEach((button) => {
      const selected = button.dataset.observation === mode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    reveal(document.getElementById("train-rewards-section"));
    reveal(document.getElementById("train-rollout-section"), 80);
    reveal(document.getElementById("train-settings-section"), 160);
    reveal(document.getElementById("train-launch-section"), 240);
    syncLaunch();
  }

  document.querySelectorAll("[data-observation]").forEach((button) => {
    button.addEventListener("click", () => selectObservation(button.dataset.observation));
  });

  function setInput(id, value) {
    const input = document.getElementById(id);
    if (input) input.value = value;
  }

  function applyDefaults(defaults) {
    state.defaults = defaults;
    setInput("train-reward-gems", defaults.gem_reward_weight);
    setInput("train-reward-rooms", defaults.room_reward_weight);
    setInput("train-reward-blocks", defaults.push_reward_weight);
    setInput("train-max-actions", defaults.max_actions);
    setInput("train-rollouts", defaults.rollouts_per_example);
    setInput("train-max-tokens", defaults.max_tokens);
    setInput("train-max-steps", defaults.max_steps);
    setInput("train-batch-size", defaults.batch_size);
    setInput("train-temperature", defaults.temperature);
  }

  function syncReadiness(readiness) {
    state.readiness = readiness;
    readinessEl.textContent = readiness.ready ? "PRIME READY" : "SETUP NEEDED";
    readinessEl.classList.toggle("is-ready", readiness.ready);
    readinessEl.classList.toggle("is-blocked", !readiness.ready);
    readinessEl.title = readiness.issue || readiness.environment_id || "";
    if (!readiness.ready && readiness.issue) setStatus(readiness.issue, true);
    syncLaunch();
  }

  function syncLaunch() {
    launchButton.disabled = !(state.model && state.observationMode && state.readiness?.ready);
  }

  function numericValue(id) {
    return Number(document.getElementById(id)?.value);
  }

  function launchPayload() {
    return {
      name: `MazeBench · ${state.model.split("/").pop()}`,
      model: state.model,
      observation_mode: state.observationMode,
      gem_reward_weight: numericValue("train-reward-gems"),
      room_reward_weight: numericValue("train-reward-rooms"),
      push_reward_weight: numericValue("train-reward-blocks"),
      max_actions: numericValue("train-max-actions"),
      rollouts_per_example: numericValue("train-rollouts"),
      max_tokens: numericValue("train-max-tokens"),
      max_steps: numericValue("train-max-steps"),
      batch_size: numericValue("train-batch-size"),
      temperature: numericValue("train-temperature"),
      start_level_id: data.environment?.default_level_id
    };
  }

  function formatDate(value) {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  }

  function renderRuns(runs) {
    const host = document.getElementById("training-runs");
    if (!runs.length) {
      host.innerHTML = '<div class="train-runs-empty">No training runs yet.</div>';
      return;
    }
    host.innerHTML = runs
      .map((run) => {
        const id = run.id || run.run_id || "";
        const model = run.base_model || run.model || run.model_name || "Model";
        const status = String(run.status || "pending").toLowerCase();
        const href = run.url || `https://app.primeintellect.ai/dashboard/training/${encodeURIComponent(id)}`;
        return `<a class="training-run-card" href="${escapeText(href)}" target="_blank" rel="noreferrer">
          <span class="training-run-card__status is-${escapeText(status)}">${escapeText(status)}</span>
          <span class="training-run-card__identity"><strong>${escapeText(run.name || model)}</strong><small>${escapeText(model)}</small></span>
          <span class="training-run-card__steps"><strong>${escapeText(run.max_steps ?? "—")}</strong><small>steps</small></span>
          <time>${escapeText(formatDate(run.created_at))}</time>
        </a>`;
      })
      .join("");
  }

  async function loadRuns() {
    const host = document.getElementById("training-runs");
    host.innerHTML = '<div class="train-runs-empty">Loading…</div>';
    try {
      const payload = await api(data.runsUrl);
      renderRuns(payload.runs || []);
    } catch (error) {
      host.innerHTML = `<div class="train-runs-empty is-error">${escapeText(error.message)}</div>`;
    }
  }

  document.getElementById("refresh-training-runs")?.addEventListener("click", loadRuns);

  launchButton?.addEventListener("click", async () => {
    if (launchButton.disabled) return;
    launchButton.disabled = true;
    launchButton.classList.add("is-launching");
    setStatus("Creating Hosted Training run…");
    try {
      const payload = await api(data.runsUrl, { method: "POST", body: JSON.stringify(launchPayload()) });
      const runId = payload.run?.id || payload.run?.run_id || "";
      setStatus(runId ? `Training run ${runId} created.` : "Training run created.");
      await loadRuns();
      if (runId) window.open(`https://app.primeintellect.ai/dashboard/training/${encodeURIComponent(runId)}`, "_blank", "noopener");
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      launchButton.classList.remove("is-launching");
      syncLaunch();
    }
  });

  async function initialize() {
    // Training history is independent of model/readiness discovery. Start it
    // immediately so a slow Prime model probe never leaves the whole page
    // looking stalled.
    loadRuns();
    try {
      const payload = await api(data.bootstrapUrl);
      applyDefaults(payload.defaults || {});
      renderModels(payload.models || []);
      syncReadiness(payload.readiness || {});
    } catch (error) {
      document.getElementById("train-model-loading").innerHTML = `<span>${escapeText(error.message)}</span>`;
      setStatus(error.message, true);
    }
  }

  initialize();
})();
