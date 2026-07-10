(() => {
  const initial = window.__AGENT_RUN__ || {};
  const runId = initial.id;
  const isVision = initial.mode === "vision";
  // Hosted Prime evaluations expose lifecycle state immediately and the scored
  // sample at completion, so skip the local-only frame renderer while active.
  const isPrime = initial.kind === "prime" || initial.model === "prime";
  const statusEl = document.getElementById("run-status");
  const boardEl = document.getElementById("run-board");
  const boardWrap = document.getElementById("run-board-wrap");
  const feedEl = document.getElementById("run-feed");
  const logEl = document.getElementById("run-log");
  const stopButton = document.getElementById("stop-run");
  const primeEvaluationLink = document.getElementById("open-prime-evaluation");
  const pauseButton = document.getElementById("pause-run");
  const resumeButton = document.getElementById("resume-run");
  const continueButton = document.getElementById("continue-run");
  const generateVideoButton = document.getElementById("generate-video");
  const deleteButton = document.getElementById("delete-run");
  const liveImage = document.getElementById("run-live-image");
  const livePlaceholder = document.getElementById("run-live-placeholder");
  const liveGrid = document.getElementById("run-live-grid");
  const mainReplayControls = document.getElementById("run-main-replay-controls");
  const tokenChart = document.getElementById("run-token-chart");
  const tokenEmpty = document.getElementById("run-token-empty");
  const tokenBadge = document.getElementById("run-token-badge");
  const tokenNote = document.getElementById("run-token-note");
  const swarmSection = document.getElementById("run-swarm-section");
  const swarmGrid = document.getElementById("run-swarm-grid");
  const swarmCount = document.getElementById("run-swarm-count");
  const finishedAgents = document.getElementById("run-finished-agents");
  const finishedGrid = document.getElementById("run-finished-grid");
  const finishedCount = document.getElementById("run-finished-count");

  if (isPrime && stopButton) stopButton.textContent = "Cancel Run";

  const state = {
    afterTurn: 0,
    logOffset: 0,
    run: initial,
    timer: null,
    moves: new Map(), // move# -> { action, room, gems, flags, timestamp }
    reasoning: new Map(), // move# -> reasoning text
    agentCounts: new Map(), // move# -> agents active when the move was made
    tokenCounts: new Map(), // move# -> lead + worker tokens attributed to the move
    swarmAgents: { running: 0, ran: 0 },
    instanceActivity: { active: 0, instances: 0, auxiliary_actions: 0, auxiliary_action_attempts: 0 },
    expandedInstance: "",
    instanceViews: [],
    replayCursors: new Map(),
    replayObservations: new Map(),
    replayRequests: new Map(),
    replayRates: new Map(),
    activeReplay: "primary",
    playingView: "",
    playbackTimer: null,
    playbackTick: null,
    mainControlSignature: "",
    keyboardStepAt: 0,
    suppressCardToggleView: "",
    suppressCardToggleUntil: 0,
    // -1 makes move 0 a real render target instead of waiting for move 1.
    lastRenderedTurn: -1,
    lastImageUrl: null,
    frameRendering: false,
    frameFailures: 0,
    videoShown: false,
    tokenSignature: "",
    swarmSignature: "",
    contextPoints: [],
    feedVersion: 0,
    renderedFeedVersion: -1
  };

  function setStatus(message, isError = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function escapeText(value) {
    const el = document.createElement("span");
    el.textContent = String(value ?? "");
    return el.innerHTML;
  }

  const levelLabel = (id) => String(id || "").replace(/^level_/, "");

  // Chevrons, Play, and Pause from Lucide Icons (ISC License).
  // https://lucide.dev/
  const REPLAY_ICONS = {
    first: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 17-5-5 5-5"></path><path d="m18 17-5-5 5-5"></path></svg>',
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="14" y="3" width="5" height="18" rx="1"></rect><rect x="5" y="3" width="5" height="18" rx="1"></rect></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>',
    last: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 17 5-5-5-5"></path><path d="m13 17 5-5-5-5"></path></svg>'
  };

  function replayTotal(viewId) {
    if (viewId === "primary") return Math.max(0, Number(state.afterTurn) || 0);
    const view = state.instanceViews.find((entry) => entry.id === viewId);
    return Math.max(0, Number(view?.auxiliary_actions) || 0);
  }

  function replayTurn(viewId) {
    return state.replayCursors.has(viewId)
      ? Math.max(0, Number(state.replayCursors.get(viewId)) || 0)
      : replayTotal(viewId);
  }

  function replayRate(viewId) {
    const rate = Number(state.replayRates.get(viewId));
    return [1, 2, 5, 10, 20].includes(rate) ? rate : 10;
  }

  function replayDelay(viewId) {
    return Math.max(50, Math.round(1000 / replayRate(viewId)));
  }

  function replayControlsMarkup(viewId) {
    const total = replayTotal(viewId);
    const turn = Math.min(total, replayTurn(viewId));
    const playing = state.playingView === viewId;
    const rate = replayRate(viewId);
    const followingLatest = !state.replayCursors.has(viewId) && turn >= total;
    const active = state.activeReplay === viewId ? " is-active" : "";
    const button = (action, icon, label, disabled = false, extra = "") =>
      `<button type="button" class="replay-control${extra}" data-replay-view="${escapeText(viewId)}" data-replay-action="${action}" aria-label="${label}" title="${label}"${disabled ? " disabled" : ""}>${icon}</button>`;
    return `<div class="replay-controls__buttons${active}" role="group" aria-label="Observation playback">
      ${button("first", REPLAY_ICONS.first, "First observation", turn <= 0)}
      ${button("previous", REPLAY_ICONS.previous, "Previous observation", turn <= 0)}
      ${button("play", playing ? REPLAY_ICONS.pause : REPLAY_ICONS.play, playing ? "Pause playback" : `Play at ${rate} action${rate === 1 ? "" : "s"} per second`, total <= 0, " replay-control--play")}
      ${button("next", REPLAY_ICONS.next, "Next observation", turn >= total)}
      ${button("last", REPLAY_ICONS.last, "Latest observation", followingLatest)}
      <label class="replay-rate" title="Playback speed">
        <span class="sr-only">Actions per second</span>
        <select data-replay-rate data-replay-view="${escapeText(viewId)}" aria-label="Actions per second">
          ${[1, 2, 5, 10, 20].map((option) => `<option value="${option}"${option === rate ? " selected" : ""}>${option}/s</option>`).join("")}
        </select>
      </label>
      <span class="replay-controls__position" aria-live="polite">${turn} / ${total}</span>
    </div>`;
  }

  function refreshReplayControls(viewId) {
    if (viewId === "primary") {
      renderMainReplayControls();
      return;
    }
    state.swarmSignature = "";
    renderSwarmViews(state.instanceViews);
  }

  function stopPlayback() {
    if (state.playbackTimer) clearTimeout(state.playbackTimer);
    state.playbackTimer = null;
    state.playbackTick = null;
    const previous = state.playingView;
    state.playingView = "";
    if (previous) refreshReplayControls(previous);
  }

  async function setReplayTurn(viewId, requestedTurn) {
    const total = replayTotal(viewId);
    const turn = Math.max(0, Math.min(total, Math.floor(Number(requestedTurn) || 0)));
    state.replayCursors.set(viewId, turn);

    const requestId = (state.replayRequests.get(viewId) || 0) + 1;
    state.replayRequests.set(viewId, requestId);
    try {
      const params = new URLSearchParams({ instance: viewId, turn: String(turn) });
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/observation?${params}`);
      if (!response.ok) return null;
      const observation = await response.json();
      if (state.replayRequests.get(viewId) !== requestId) return null;
      state.replayObservations.set(viewId, observation);
      if (viewId === "primary") applyMainObservation(observation);
      refreshReplayControls(viewId);
      return observation;
    } catch (_error) {
      return null;
    }
  }

  async function goToLatestObservation(viewId) {
    const observation = await setReplayTurn(viewId, replayTotal(viewId));
    state.replayCursors.delete(viewId);
    if (viewId !== "primary") state.replayObservations.delete(viewId);
    if (viewId === "primary" && observation?.mode === "text" && !observation.frame_url) {
      liveGrid?.classList.add("is-text-history");
    }
    refreshReplayControls(viewId);
  }

  async function startPlayback(viewId) {
    if (state.playingView === viewId) {
      stopPlayback();
      return;
    }
    stopPlayback();
    state.activeReplay = viewId;
    state.playingView = viewId;
    if (replayTurn(viewId) >= replayTotal(viewId)) await setReplayTurn(viewId, 0);
    if (state.playingView !== viewId) return;
    refreshReplayControls(viewId);

    const tick = async () => {
      if (state.playingView !== viewId) return;
      const total = replayTotal(viewId);
      const current = replayTurn(viewId);
      if (current >= total) {
        stopPlayback();
        return;
      }
      await setReplayTurn(viewId, current + 1);
      if (state.playingView === viewId) state.playbackTimer = setTimeout(tick, replayDelay(viewId));
    };
    state.playbackTick = tick;
    state.playbackTimer = setTimeout(tick, replayDelay(viewId));
  }

  function handleReplayAction(viewId, action) {
    const previousActive = state.activeReplay;
    state.activeReplay = viewId;
    if (previousActive === "primary" && viewId !== "primary") renderMainReplayControls();
    if (action !== "play") stopPlayback();
    const current = replayTurn(viewId);
    if (action === "first") void setReplayTurn(viewId, 0);
    else if (action === "previous") void setReplayTurn(viewId, current - 1);
    else if (action === "play") void startPlayback(viewId);
    else if (action === "next") void setReplayTurn(viewId, current + 1);
    else if (action === "last") void goToLatestObservation(viewId);
    refreshReplayControls(viewId);
  }

  function wireReplayControls(container, { immediate = false } = {}) {
    container?.querySelectorAll("[data-replay-action]").forEach((control) => {
      const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const viewId = control.dataset.replayView || "primary";
        if (immediate && event.type === "pointerdown") {
          state.suppressCardToggleView = viewId;
          state.suppressCardToggleUntil = Date.now() + 750;
        }
        handleReplayAction(viewId, control.dataset.replayAction || "");
      };
      if (immediate) {
        control.addEventListener("pointerdown", activate);
        control.addEventListener("click", (event) => {
          // Pointer activation already ran on pointerdown. Preserve keyboard clicks.
          if (event.detail === 0) activate(event);
          else {
            event.preventDefault();
            event.stopPropagation();
          }
        });
      } else {
        control.addEventListener("click", activate);
      }
    });
    container?.querySelectorAll("[data-replay-rate]").forEach((control) => {
      control.addEventListener("pointerdown", (event) => event.stopPropagation());
      control.addEventListener("click", (event) => event.stopPropagation());
      control.addEventListener("change", (event) => {
        event.stopPropagation();
        const viewId = control.dataset.replayView || "primary";
        const rate = Number(control.value);
        if (![1, 2, 5, 10, 20].includes(rate)) return;
        state.replayRates.set(viewId, rate);
        if (state.playingView === viewId && state.playbackTick) {
          if (state.playbackTimer) clearTimeout(state.playbackTimer);
          state.playbackTimer = setTimeout(state.playbackTick, replayDelay(viewId));
        }
        refreshReplayControls(viewId);
      });
    });
  }

  function renderMainReplayControls() {
    if (!mainReplayControls) return;
    const markup = replayControlsMarkup("primary");
    if (markup === state.mainControlSignature) return;
    state.mainControlSignature = markup;
    mainReplayControls.innerHTML = markup;
    wireReplayControls(mainReplayControls);
  }

  function instanceCards(workers) {
    return workers.map((worker) => {
      const history = state.replayCursors.has(worker.id) ? state.replayObservations.get(worker.id) : null;
      const displayed = history
        ? {
            ...worker,
            board: history.board,
            frame_url: history.frame_url,
            gem_count: history.gem_count,
            player: history.player,
            room: history.current_room,
            observation_mode: history.mode,
            last_action: history.command_text
          }
        : worker;
      const player = displayed.player ? `@ ${displayed.player.x},${displayed.player.y}` : "no player";
      const frame = displayed.frame_url
        ? `<img class="run-swarm-card__image" src="${escapeText(displayed.frame_url)}" alt="${escapeText(worker.id)} exact observation">`
        : displayed.observation_mode === "vision"
          ? `<div class="run-swarm-card__waiting">Waiting for vision frame…</div>`
          : `<pre class="run-swarm-card__text" aria-label="${escapeText(worker.id)} exact text observation">${escapeText(displayed.board || "Waiting for observation…")}</pre>`;
      const owner = worker.owner_kind === "tool" ? "tool branch" : "subagent";
      const attempts = Math.max(0, Number(worker.auxiliary_action_attempts) || 0);
      const applied = Math.max(0, Number(worker.auxiliary_actions) || 0);
      const attemptLabel = attempts === applied ? `${applied} actions` : `${applied}/${attempts} applied`;
      const parent = worker.parent_instance_id === "primary" ? `forked at primary ${worker.inherited_action_count || 0}` : `forked from ${worker.parent_instance_id}`;
      const isExpanded = state.expandedInstance === worker.id;
      const expanded = isExpanded ? " is-expanded" : "";
      return `<article class="run-swarm-card${expanded}" data-instance-id="${escapeText(worker.id)}" role="button" tabindex="0" aria-expanded="${expanded ? "true" : "false"}">
        <div class="run-swarm-card__screen">
          ${frame}
          <span class="run-swarm-card__activity is-${escapeText(worker.activity.replaceAll(" ", "-"))}"><i></i>${escapeText(worker.activity)}</span>
          <span class="run-swarm-card__mode">${escapeText(displayed.observation_mode || (displayed.frame_url ? "vision" : "text"))}</span>
        </div>
        ${isExpanded ? `<div class="replay-controls replay-controls--instance">${replayControlsMarkup(worker.id)}</div>` : ""}
        <div class="run-swarm-card__copy">
          <strong>${escapeText(worker.label || worker.id.replaceAll("_", " "))}</strong>
          <span>${escapeText(owner)} · ${escapeText(levelLabel(displayed.room))} · ${escapeText(player)}</span>
          <small>${escapeText(attemptLabel)} · ${escapeText(displayed.gem_count)} gems</small>
          <small>${escapeText(parent)}${displayed.last_action ? ` · last: ${escapeText(displayed.last_action)}` : ""}</small>
        </div>
      </article>`;
    }).join("");
  }

  function wireInstanceCards(container, workers) {
    wireReplayControls(container, { immediate: true });
    container.querySelectorAll(".run-swarm-card").forEach((card) => {
      const toggle = () => {
        const id = card.dataset.instanceId || "";
        const previousActive = state.activeReplay;
        state.activeReplay = id;
        if (previousActive === "primary") renderMainReplayControls();
        state.expandedInstance = state.expandedInstance === id ? "" : id;
        state.swarmSignature = "";
        renderSwarmViews(workers);
      };
      card.addEventListener("click", (event) => {
        if (event.target.closest(".replay-controls")) return;
        const suppressToggle = state.suppressCardToggleView === card.dataset.instanceId
          && Date.now() <= state.suppressCardToggleUntil;
        if (suppressToggle) {
          state.suppressCardToggleView = "";
          state.suppressCardToggleUntil = 0;
          return;
        }
        toggle();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  function renderSwarmViews(views) {
    if (!swarmSection || !swarmGrid || !swarmCount || !finishedAgents || !finishedGrid || !finishedCount) return;
    const workers = Array.isArray(views) ? views : [];
    state.instanceViews = workers;
    const signature = JSON.stringify(workers);
    if (signature === state.swarmSignature) return;
    state.swarmSignature = signature;
    swarmSection.hidden = workers.length === 0;
    if (!workers.length) return;

    const activeWorkers = workers.filter((worker) => worker.activity !== "finished");
    const finishedWorkers = workers.filter((worker) => worker.activity === "finished");
    const exploring = activeWorkers.filter((worker) => ["acting", "exploring"].includes(worker.activity)).length;
    const totalActions = workers.reduce((sum, worker) => sum + Math.max(0, Number(worker.auxiliary_actions) || 0), 0);
    swarmCount.textContent = `${activeWorkers.length} active${exploring ? ` · ${exploring} live` : ""} · ${totalActions} auxiliary action${totalActions === 1 ? "" : "s"}`;

    swarmGrid.hidden = activeWorkers.length === 0;
    swarmGrid.innerHTML = instanceCards(activeWorkers);
    wireInstanceCards(swarmGrid, workers);

    finishedAgents.hidden = finishedWorkers.length === 0;
    if (finishedWorkers.some((worker) => worker.id === state.activeReplay) && (state.playingView || state.expandedInstance)) {
      finishedAgents.open = true;
    }
    finishedCount.textContent = String(finishedWorkers.length);
    finishedGrid.innerHTML = instanceCards(finishedWorkers);
    wireInstanceCards(finishedGrid, workers);
  }

  function describeRun(run) {
    document.getElementById("run-title").textContent =
      `${run.model}${run.model_name ? ` (${run.model_name})` : ""} on ${run.game_title || run.game_id}`;
    const bits = [
      `run ${run.id}`,
      run.level_id ? `level ${levelLabel(run.level_id)}` : null,
      run.unlimited ? "Unlimited move budget" : run.moves ? `${run.moves} move budget` : null,
      run.mode,
      run.reasoning ? `reasoning ${run.reasoning}` : null,
      run.continued ? `continued ×${run.continued}` : null,
      run.kind === "local" ? (run.container ? "container" : "host") : "prime verifiers",
      run.prime_evaluation_id ? `Prime eval ${run.prime_evaluation_id}` : null,
      run.note || ""
    ].filter(Boolean);
    document.getElementById("run-meta").textContent = bits.join(" · ");
  }

  function renderStats(run) {
    const statusLabel = run.status === "finished" ? (run.complete ? "complete" : "ended") : run.status;
    const chips = isPrime
      ? [
          ["status", statusLabel],
          ["turn budget", String(run.moves ?? "")],
          run.prime_evaluation_status ? ["Prime", String(run.prime_evaluation_status).toLowerCase()] : null,
          run.prime_evaluation_score != null ? ["score", String(run.prime_evaluation_score)] : null,
          run.turns ? ["moves", String(run.turns)] : null,
          run.turns ? ["gems", String(run.gem_count ?? 0)] : null,
          run.solved ? ["result", "SOLVED"] : null
        ].filter(Boolean)
      : [
          ["status", statusLabel],
          ["moves", `${run.turns}/${run.unlimited ? "∞" : run.moves}`],
          ["gems", String(run.gem_count ?? 0)],
          ["room", levelLabel(run.current_room)],
          run.solved ? ["result", "SOLVED"] : null
        ].filter(Boolean);
    if (run.swarm) {
      chips.push(
        ["agents running", String(state.swarmAgents.running)],
        ["agents ran", String(state.swarmAgents.ran)]
      );
    }
    if (Number(run.explorer_instances) > 0 || Number(state.instanceActivity.instances) > 0) {
      const instances = Math.max(Number(run.explorer_instances) || 0, Number(state.instanceActivity.instances) || 0);
      const auxiliary = Math.max(Number(run.auxiliary_actions) || 0, Number(state.instanceActivity.auxiliary_actions) || 0);
      chips.push(
        ["instances", String(instances)],
        ["aux actions", String(auxiliary)],
        ["simulated", String((Number(run.turns) || 0) + auxiliary)]
      );
    }
    document.getElementById("run-stats").innerHTML = chips
      .map(
        ([label, value]) =>
          `<span class="agent-stat"><span class="agent-stat__label">${escapeText(label)}</span> ${escapeText(value)}</span>`
      )
      .join("");
    renderRunProgress(run);
    renderControls(run);
  }

  function formatDuration(value) {
    const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  }

  function renderRunProgress(run) {
    const progress = run.progress || {};
    const current = Number.isFinite(Number(progress.current)) ? Number(progress.current) : Number(run.turns) || 0;
    const total = Math.max(1, Number(progress.total) || Number(run.moves) || 1);
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    const eta = Number(progress.eta_ms);
    const etaLabel =
      run.status === "waiting"
        ? "Waiting"
        : run.status === "finished"
        ? run.complete
          ? "Complete"
          : "Ended"
        : run.status === "paused"
          ? "Paused"
          : run.status === "pausing"
            ? "Pausing…"
          : run.status === "stopping"
            ? "Stopping…"
            : run.status === "stopped"
              ? "Stopped"
              : run.status === "failed"
                ? "Failed"
                : Number.isFinite(eta) && current > 0
                  ? eta <= 0
                    ? "Finishing…"
                    : `~${formatDuration(eta)} left`
                  : "Estimating…";
    const track = document.getElementById("run-progress-track");
    const bar = document.getElementById("run-progress-bar");

    if (run.unlimited) {
      document.getElementById("run-progress-count").textContent = `${current} moves · unlimited`;
      document.getElementById("run-progress-eta").textContent =
        run.status === "paused"
          ? "Paused"
          : run.status === "pausing"
            ? "Pausing…"
            : run.status === "stopped"
              ? "Stopped"
              : "No move limit";
      track.hidden = true;
      return;
    }

    track.hidden = false;

    document.getElementById("run-progress-count").textContent = `${current} / ${total} moves`;
    document.getElementById("run-progress-eta").textContent = etaLabel;
    track.setAttribute("aria-valuenow", String(Math.round(percent)));
    track.setAttribute("aria-valuetext", `${current} of ${total} moves, ${etaLabel}`);
    bar.style.width = `${percent}%`;
    bar.classList.toggle("is-paused", run.status === "paused");
    bar.classList.toggle("is-terminal", ["finished", "stopped", "failed"].includes(run.status));
  }

  function renderControls(run) {
    if (stopButton) stopButton.hidden = !(isPrime && ["running", "stopping"].includes(run.status));
    if (primeEvaluationLink) {
      primeEvaluationLink.hidden = !run.prime_evaluation_url;
      if (run.prime_evaluation_url) primeEvaluationLink.href = run.prime_evaluation_url;
    }
    pauseButton.hidden = !run.pausable;
    resumeButton.hidden = !run.resumable;
    continueButton.hidden = !run.continuable;
    generateVideoButton.disabled = run.video_status === "rendering";
    generateVideoButton.hidden = !(
      run.status === "finished" && !run.has_video && run.video_status !== "rendering"
    );
  }

  function formatTokens(value) {
    const tokens = Number(value);
    if (!Number.isFinite(tokens)) return "—";
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 1 : 2)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
    return Math.round(tokens).toLocaleString();
  }

  function drawContextChart() {
    const canvas = tokenChart.querySelector(".run-context-chart__canvas");
    const points = state.contextPoints;
    if (!canvas || !points.length) return;

    const width = Math.max(280, Math.floor(canvas.clientWidth));
    const height = Math.max(150, Math.floor(canvas.clientHeight));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padding = { top: 14, right: 14, bottom: 27, left: 48 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const ceiling = Math.max(1, ...points.map((point) => point.context)) * 1.08;
    const x = (index) => padding.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
    const y = (value) => padding.top + plotHeight - (value / ceiling) * plotHeight;

    context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const lineY = padding.top + (plotHeight / 4) * index;
      context.strokeStyle = "rgba(124, 143, 255, 0.11)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.fillStyle = "rgba(154, 163, 199, 0.76)";
      context.textAlign = "right";
      context.fillText(formatTokens(ceiling * (1 - index / 4)), padding.left - 8, lineY);
    }

    const fill = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
    fill.addColorStop(0, "rgba(169, 153, 255, 0.2)");
    fill.addColorStop(1, "rgba(169, 153, 255, 0)");
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(index), y(point.context));
      else context.lineTo(x(index), y(point.context));
    });
    context.lineTo(x(points.length - 1), padding.top + plotHeight);
    context.lineTo(x(0), padding.top + plotHeight);
    context.closePath();
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(index), y(point.context));
      else context.lineTo(x(index), y(point.context));
    });
    context.strokeStyle = "#a999ff";
    context.lineWidth = 2.25;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.shadowColor = "rgba(139, 123, 255, 0.38)";
    context.shadowBlur = 9;
    context.stroke();
    context.shadowBlur = 0;

    points.forEach((point, index) => {
      if (!point.compacted && index !== points.length - 1) return;
      context.beginPath();
      context.arc(x(index), y(point.context), point.compacted ? 4 : 3.5, 0, Math.PI * 2);
      context.fillStyle = point.compacted ? "#ff9d82" : "#65f3d4";
      context.fill();
      context.strokeStyle = "#070811";
      context.lineWidth = 1.5;
      context.stroke();
    });

    const labelIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    context.fillStyle = "rgba(154, 163, 199, 0.76)";
    context.textBaseline = "alphabetic";
    labelIndexes.forEach((index, labelIndex) => {
      context.textAlign = labelIndex === 0 ? "left" : labelIndex === labelIndexes.length - 1 ? "right" : "center";
      context.fillText(String(points[index].action), x(index), height - 7);
    });
  }

  function renderTokenUsage(usage) {
    const signature = JSON.stringify(usage || {});
    if (signature === state.tokenSignature) return;
    state.tokenSignature = signature;

    let agentCountsChanged = false;
    (Array.isArray(usage?.actions) ? usage.actions : []).forEach((point, index) => {
      const action = Number(point.action) || index + 1;
      const count = Math.max(0, Math.floor(Number(point.active_agents) || 0));
      if (count && state.agentCounts.get(action) !== count) {
        state.agentCounts.set(action, count);
        agentCountsChanged = true;
      }
      const tokens = Math.max(0, Math.round(Number(point.total_tokens) || 0));
      if (state.tokenCounts.get(action) !== tokens) {
        state.tokenCounts.set(action, tokens);
        agentCountsChanged = true;
      }
    });
    state.swarmAgents = {
      running: Math.max(0, Math.floor(Number(usage?.agents_running) || 0)),
      ran: Math.max(0, Math.floor(Number(usage?.agents_ran) || 0))
    };
    if (agentCountsChanged) state.feedVersion += 1;

    const available = Boolean(usage?.available);
    document.getElementById("run-token-total").textContent = available ? formatTokens(usage.total_tokens) : "—";
    document.getElementById("run-token-average").textContent = available
      ? formatTokens(usage.average_tokens_per_action)
      : "—";
    document.getElementById("run-token-context").textContent = usage?.current_context_tokens
      ? formatTokens(usage.current_context_tokens)
      : "—";

    const contextDetail = document.getElementById("run-token-context-detail");
    if (usage?.current_context_tokens && usage?.context_window) {
      const percent = Math.round((usage.current_context_tokens / usage.context_window) * 100);
      contextDetail.textContent = `${percent}% of ${formatTokens(usage.context_window)}`;
    } else {
      contextDetail.textContent = "";
    }

    tokenEmpty.hidden = available;
    tokenBadge.hidden = !available;
    tokenBadge.classList.toggle("is-estimated", available && !usage.exact);
    tokenBadge.classList.toggle("is-compacted", Boolean(usage?.compactions));
    tokenBadge.textContent = usage?.compactions
      ? `${usage.compactions} compaction${usage.compactions === 1 ? "" : "s"}`
      : usage?.exact
        ? "Exact"
        : "Estimated";
    tokenNote.hidden = !usage?.note;
    tokenNote.textContent = usage?.note || "";

    const points = (Array.isArray(usage?.actions) ? usage.actions : [])
      .map((point, index) => ({
        action: point.action || index + 1,
        context: Number(point.context_tokens) || 0,
        compacted: Boolean(point.compacted)
      }))
      .filter((point) => point.context > 0);
    state.contextPoints = points;
    if (!points.length) {
      tokenChart.hidden = true;
      tokenChart.innerHTML = "";
      return;
    }

    const latest = points[points.length - 1];
    tokenChart.innerHTML = `<canvas class="run-context-chart__canvas" role="img" aria-label="Context size by action; latest ${latest.context.toLocaleString()} tokens"></canvas>`;
    tokenChart.hidden = false;
    requestAnimationFrame(drawContextChart);
  }

  window.addEventListener("resize", () => requestAnimationFrame(drawContextChart), { passive: true });

  // ---- combined moves + reasoning feed --------------------------------------

  function ingestActions(actions) {
    for (const action of actions) {
      const flags = [
        action.moved === false ? "blocked" : null,
        action.player_dead ? "died" : null,
        action.solved ? "SOLVED" : null
      ].filter(Boolean);
      const nextMove = {
        action: action.command_text,
        room: levelLabel(action.current_room),
        gems: action.gem_count ?? 0,
        timestamp: action.timestamp || null,
        flags
      };
      const previousMove = state.moves.get(action.turn);
      if (
        !previousMove ||
        previousMove.action !== nextMove.action ||
        previousMove.room !== nextMove.room ||
        previousMove.gems !== nextMove.gems ||
        previousMove.timestamp !== nextMove.timestamp ||
        previousMove.flags.join("|") !== nextMove.flags.join("|")
      ) {
        state.moves.set(action.turn, nextMove);
        state.feedVersion += 1;
      }
      if (action.level && !isVision && !state.replayCursors.has("primary")) {
        boardEl.textContent = action.level;
        boardWrap.hidden = false;
      }
      state.afterTurn = Math.max(state.afterTurn, Number(action.turn) || 0);
    }
  }

  function ingestReasoning(reasoning) {
    if (!Array.isArray(reasoning)) return;
    for (const entry of reasoning) {
      if (entry && entry.move != null) {
        if (entry.reasoning && state.reasoning.get(entry.move) !== entry.reasoning) {
          state.reasoning.set(entry.move, entry.reasoning);
          state.feedVersion += 1;
        }
        if (entry.timestamp) {
          const move = state.moves.get(entry.move);
          if (move && move.timestamp !== entry.timestamp) {
            state.moves.set(entry.move, { ...move, timestamp: entry.timestamp });
            state.feedVersion += 1;
          }
        }
        // Reasoning distill also carries the action + result; fill gaps from it.
        if (!state.moves.has(entry.move)) {
          state.moves.set(entry.move, {
            action: entry.action,
            room: levelLabel(entry.room),
            gems: entry.gems ?? 0,
            timestamp: entry.timestamp || null,
            flags: [entry.moved === false ? "blocked" : null, entry.player_dead ? "died" : null].filter(Boolean)
          });
          state.feedVersion += 1;
        }
      }
    }
  }

  function renderFeed() {
    if (state.renderedFeedVersion === state.feedVersion) return;
    const moveNums = [...state.moves.keys()].sort((a, b) => a - b);
    if (!moveNums.length) {
      feedEl.innerHTML = '<p class="muted">Waiting for the agent\'s first move…</p>';
      state.renderedFeedVersion = state.feedVersion;
      return;
    }

    const previousTop = feedEl.scrollTop;
    const distanceFromBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
    const followLatest = distanceFromBottom <= 40;
    const feedTop = feedEl.getBoundingClientRect().top;
    let anchorMove = "";
    let anchorOffset = 0;

    if (!followLatest) {
      const anchor = [...feedEl.querySelectorAll(".agent-feed__row")].find(
        (row) => row.getBoundingClientRect().bottom > feedTop
      );
      if (anchor) {
        anchorMove = anchor.dataset.move || "";
        anchorOffset = anchor.getBoundingClientRect().top - feedTop;
      }
    }

    feedEl.innerHTML = moveNums
      .map((num) => {
        const move = state.moves.get(num);
        const reasoning = state.reasoning.get(num);
        const activeAgents = state.agentCounts.get(num) || (state.run.swarm ? 0 : 1);
        const moveTokens = state.tokenCounts.get(num);
        const parsedTimestamp = move.timestamp ? new Date(move.timestamp) : null;
        const timestamp = parsedTimestamp && Number.isFinite(parsedTimestamp.getTime())
          ? parsedTimestamp.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })
          : "";
        const meta = [`${escapeText(move.room)}`, `${escapeText(move.gems)} gems`, ...move.flags.map(escapeText)]
          .filter(Boolean)
          .join(" · ");
        const agentBadge = activeAgents
          ? `<span class="agent-feed__agents" role="img" aria-label="${escapeText(activeAgents)} agent${activeAgents === 1 ? "" : "s"} active" title="Agents active on this move">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <strong>${escapeText(activeAgents)}</strong>
            </span>`
          : "";
        const tokenBadge = Number.isFinite(moveTokens)
          ? `<span class="agent-feed__tokens" role="img" aria-label="${escapeText(moveTokens.toLocaleString())} tokens used on this move" title="Lead + worker tokens for this move">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 8h8M12 8v8"/></svg>
              <strong>${escapeText(formatTokens(moveTokens))}</strong>
            </span>`
          : "";
        return `<div class="agent-feed__row" data-move="${escapeText(num)}">
          <div class="agent-feed__head">
            <span class="agent-feed__num">${escapeText(num)}</span>
            <span class="agent-feed__action">${escapeText(move.action)}</span>
            ${tokenBadge}
            ${agentBadge}
            <span class="agent-feed__meta">${meta}</span>
            ${timestamp ? `<time class="agent-feed__time" datetime="${escapeText(move.timestamp)}">${escapeText(timestamp)}</time>` : ""}
          </div>
          ${reasoning ? `<p class="agent-feed__reasoning">${escapeText(reasoning)}</p>` : ""}
        </div>`;
      })
      .join("");
    state.renderedFeedVersion = state.feedVersion;

    if (followLatest) {
      feedEl.scrollTop = feedEl.scrollHeight;
    } else if (anchorMove) {
      const nextAnchor = [...feedEl.querySelectorAll(".agent-feed__row")].find(
        (row) => row.dataset.move === anchorMove
      );
      if (nextAnchor) {
        feedEl.scrollTop += nextAnchor.getBoundingClientRect().top - feedTop - anchorOffset;
      } else {
        feedEl.scrollTop = previousTop;
      }
    } else {
      feedEl.scrollTop = previousTop;
    }
  }

  // ---- live image -----------------------------------------------------------

  const captionEl = document.getElementById("run-live-caption");

  function showImage(url, turn) {
    if (!url) return;
    liveGrid?.classList.remove("is-text-history");
    livePlaceholder?.classList.remove("is-history");
    // Each turn gets its own frame URL, so only touch the <img> when the URL
    // actually changes — the poll loop calls this every tick, and resetting
    // src re-downloads the frame and makes it flicker.
    if (url !== state.lastImageUrl) {
      state.lastImageUrl = url;
      liveImage.src = url;
    }
    liveImage.hidden = false;
    livePlaceholder.hidden = true;
    if (captionEl && turn != null) {
      captionEl.textContent = Number(turn) === 0 ? "move 0 · starting state" : `after move ${turn}`;
      captionEl.hidden = false;
    }
  }

  function applyMainObservation(observation) {
    if (!observation) return;
    const turn = Math.max(0, Number(observation.turn) || 0);
    if (observation.board && observation.mode === "text") {
      boardEl.textContent = observation.board;
      boardWrap.hidden = false;
    }
    if (observation.frame_url) {
      showImage(observation.frame_url, turn);
      return;
    }

    liveImage.hidden = true;
    livePlaceholder.hidden = false;
    livePlaceholder.classList.add("is-history");
    const label = livePlaceholder.querySelector("span:last-child");
    if (label) label.textContent = observation.mode === "vision"
      ? `No saved vision frame for move ${turn}`
      : `Text observation · move ${turn}`;
    liveGrid?.classList.toggle("is-text-history", observation.mode === "text");
    if (captionEl) {
      captionEl.textContent = turn === 0 ? "move 0 · starting state" : `after move ${turn}`;
      captionEl.hidden = false;
    }
  }

  // Text-mode runs always use an on-demand frame. Vision runs use the same
  // renderer for move 0 until the agent's own first vision frame is available.
  // Throttle to one render at a time so we never queue browser boots.
  async function maybeRenderLocalFrame() {
    if (state.frameRendering || state.replayCursors.has("primary")) return;
    const latest = state.afterTurn;
    if (latest <= state.lastRenderedTurn) return;

    state.frameRendering = true;
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/frame?turn=${latest}`);
      const payload = await response.json();
      if (payload.url && !state.replayCursors.has("primary")) {
        const renderedTurn = Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : latest;
        state.frameFailures = 0;
        showImage(payload.url, renderedTurn);
        state.lastRenderedTurn = Math.max(state.lastRenderedTurn, renderedTurn);
      } else if (payload.error && !payload.pending) {
        state.frameFailures += 1;
        if (livePlaceholder && !liveImage.src) {
          livePlaceholder.querySelector("span:last-child").textContent = payload.error;
        }
      }
    } catch (error) {
      state.frameFailures += 1;
    } finally {
      state.frameRendering = false;
    }
  }

  // ---- replay progress ------------------------------------------------------

  function updateReplay(run, progress) {
    const section = document.getElementById("run-replay-section");
    const bar = document.getElementById("run-replay-bar");
    const label = document.getElementById("run-replay-label");
    const progressBox = document.getElementById("run-replay-progress");
    const video = document.getElementById("run-video");

    if (run.has_video) {
      section.hidden = false;
      progressBox.hidden = true;
      if (!state.videoShown) {
        video.src = `/agent-runs/${encodeURIComponent(runId)}/files/maze_replay.mp4`;
        video.hidden = false;
        state.videoShown = true;
      }
      return;
    }

    if (run.video_status === "failed") {
      section.hidden = false;
      progressBox.hidden = false;
      bar.style.width = "0%";
      label.textContent = run.video_error || "Video generation failed. You can try again.";
      return;
    }

    // Rendering in progress (run finished but the mp4 isn't ready yet).
    const rendering = run.video_status === "rendering";
    if (rendering || (progress && progress.percent != null && progress.phase !== "done")) {
      section.hidden = false;
      progressBox.hidden = false;
      const pct = progress && Number.isFinite(progress.percent) ? progress.percent : 0;
      bar.style.width = `${pct}%`;
      const phase = progress && progress.phase ? progress.phase : "starting";
      const eta = progress && progress.eta_ms ? ` · about ${Math.ceil(progress.eta_ms / 1000)}s left` : "";
      const detail = progress && progress.current != null && progress.total != null
        ? ` (${progress.current}/${progress.total} ${progress.unit || ""})`
        : "";
      label.textContent = `Rendering replay video — ${phase}${detail} ${pct}%${eta}`;
    }
  }

  // ---- poll loop ------------------------------------------------------------

  async function poll() {
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(runId)}/progress?after_turn=${state.afterTurn}&log_offset=${state.logOffset}`,
        { headers: { accept: "application/json" } }
      );
      if (!response.ok) throw new Error(`progress failed (${response.status})`);
      const progress = await response.json();
      state.run = progress.run;
      state.instanceActivity = progress.instance_activity || state.instanceActivity;

      describeRun(progress.run);
      renderTokenUsage(progress.token_usage);
      renderStats(progress.run);
      renderSwarmViews(progress.swarm_views);

      if (isPrime) {
        // Hosted Prime lifecycle and logs stream immediately. The actions,
        // usage, boards, and replay are enriched from the finalized sample.
        ingestActions(progress.actions || []);
        ingestReasoning(progress.reasoning || []);
        renderFeed();
        renderMainReplayControls();
        const seeEmpty = document.getElementById("run-see-empty");
        if (seeEmpty && boardEl && boardEl.textContent) {
          seeEmpty.hidden = true;
        }
        updateReplay(progress.run, progress.replay_progress);
      } else {
        ingestActions(progress.actions || []);
        ingestReasoning(progress.reasoning || []);
        renderFeed();
        renderMainReplayControls();

        const mayRenderLiveFrame = !["paused", "stopping", "stopped", "waiting", "failed"].includes(
          progress.run.status
        );

        if (!state.replayCursors.has("primary") && isVision && progress.vision_frame_url) {
          const match = String(progress.vision_frame_url).match(/frame-(\d+)\.png(?:$|\?)/);
          const visionTurn = match ? Number(match[1]) : state.afterTurn;
          if (visionTurn >= state.afterTurn && visionTurn >= state.lastRenderedTurn) {
            showImage(progress.vision_frame_url, visionTurn);
            state.lastRenderedTurn = visionTurn;
          }
          if (mayRenderLiveFrame && state.lastRenderedTurn < state.afterTurn) maybeRenderLocalFrame();
        } else if (!state.replayCursors.has("primary") && mayRenderLiveFrame) {
          maybeRenderLocalFrame();
        }

        updateReplay(progress.run, progress.replay_progress);
      }

      if (progress.log_chunk) {
        logEl.textContent += progress.log_chunk;
        logEl.scrollTop = logEl.scrollHeight;
      }
      state.logOffset = progress.log_offset;

      const running = ["running", "pausing", "stopping"].includes(progress.run.status);
      // Prime renders its replay inside the same process, so the run stays
      // "running" while the video builds; don't treat a terminal-without-video
      // Prime run as still-rendering (the video step is best-effort there).
      const waitingForVideo = !running && progress.run.video_status === "rendering";
      if (running) {
        if (progress.run.status === "pausing") {
          setStatus(`Pausing after move ${progress.run.pause_after_turn || "the next completed action"}…`);
        } else if (progress.run.status === "stopping") {
          setStatus("Stopping…");
        } else if (isPrime) {
          const rp = progress.replay_progress;
          setStatus(
            rp && rp.phase && rp.phase !== "done"
              ? `Rendering replay video… ${rp.percent ?? 0}%`
              : progress.run.prime_evaluation_id
                ? "Live — Prime Hosted Evaluation is running."
                : "Launching Prime Hosted Evaluation…"
          );
        } else {
          setStatus("Live — the agent is playing.");
        }
        state.timer = setTimeout(poll, 1500);
      } else if (waitingForVideo) {
        setStatus("Run finished — rendering the replay video…");
        state.timer = setTimeout(poll, 2000);
      } else if (progress.run.status === "waiting") {
        setStatus("Waiting for the active Claude Code run to finish.");
        state.timer = setTimeout(poll, 3000);
      } else if (progress.run.status === "paused") {
        const retryMs = Date.parse(progress.run.retry_at || "") - Date.now();
        setStatus(
          progress.run.pause_reason === "quota"
            ? `Paused — out of funds/credits/usage${
                progress.run.pause_message ? `: ${progress.run.pause_message}` : ""
              }. Resume once you have credits.`
            : progress.run.pause_reason === "provider_backoff"
              ? `Provider temporarily unavailable — retrying the same saved thread ${
                  Number.isFinite(retryMs) && retryMs > 0 ? `in ${formatDuration(retryMs)}` : "now"
                }${progress.run.pause_message ? `: ${progress.run.pause_message}` : ""}`
            : "Paused. Resume to pick up where it left off.",
          ["quota", "provider_backoff"].includes(progress.run.pause_reason)
        );
        // Keep polling slowly so the page reflects a resume from elsewhere.
        state.timer = setTimeout(poll, 4000);
      } else {
        setStatus(
          progress.run.status !== "finished"
            ? `Run ${progress.run.status}.`
            : isPrime
              ? `${progress.run.complete ? "Eval complete" : "Eval ended"} — ${progress.run.turns || 0} move${progress.run.turns === 1 ? "" : "s"}${
                  progress.run.has_video ? ", replay video above" : ""
                }; see the runner log for rewards and scores.`
              : `${progress.run.complete ? "Complete" : "Ended"} — ${progress.run.gem_count ?? 0}/${progress.run.gem_total ?? "—"} gems in ${progress.run.turns} moves.`,
          progress.run.status === "failed"
        );
        // The text-mode image renders async and lags the board; keep polling
        // until it catches up to the final move so the two end up in sync.
        // Give up after a few consecutive renderer failures — otherwise a
        // finished run whose renderer keeps erroring polls forever.
        if (!isPrime && !isVision && state.lastRenderedTurn < state.afterTurn && state.frameFailures < 5) {
          maybeRenderLocalFrame();
          state.timer = setTimeout(poll, 1200);
        }
      }
    } catch (error) {
      setStatus(error.message, true);
      state.timer = setTimeout(poll, 4000);
    }
  }

  async function runAction(action) {
    const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/${action}`, { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Request failed (${response.status}).`);
    }
    return response.json();
  }

  stopButton?.addEventListener("click", async () => {
    try {
      await runAction("stop");
      setStatus("Stopping…");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  pauseButton?.addEventListener("click", async () => {
    try {
      const payload = await runAction("pause");
      setStatus(`Pausing after move ${payload.run?.pause_after_turn || "the next completed action"}…`);
      renderControls(payload.run || {});
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  resumeButton?.addEventListener("click", async () => {
    try {
      const payload = await runAction("resume");
      // A quota resume relaunches as a new continuation run — go watch it.
      if (payload.run && payload.run.id !== runId && payload.run.url) {
        window.location.href = payload.run.url;
        return;
      }
      setStatus("Resumed.");
      clearTimeout(state.timer);
      poll();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  continueButton?.addEventListener("click", async () => {
    const answer = window.prompt("How many more moves should it run?", "10");
    if (answer === null) return;
    const moves = Math.max(1, Math.min(500, Math.floor(Number(answer) || 0)));
    if (!moves) {
      setStatus("Enter a positive number of moves.", true);
      return;
    }
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ moves })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
      window.location.href = payload.run.url;
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  generateVideoButton?.addEventListener("click", async () => {
    generateVideoButton.disabled = true;
    try {
      const payload = await runAction("video");
      state.run = payload.run || state.run;
      renderControls(state.run);
      updateReplay(state.run, { phase: "starting", percent: 0 });
      setStatus("Generating replay video…");
      clearTimeout(state.timer);
      poll();
    } catch (error) {
      generateVideoButton.disabled = false;
      setStatus(error.message, true);
    }
  });

  deleteButton?.addEventListener("click", async () => {
    if (!window.confirm("Delete this run and its artifacts? This can't be undone.")) return;
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Request failed (${response.status}).`);
      }
      window.location.href = "/agent";
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  liveGrid?.addEventListener("pointerdown", () => {
    const previous = state.activeReplay;
    state.activeReplay = "primary";
    if (previous && previous !== "primary") refreshReplayControls(previous);
    renderMainReplayControls();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (!mainReplayControls && state.activeReplay === "primary") return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target?.matches?.("input, textarea, select") || target?.isContentEditable) return;
    const now = Date.now();
    if (event.repeat && now - state.keyboardStepAt < replayDelay(state.activeReplay || "primary")) return;
    state.keyboardStepAt = now;
    event.preventDefault();
    handleReplayAction(state.activeReplay || "primary", event.key === "ArrowLeft" ? "previous" : "next");
  });

  // In vision mode the ASCII board is irrelevant (the agent only sees images),
  // so show just the image, centered.
  if (!isPrime && isVision) {
    boardWrap.hidden = true;
    document.getElementById("run-live-grid").classList.add("is-image-only");
  }

  // A Prime vision run has no text board to show — the model reads images — so
  // drop the "what the agent sees" panel entirely (the replay video covers it).
  if (isPrime && isVision) {
    const seeSection = document.getElementById("run-see-section");
    if (seeSection) seeSection.hidden = true;
  }

  describeRun(initial);
  renderStats(initial);
  renderMainReplayControls();
  poll();
})();
