(() => {
  const initial = window.__AGENT_RUN__ || {};
  const runWorld = window.__AGENT_RUN_WORLD__ || null;
  const runId = initial.id;
  const isVision = initial.mode === "vision";
  const isJson = initial.mode === "json";
  // Hosted Prime evaluations expose lifecycle state immediately and the scored
  // sample at completion, so skip the local-only frame renderer while active.
  const isPrime = initial.kind === "prime" || initial.model === "prime";
  const statusEl = document.getElementById("run-status");
  const boardEl = document.getElementById("run-board");
  const boardWrap = document.getElementById("run-board-wrap");
  let jsonEl = document.getElementById("run-json");
  let jsonWrap = document.getElementById("run-json-wrap");
  const feedEl = document.getElementById("run-feed");
  const feedSearch = document.getElementById("run-feed-search");
  const feedSearchClear = document.getElementById("run-feed-search-clear");
  const feedResult = document.getElementById("run-feed-result");
  const feedExportButton = document.getElementById("run-feed-export");
  const feedTextExportButton = document.getElementById("run-feed-export-txt");
  const notesInput = document.getElementById("run-notes-input");
  const notesSaveButton = document.getElementById("run-notes-save");
  const notesSaveLabel = document.getElementById("run-notes-save-label");
  const notesStatus = document.getElementById("run-notes-status");
  const notesStatusText = document.getElementById("run-notes-status-text");
  const notesCount = document.getElementById("run-notes-count");
  const logEl = document.getElementById("run-log");
  const stopButton = document.getElementById("stop-run");
  const primeEvaluationLink = document.getElementById("open-prime-evaluation");
  const primeSyncButton = document.getElementById("sync-prime-evaluation");
  const pauseButton = document.getElementById("pause-run");
  const resumeButton = document.getElementById("resume-run");
  const continueButton = document.getElementById("continue-run");
  const generateVideoButton = document.getElementById("generate-video");
  const cancelVideoButton = document.getElementById("cancel-video");
  const regenerateVideoButton = document.getElementById("regenerate-video");
  const downloadVideoButton = document.getElementById("download-video");
  const deleteButton = document.getElementById("delete-run");
  const liveImage = document.getElementById("run-live-image");
  const livePlaceholder = document.getElementById("run-live-placeholder");
  const liveGrid = document.getElementById("run-live-grid");
  const mainReplayControls = document.getElementById("run-main-replay-controls");
  const tokenChart = document.getElementById("run-token-chart");
  const tokenEmpty = document.getElementById("run-token-empty");
  const tokenBadge = document.getElementById("run-token-badge");
  const tokenNote = document.getElementById("run-token-note");
  const explorationGrid = document.getElementById("run-exploration-grid");
  const explorationEmpty = document.getElementById("run-exploration-empty");
  const roomsChart = document.getElementById("run-rooms-chart");
  const gemsChart = document.getElementById("run-gems-chart");
  const roomsChartTooltip = document.getElementById("run-rooms-chart-tooltip");
  const gemsChartTooltip = document.getElementById("run-gems-chart-tooltip");
  const roomsLatest = document.getElementById("run-rooms-latest");
  const gemsLatest = document.getElementById("run-gems-latest");
  const roomsMapButton = document.getElementById("run-rooms-map-button");
  const roomsMapDialog = document.getElementById("run-rooms-map-dialog");
  const roomsMapClose = document.getElementById("run-rooms-map-close");
  const roomsMapGrid = document.getElementById("run-rooms-map-grid");
  const roomsMapSummary = document.getElementById("run-rooms-map-summary");
  const roomsMapTooltip = document.getElementById("run-rooms-map-tooltip");
  const heatmapSection = document.getElementById("run-heatmap-section");
  const heatmapViewport = document.getElementById("run-heatmap-viewport");
  const heatmapCanvas = document.getElementById("run-heatmap-canvas");
  const heatmapTooltip = document.getElementById("run-heatmap-tooltip");
  const heatmapSummary = document.getElementById("run-heatmap-summary");
  const heatmapLegend = document.getElementById("run-heatmap-legend");
  const heatmapEmpty = document.getElementById("run-heatmap-empty");
  const boardStateChart = document.getElementById("run-board-state-chart");
  const boardStateCanvas = document.getElementById("run-board-state-canvas");
  const boardStateLatest = document.getElementById("run-board-state-latest");
  const boardStateTooltip = document.getElementById("run-board-state-tooltip");
  const boardStateDescription = document.getElementById("run-board-state-description");
  const boardStateBasis = document.getElementById("run-board-state-basis");
  const boardStateScope = document.getElementById("run-board-state-scope");
  const boardStateCustomWindow = document.getElementById("run-board-state-custom-window");
  const boardStateWindowInput = document.getElementById("run-board-state-window");
  let heatmapExportFormat = document.getElementById("run-heatmap-export-format");
  let heatmapExportButton = document.getElementById("run-heatmap-export");
  const swarmSection = document.getElementById("run-swarm-section");
  const swarmGrid = document.getElementById("run-swarm-grid");
  const swarmCount = document.getElementById("run-swarm-count");
  const finishedAgents = document.getElementById("run-finished-agents");
  const finishedGrid = document.getElementById("run-finished-grid");
  const finishedCount = document.getElementById("run-finished-count");

  // Keep already-open servers compatible with the JSON run UI. The run page
  // HTML comes from a long-lived Node process, while this static script reloads
  // from disk; creating the panel here means a normal browser refresh is enough
  // after upgrading, without interrupting an active maze run to restart Node.
  if (isJson && boardWrap) {
    const boardLabel = boardWrap.querySelector(".run-live__board-label");
    if (boardLabel) boardLabel.textContent = "ASCII view — the model does not see this";
    liveGrid?.classList.add("is-json-mode");
    if (!jsonWrap) {
      jsonWrap = document.createElement("div");
      jsonWrap.id = "run-json-wrap";
      jsonWrap.className = "run-live__board run-live__json";
      jsonWrap.hidden = true;
      const label = document.createElement("div");
      label.className = "run-live__board-label";
      label.textContent = "JSON observation — this is what the model sees";
      jsonEl = document.createElement("pre");
      jsonEl.id = "run-json";
      jsonEl.className = "agent-board";
      jsonWrap.append(label, jsonEl);
      if (liveGrid) liveGrid.append(jsonWrap);
      else boardWrap.insertAdjacentElement("afterend", jsonWrap);
    }
  }

  // The local server can outlive static asset updates. Upgrade older run-page
  // markup in place so an active run only needs a refresh, not a server restart.
  if (heatmapSection) {
    heatmapSection.querySelector(".run-heatmap__head .muted")?.remove();
    const head = heatmapSection.querySelector(".run-heatmap__head");
    let actions = head?.querySelector(".run-heatmap__actions");
    if (head && !actions) {
      actions = document.createElement("div");
      actions.className = "run-heatmap__actions";
      heatmapSummary?.replaceWith(actions);
      if (heatmapSummary) actions.append(heatmapSummary);
      else head.append(actions);
    }
    if (heatmapSummary && !heatmapSummary.querySelector("[data-heatmap-stat]")) {
      [
        ["cells", "Cells visited"],
        ["visits", "Total visits"],
        ["new-rate", "New-cell visits"]
      ].forEach(([key, label]) => {
        const stat = document.createElement("span");
        stat.className = "run-heatmap__stat";
        const value = document.createElement("strong");
        value.dataset.heatmapStat = key;
        value.textContent = "—";
        const caption = document.createElement("small");
        caption.textContent = label;
        stat.append(value, caption);
        heatmapSummary.append(stat);
      });
    }
    if (actions && !heatmapExportFormat) {
      heatmapExportFormat = document.createElement("select");
      heatmapExportFormat.id = "run-heatmap-export-format";
      heatmapExportFormat.className = "run-heatmap__format";
      heatmapExportFormat.setAttribute("aria-label", "Heatmap export format");
      [["gif", "GIF"], ["mp4", "MP4"]].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        heatmapExportFormat.append(option);
      });
      heatmapExportFormat.hidden = true;
      actions.append(heatmapExportFormat);
    }
    if (actions && !heatmapExportButton) {
      heatmapExportButton = document.createElement("button");
      heatmapExportButton.id = "run-heatmap-export";
      heatmapExportButton.className = "run-heatmap__export";
      heatmapExportButton.type = "button";
      heatmapExportButton.title = "Export a compact animated GIF of the heatmap forming";
      heatmapExportButton.textContent = "Export GIF";
      heatmapExportButton.hidden = true;
      actions.append(heatmapExportButton);
    }
  }

  if (isPrime && stopButton) stopButton.textContent = "Cancel Run";

  const FEED_RENDER_BATCH = 200;
  const BOARD_STATE_NOVELTY_WINDOW = 100;
  const BOARD_STATE_CUSTOM_WINDOW_DEFAULT = 100;
  const BOARD_STATE_CUSTOM_WINDOW_MAX = 10000;
  const state = {
    afterTurn: 0,
    logOffset: 0,
    run: initial,
    timer: null,
    moves: new Map(), // move# -> { action, room, gems, flags, timestamp }
    reasoning: new Map(), // move# -> reasoning text
    agentCounts: new Map(), // move# -> agents active when the move was made
    tokenCounts: new Map(), // move# -> lead + worker tokens attributed to the move
    tokenUsagePoints: new Map(), // move# -> context chart point
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
    playbackGeneration: 0,
    playbackDeadline: 0,
    playbackPending: false,
    branchPending: false,
    keyboardStepAt: 0,
    suppressCardToggleView: "",
    suppressCardToggleUntil: 0,
    // -1 makes move 0 a real render target instead of waiting for move 1.
    lastRenderedTurn: -1,
    lastImageUrl: null,
    frameRendering: false,
    frameFailures: 0,
    jsonObservationTurn: -1,
    jsonObservationPending: false,
    replayFrameRequest: 0,
    replayFrameTimer: null,
    videoShown: false,
    tokenSignature: "",
    explorationSignature: "",
    initialPlayer: initial.initial_player || null,
    initialBoardStateHash: String(initial.initial_board_state_hash || initial.board_state_hash || ""),
    initialRoom: String(initial.level_id || ""),
    heatmapDirty: true,
    heatmapData: null,
    boardStatePoints: [],
    boardStateMetricBasis: "state",
    boardStateMetricMode: "last-100",
    boardStateCustomWindow: BOARD_STATE_CUSTOM_WINDOW_DEFAULT,
    heatmapExporting: false,
    worldMapSignature: "",
    swarmSignature: "",
    contextPoints: [],
    feedVersion: 0,
    renderedFeedVersion: -1,
    feedQuery: "",
    renderedFeedQuery: "",
    feedRenderLimit: FEED_RENDER_BATCH,
    expandedReasoning: new Set(),
    savedNotes: String(initial.run_notes || ""),
    review: null
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
  const levelId = (value) => {
    const label = levelLabel(value);
    return label ? `level_${label}` : "";
  };

  function fitAsciiBoard() {
    if (!boardEl || !boardWrap || boardWrap.hidden) return;
    const terminalColumns = 64;
    const terminalRows = 64;
    const availableWidth = Math.max(1, boardEl.clientWidth - 44);
    const availableHeight = Math.max(1, boardEl.clientHeight - 64);
    let fontSize = Math.min(13, availableHeight / terminalRows);
    const canvas = fitAsciiBoard.canvas || (fitAsciiBoard.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (context) {
      const terminalFont = '"SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
      context.font = `${fontSize}px ${terminalFont}`;
      const cellWidth = Math.max(1, context.measureText("M").width);
      fontSize *= Math.min(1, availableWidth / (cellWidth * terminalColumns));
    }
    boardEl.style.setProperty("--run-ascii-font-size", `${fontSize}px`);
    boardEl.style.setProperty("--run-ascii-line-height", `${availableHeight / terminalRows}px`);
  }

  function showAsciiBoard(board) {
    if (!board) return;
    boardEl.textContent = board;
    boardWrap.hidden = false;
    requestAnimationFrame(fitAsciiBoard);
  }

  function showJsonObservation(observation, turn = null) {
    if (!observation || !jsonEl || !jsonWrap) return;
    jsonEl.textContent = JSON.stringify(observation, null, 2);
    jsonWrap.hidden = false;
    if (turn != null) state.jsonObservationTurn = Math.max(0, Number(turn) || 0);
  }

  // Chevrons, Play, and Pause from Lucide Icons (ISC License).
  // https://lucide.dev/
  const REPLAY_ICONS = {
    first: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m11 17-5-5 5-5"></path><path d="m18 17-5-5 5-5"></path></svg>',
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="14" y="3" width="5" height="18" rx="1"></rect><rect x="5" y="3" width="5" height="18" rx="1"></rect></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>',
    last: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 17 5-5-5-5"></path><path d="m13 17 5-5-5-5"></path></svg>',
    branch: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="4" r="2"></circle><circle cx="18" cy="6" r="2"></circle><circle cx="6" cy="20" r="2"></circle><path d="M6 6v12"></path><path d="M8 8h4a6 6 0 0 0 6-6"></path></svg>'
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
    return Number.isFinite(rate) ? Math.max(1, Math.min(60, rate)) : 10;
  }

  function replayDelay(viewId) {
    return 1000 / replayRate(viewId);
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
    const playPauseIcons = `<span class="replay-control__icon" data-replay-icon="play"${playing ? " hidden" : ""}>${REPLAY_ICONS.play}</span>
      <span class="replay-control__icon" data-replay-icon="pause"${playing ? "" : " hidden"}>${REPLAY_ICONS.pause}</span>`;
    const branch = viewId === "primary" && state.run.branchable
      ? button(
          "branch",
          `${REPLAY_ICONS.branch}<span>Branch here</span>`,
          `Branch from action ${turn}`,
          false,
          " replay-control--branch"
        )
      : "";
    return `<div class="replay-controls__buttons${active}" data-replay-controls-view="${escapeText(viewId)}" role="group" aria-label="Observation playback">
      ${button("first", REPLAY_ICONS.first, "First observation", turn <= 0)}
      ${button("previous", REPLAY_ICONS.previous, "Previous observation", turn <= 0)}
      ${button("play", playPauseIcons, playing ? "Pause playback" : `Play at ${rate} action${rate === 1 ? "" : "s"} per second`, total <= 0, " replay-control--play")}
      ${button("next", REPLAY_ICONS.next, "Next observation", turn >= total)}
      ${button("last", REPLAY_ICONS.last, "Latest observation", followingLatest)}
      <label class="replay-rate" title="Playback speed">
        <input type="number" min="1" max="60" step="1" value="${rate}" inputmode="numeric" data-replay-rate data-replay-view="${escapeText(viewId)}" aria-label="Playback frames per second">
        <span aria-hidden="true">FPS</span>
      </label>
      <label class="replay-controls__position" title="Go to exact frame">
        <span class="sr-only">Frame</span>
        <input type="number" min="0" max="${total}" step="1" value="${turn}" inputmode="numeric" data-replay-turn data-replay-view="${escapeText(viewId)}" aria-label="Frame number">
        <span aria-hidden="true">/ ${total}</span>
      </label>
      ${branch}
    </div>`;
  }

  function updateReplayControlsInPlace(container, viewId) {
    const controls = container?.querySelector("[data-replay-controls-view]");
    if (!controls || controls.dataset.replayControlsView !== viewId) return false;
    const shouldHaveBranch = viewId === "primary" && Boolean(state.run.branchable);
    const existingBranch = controls.querySelector('[data-replay-action="branch"]');
    if (shouldHaveBranch !== Boolean(existingBranch)) return false;
    const total = replayTotal(viewId);
    const turn = Math.min(total, replayTurn(viewId));
    const playing = state.playingView === viewId;
    const rate = replayRate(viewId);
    const followingLatest = !state.replayCursors.has(viewId) && turn >= total;
    const disabled = {
      first: turn <= 0,
      previous: turn <= 0,
      play: total <= 0,
      next: turn >= total,
      last: followingLatest,
      branch: state.branchPending
    };

    controls.classList.toggle("is-active", state.activeReplay === viewId);
    Object.entries(disabled).forEach(([action, value]) => {
      const control = controls.querySelector(`[data-replay-action="${action}"]`);
      if (control) control.disabled = value;
    });

    const play = controls.querySelector('[data-replay-action="play"]');
    if (play) {
      const label = playing
        ? "Pause playback"
        : `Play at ${rate} action${rate === 1 ? "" : "s"} per second`;
      const playIcon = play.querySelector('[data-replay-icon="play"]');
      const pauseIcon = play.querySelector('[data-replay-icon="pause"]');
      if (playIcon) playIcon.hidden = playing;
      if (pauseIcon) pauseIcon.hidden = !playing;
      play.setAttribute("aria-label", label);
      play.setAttribute("aria-pressed", String(playing));
      play.title = label;
    }

    const rateInput = controls.querySelector("[data-replay-rate]");
    if (rateInput && document.activeElement !== rateInput) rateInput.value = String(rate);
    const positionInput = controls.querySelector("[data-replay-turn]");
    if (positionInput) {
      positionInput.max = String(total);
      if (document.activeElement !== positionInput) positionInput.value = String(turn);
      const suffix = positionInput.nextElementSibling;
      if (suffix) suffix.textContent = `/ ${total}`;
    }
    if (existingBranch) {
      const label = `Branch from action ${turn}`;
      existingBranch.setAttribute("aria-label", label);
      existingBranch.title = label;
    }
    return true;
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
    state.playbackGeneration += 1;
    state.playbackDeadline = 0;
    state.playbackPending = false;
    const previous = state.playingView;
    state.playingView = "";
    if (previous) refreshReplayControls(previous);
    if (previous === "primary") {
      const observation = state.replayObservations.get("primary");
      if (observation && !observation.frame_url) resolveReplayFrame(replayTurn("primary"));
    }
  }

  async function setReplayTurn(viewId, requestedTurn, { playbackGeneration = null } = {}) {
    const total = replayTotal(viewId);
    const turn = Math.max(0, Math.min(total, Math.floor(Number(requestedTurn) || 0)));
    const playbackRequest = playbackGeneration !== null;
    if (!playbackRequest) state.replayCursors.set(viewId, turn);

    const requestId = (state.replayRequests.get(viewId) || 0) + 1;
    state.replayRequests.set(viewId, requestId);
    try {
      const params = new URLSearchParams({ instance: viewId, turn: String(turn) });
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/observation?${params}`);
      if (!response.ok) return null;
      const observation = await response.json();
      if (state.replayRequests.get(viewId) !== requestId) return null;
      if (playbackRequest && !isCurrentPlayback(viewId, playbackGeneration)) return null;
      state.replayCursors.set(viewId, turn);
      state.replayObservations.set(viewId, observation);
      if (viewId === "primary") {
        applyMainObservation(observation);
        updateReplayJumpSelection(turn);
      }
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
    refreshReplayControls(viewId);
  }

  function updateReplayJumpSelection(turn) {
    document.querySelectorAll("[data-jump-turn]").forEach((control) => {
      const selected = Number(control.dataset.jumpTurn) === Number(turn);
      control.classList.toggle("is-current-frame", selected);
      if (selected) control.setAttribute("aria-current", "true");
      else control.removeAttribute("aria-current");
    });
  }

  function jumpToPrimaryFrame(requestedTurn, { scroll = true } = {}) {
    const turn = Math.max(0, Math.min(replayTotal("primary"), Math.floor(Number(requestedTurn) || 0)));
    const previousActive = state.activeReplay;
    stopPlayback();
    state.activeReplay = "primary";
    if (previousActive && previousActive !== "primary") refreshReplayControls(previousActive);
    const pending = setReplayTurn("primary", turn);
    if (scroll) {
      window.requestAnimationFrame(() => {
        liveGrid?.closest(".run-live")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    return pending;
  }

  function isCurrentPlayback(viewId, generation) {
    return state.playingView === viewId && state.playbackGeneration === generation;
  }

  function schedulePlaybackTick(viewId, generation, { fromNow = false } = {}) {
    if (!isCurrentPlayback(viewId, generation)) return;
    const now = performance.now();
    if (fromNow || !state.playbackDeadline) state.playbackDeadline = now;
    state.playbackDeadline += replayDelay(viewId);
    if (state.playbackTimer) clearTimeout(state.playbackTimer);
    state.playbackTimer = setTimeout(() => {
      state.playbackTimer = null;
      void playbackTick(viewId, generation);
    }, Math.max(0, state.playbackDeadline - performance.now()));
  }

  async function playbackTick(viewId, generation) {
    if (!isCurrentPlayback(viewId, generation)) return;
    const total = replayTotal(viewId);
    const current = replayTurn(viewId);
    if (current >= total) {
      stopPlayback();
      return;
    }

    state.playbackPending = true;
    await setReplayTurn(viewId, current + 1, { playbackGeneration: generation });
    if (!isCurrentPlayback(viewId, generation)) return;
    state.playbackPending = false;
    schedulePlaybackTick(viewId, generation);
  }

  async function startPlayback(viewId) {
    if (state.playingView === viewId) {
      stopPlayback();
      return;
    }
    stopPlayback();
    if (viewId === "primary") cancelReplayFrameResolution();
    state.activeReplay = viewId;
    state.playingView = viewId;
    const generation = state.playbackGeneration;
    state.playbackPending = true;
    refreshReplayControls(viewId);
    if (replayTurn(viewId) >= replayTotal(viewId)) {
      await setReplayTurn(viewId, 0, { playbackGeneration: generation });
    }
    if (!isCurrentPlayback(viewId, generation)) return;
    state.playbackPending = false;
    state.playbackDeadline = performance.now();
    schedulePlaybackTick(viewId, generation);
  }

  async function branchFromTurn(turn) {
    if (state.branchPending) return;
    state.branchPending = true;
    refreshReplayControls("primary");
    try {
      setStatus(`Creating a new run from action ${turn}…`);
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turn })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
      window.location.href = payload.run.url;
    } catch (error) {
      state.branchPending = false;
      refreshReplayControls("primary");
      setStatus(error.message, true);
    }
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
    else if (action === "branch" && viewId === "primary") void branchFromTurn(current);
    refreshReplayControls(viewId);
  }

  function wireReplayControls(container) {
    container?.querySelectorAll("[data-replay-action]").forEach((control) => {
      const activate = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const viewId = control.dataset.replayView || "primary";
        if (control.closest(".run-swarm-card") && event.type === "pointerdown") {
          state.suppressCardToggleView = viewId;
          state.suppressCardToggleUntil = Date.now() + 750;
        }
        handleReplayAction(viewId, control.dataset.replayAction || "");
      };
      control.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        control.dataset.replayPointerPending = "true";
        activate(event);
      });
      control.addEventListener("keydown", (event) => {
        if ((event.key !== "Enter" && event.key !== " ") || event.repeat) return;
        control.dataset.replayKeyboardPending = "true";
        activate(event);
        window.setTimeout(() => {
          delete control.dataset.replayKeyboardPending;
        }, 0);
      });
      control.addEventListener("click", (event) => {
        const pointerActivated = control.dataset.replayPointerPending === "true";
        const keyboardActivated = control.dataset.replayKeyboardPending === "true";
        delete control.dataset.replayPointerPending;
        delete control.dataset.replayKeyboardPending;
        // Pointer and keyboard activation already ran on their earliest reliable
        // events. Programmatic/assistive clicks without either path still work.
        if (!pointerActivated && !keyboardActivated) activate(event);
        else {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    });
    container?.querySelectorAll("[data-replay-rate]").forEach((control) => {
      control.addEventListener("pointerdown", (event) => event.stopPropagation());
      control.addEventListener("click", (event) => event.stopPropagation());
      const updateRate = (event, commit = false) => {
        event.stopPropagation();
        const viewId = control.dataset.replayView || "primary";
        const requestedRate = Number(control.value);
        if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
          if (commit) control.value = String(replayRate(viewId));
          return;
        }
        const rate = Math.max(1, Math.min(60, requestedRate));
        state.replayRates.set(viewId, rate);
        if (commit) control.value = String(rate);
        if (state.playingView === viewId) {
          state.playbackDeadline = 0;
          if (!state.playbackPending) {
            schedulePlaybackTick(viewId, state.playbackGeneration, { fromNow: true });
          }
        }
        updateReplayControlsInPlace(control.closest(".replay-controls"), viewId);
      };
      control.addEventListener("input", (event) => updateRate(event));
      control.addEventListener("change", (event) => updateRate(event, true));
      control.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") control.blur();
      });
    });
    container?.querySelectorAll("[data-replay-turn]").forEach((control) => {
      const viewId = control.dataset.replayView || "primary";
      const reset = () => {
        control.value = String(replayTurn(viewId));
      };
      const commit = () => {
        const requested = Number(control.value);
        if (!Number.isFinite(requested)) {
          reset();
          return;
        }
        const turn = Math.max(0, Math.min(replayTotal(viewId), Math.floor(requested)));
        control.value = String(turn);
        stopPlayback();
        state.activeReplay = viewId;
        void setReplayTurn(viewId, turn);
      };
      control.addEventListener("pointerdown", (event) => event.stopPropagation());
      control.addEventListener("click", (event) => event.stopPropagation());
      control.addEventListener("change", (event) => {
        event.stopPropagation();
        commit();
      });
      control.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          control.select();
        } else if (event.key === "Escape") {
          event.preventDefault();
          reset();
          control.blur();
        }
      });
    });
  }

  function renderMainReplayControls() {
    if (!mainReplayControls) return;
    if (!updateReplayControlsInPlace(mainReplayControls, "primary")) {
      mainReplayControls.innerHTML = replayControlsMarkup("primary");
      wireReplayControls(mainReplayControls);
      updateReplayControlsInPlace(mainReplayControls, "primary");
    }
  }

  function instanceCards(workers) {
    return workers.map((worker) => {
      const history = state.replayCursors.has(worker.id) ? state.replayObservations.get(worker.id) : null;
      const displayed = history
        ? {
            ...worker,
            board: history.board,
            json_observation: history.json_observation,
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
          : `<pre class="run-swarm-card__text" aria-label="${escapeText(worker.id)} exact ${displayed.observation_mode === "json" ? "JSON" : "text"} observation">${escapeText(displayed.observation_mode === "json" && displayed.json_observation ? JSON.stringify(displayed.json_observation, null, 2) : displayed.board || "Waiting for observation…")}</pre>`;
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
    wireReplayControls(container);
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

  function configuredValue(params, key, fallback) {
    return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : fallback;
  }

  function configuredFlag(params, key, fallback = false) {
    const value = configuredValue(params, key, fallback);
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function runConfiguration(run) {
    const params = run.launch_params && typeof run.launch_params === "object" ? run.launch_params : {};
    const prime = run.kind === "prime" || run.model === "prime";
    const unlimited = configuredFlag(params, "unlimited", run.unlimited);
    const moves = prime
      ? configuredValue(params, "max_turns", run.moves)
      : configuredValue(params, "moves", run.moves);
    const budgetLabel = run.branch_of && !unlimited
      ? `${moves || "Default"} more move${Number(moves) === 1 ? "" : "s"}`
      : unlimited
        ? "Unlimited"
        : moves
          ? `${moves} moves`
          : "Default";
    const observationMode = String(
      configuredValue(
        params,
        "mode",
        prime && configuredFlag(params, "vision", run.mode === "vision") ? "vision" : run.mode || "text"
      )
    );
    const observation = observationMode === "text" ? "ASCII" : titleCase(observationMode);
    const allowQuit = configuredFlag(params, "allow_quit", run.allow_quit !== false);
    const autoQuit = configuredFlag(params, "auto_quit", run.auto_quit);
    const autoQuitThreshold = Number(configuredValue(params, "auto_quit_threshold", run.auto_quit_threshold ?? 10));
    const autoQuitMode = String(configuredValue(params, "auto_quit_mode", run.auto_quit_mode || "rolling"));
    const autoQuitWindow = Number(configuredValue(params, "auto_quit_window", run.auto_quit_window || 100));
    const reasoning = configuredValue(params, "reasoning", run.reasoning || "");
    const harnessConfig = configuredValue(params, "harness_config", run.harness_config || {});
    const items = [
      ["Provider", prime ? "Prime" : titleCase(run.model)],
      ...(prime ? [["Harness", run.harness_label || titleCase(run.harness || "Prime Intellect")]] : []),
      ...(prime && harnessConfig?.version ? [["Harness version", String(harnessConfig.version)]] : []),
      ["Model", configuredValue(params, "model_name", run.model_name || run.model)],
      ["World", run.game_title || run.game_id],
      ["Start room", levelLabel(configuredValue(params, "level_id", run.level_id))],
      ...(run.branch_of ? [["Branch point", `Action ${run.branch_turn}`]] : []),
      ["Budget", budgetLabel],
      ["Observation", observation, observation === "Vision"],
      ["Reasoning", reasoning ? titleCase(reasoning) : "Off"],
      ["Allow model to give up", allowQuit ? "Yes" : "No"],
      ["Auto-Quit", autoQuit ? "Yes" : "No", autoQuit],
      ...(autoQuit ? [["Auto-Quit rule",
        `${autoQuitThreshold}% new or less · ${autoQuitMode === "rolling" ? `last ${autoQuitWindow} moves` : "cumulative"}`,
        true
      ]] : [])
    ];

    if (["ascii", "json"].includes(String(observation).toLowerCase())) {
      const omniscient = configuredFlag(params, "omniscient", run.omniscient);
      const hideNames = configuredFlag(params, "hide_names", run.hide_names);
      if (String(observation).toLowerCase() === "json") {
        items.push(["JSON visibility", omniscient ? "Omniscient" : "Visible only", omniscient]);
      }
      items.push([observation === "ASCII" ? "Glyph identities" : "Object names", hideNames ? "Hidden" : "Literal", hideNames]);
      const hideNamesSeed = String(configuredValue(params, "hide_names_seed", run.hide_names_seed || "")).trim();
      if (hideNames && hideNamesSeed) items.push(["Identity seed", hideNamesSeed]);
    }

    if (!prime) {
      if (run.model === "codex" && Object.prototype.hasOwnProperty.call(params, "codex_fast")) {
        const fast = configuredFlag(params, "codex_fast");
        items.push(["Fast mode", fast ? "On" : "Off", fast]);
      }
      const container = configuredFlag(params, "container", run.container !== false);
      const toolUse = String(configuredValue(params, "tool_use", run.tool_use || "read-only"));
      const swarm = configuredFlag(params, "swarm", run.swarm);
      items.push(
        ["Isolation", container ? "Docker" : "Host access"],
        ["Tool use", toolUse === "offline" ? "[CLI] Tools" : "No Tools"],
        ["Orchestration", swarm ? "Swarm" : "Single", swarm]
      );
    } else if (run.prime_execution) {
      items.push(["Execution", run.prime_execution === "hosted" ? "Hosted" : "Local"]);
    }

    return items.filter(([, value]) => value !== "" && value != null);
  }

  function describeRun(run) {
    document.getElementById("run-title").textContent =
      `${run.model}${run.model_name ? ` (${run.model_name})` : ""} on ${run.game_title || run.game_id}`;
    const meta = document.getElementById("run-meta");
    meta.className = "run-config";
    meta.setAttribute("aria-label", "Launch configuration");
    meta.innerHTML = `<span class="run-config__list" role="list">
        ${runConfiguration(run).map(([label, value, active]) => `<span class="run-config__item${active ? " is-active" : ""}" role="listitem">
          <span class="run-config__key">${escapeText(label)}</span>
          <strong class="run-config__value">${escapeText(value)}</strong>
        </span>`).join("")}
      </span>`;
  }

  function renderStats(run) {
    const statusLabel = run.auto_quit_triggered
      ? run.status === "stopping" ? "auto-quitting" : "auto-quit"
      : run.status === "finished" ? (run.complete ? "complete" : "ended") : run.status;
    const chips = isPrime
      ? [
          ["status", statusLabel],
          ["turn budget", run.unlimited ? "∞" : String(run.moves ?? "")],
          run.prime_evaluation_status ? ["Prime", String(run.prime_evaluation_status).toLowerCase()] : null,
          run.prime_evaluation_score != null ? ["score", String(run.prime_evaluation_score)] : null,
          run.turns ? ["moves", String(run.turns)] : null,
          run.turns ? ["gems", String(run.gem_count ?? 0)] : null,
          run.solved ? ["result", "SOLVED"] : run.auto_quit_triggered ? ["result", "AUTO-QUIT"] : null
        ].filter(Boolean)
      : [
          ["status", statusLabel],
          ["moves", `${run.turns}/${run.unlimited ? "∞" : run.moves}`],
          ["gems", String(run.gem_count ?? 0)],
          ["room", levelLabel(run.current_room)],
          run.solved ? ["result", "SOLVED"] : run.auto_quit_triggered ? ["result", "AUTO-QUIT"] : null
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
    const inference = run.inference && typeof run.inference === "object" ? run.inference : null;
    const inferenceAction = Math.max(1, Number(inference?.action) || current + 1);
    const inferenceElapsed = Math.max(0, Number(inference?.elapsed_ms) || 0);
    const etaLabel =
      run.status === "waiting"
        ? "Waiting"
        : run.status === "finished"
        ? run.auto_quit_triggered
          ? `Auto-quit at ${Number(run.auto_quit_percentage).toFixed(1)}% new states`
          : run.complete
            ? "Complete"
            : "Ended"
        : run.status === "paused"
          ? "Paused"
          : run.status === "pausing"
            ? "Pausing…"
          : run.status === "stopping"
            ? run.auto_quit_triggered ? "Auto-quitting…" : "Stopping…"
            : run.status === "stopped"
              ? "Stopped"
              : run.status === "failed"
                ? "Failed"
                : inference?.state === "in_flight"
                  ? `Model request ${inferenceAction} in flight · ${formatDuration(inferenceElapsed)}`
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
    if (primeSyncButton) {
      const syncing = run.prime_evaluation_sync_status === "syncing";
      primeSyncButton.hidden = run.prime_evaluation_sync_status === "synced" || !run.prime_evaluation_syncable;
      primeSyncButton.disabled = syncing;
      primeSyncButton.textContent = syncing
        ? "Syncing to Prime…"
        : run.prime_evaluation_sync_status === "failed"
          ? "Retry Prime sync"
          : "Sync to Prime";
      primeSyncButton.title = run.prime_evaluation_sync_error || "Upload this evaluation to the Prime dashboard";
    }
    pauseButton.hidden = !run.pausable;
    resumeButton.hidden = !run.resumable;
    continueButton.hidden = !run.continuable;
    const renderingVideo = run.video_status === "rendering";
    const canGenerateVideo = ["paused", "finished", "stopped"].includes(run.status) && !run.has_video;
    generateVideoButton.disabled = renderingVideo;
    generateVideoButton.hidden = !canGenerateVideo && !renderingVideo;
    generateVideoButton.classList.toggle("is-rendering", renderingVideo);
    const generateLabel = generateVideoButton.querySelector("span");
    if (generateLabel) generateLabel.textContent = renderingVideo ? "Generating…" : "Generate replay";
    cancelVideoButton.hidden = !renderingVideo;
    cancelVideoButton.disabled = false;
    regenerateVideoButton.hidden = !run.has_video || renderingVideo;
    regenerateVideoButton.disabled = renderingVideo;
  }

  function formatTokens(value) {
    const tokens = Number(value);
    if (!Number.isFinite(tokens)) return "—";
    const unit = [
      [1_000_000_000_000, "T"],
      [1_000_000_000, "B"],
      [1_000_000, "M"],
      [1_000, "K"]
    ].find(([threshold]) => Math.abs(tokens) >= threshold);
    if (!unit) return Math.round(tokens).toLocaleString();
    const scaled = Math.round((tokens / unit[0]) * 10) / 10;
    return `${scaled.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit[1]}`;
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
      const context = Number(point.context_tokens) || 0;
      if (context > 0) {
        state.tokenUsagePoints.set(action, {
          action,
          context,
          compacted: Boolean(point.compacted)
        });
      }
    });
    state.swarmAgents = {
      running: Math.max(0, Math.floor(Number(usage?.agents_running) || 0)),
      ran: Math.max(0, Math.floor(Number(usage?.agents_ran) || 0))
    };
    if (agentCountsChanged) state.feedVersion += 1;

    const available = Boolean(usage?.available);
    document.getElementById("run-token-total").textContent = available ? formatTokens(usage.total_tokens) : "—";
    document.getElementById("run-token-input").textContent = available ? formatTokens(usage.input_tokens) : "—";
    document.getElementById("run-token-output").textContent = available ? formatTokens(usage.output_tokens) : "—";
    const inputDetail = document.getElementById("run-token-input-detail");
    const inputParts = [
      usage?.cache_read_input_tokens ? `${formatTokens(usage.cache_read_input_tokens)} cache reads` : "",
      usage?.cache_creation_input_tokens ? `${formatTokens(usage.cache_creation_input_tokens)} cache writes` : "",
      usage?.uncached_input_tokens ? `${formatTokens(usage.uncached_input_tokens)} new` : ""
    ].filter(Boolean);
    inputDetail.textContent = inputParts.join(" · ");

    const cost = Number(usage?.api_cost_estimate_usd);
    document.getElementById("run-token-cost").textContent = Number.isFinite(cost) && cost >= 0
      ? cost.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "—";
    const costDetail = document.getElementById("run-token-cost-detail");
    const pricing = usage?.api_pricing;
    costDetail.textContent = pricing
      ? `$${pricing.input}/M new · $${pricing.cache_read}/M reads · $${pricing.cache_write_1h}/M 1h writes · $${pricing.output}/M out`
      : cost ? "Provider-reported API-equivalent cost" : "Pricing unavailable";
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

    const points = [...state.tokenUsagePoints.values()].sort((left, right) => left.action - right.action);
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

  function drawMetricChart(canvas, points, key, color) {
    if (!canvas || !points.length) return;
    const width = Math.max(280, Math.floor(canvas.clientWidth));
    const height = Math.max(170, Math.floor(canvas.clientHeight));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padding = { top: 15, right: 14, bottom: 28, left: 42 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const firstAction = points[0].action;
    const lastAction = points[points.length - 1].action;
    const minimum = key === "rooms" ? 1 : 0;
    const maxValue = Math.max(1, ...points.map((point) => point[key]));
    const rawCeiling = maxValue <= 4 ? maxValue : Math.ceil(maxValue * 1.05);
    const ceiling = Math.max(minimum + 1, rawCeiling);
    const valueRange = ceiling - minimum;
    const tickCount = Math.min(4, Math.max(1, valueRange));
    const x = (action) => padding.left + (lastAction === firstAction
      ? plotWidth / 2
      : ((action - firstAction) / (lastAction - firstAction)) * plotWidth);
    const y = (value) => padding.top + plotHeight -
      ((Math.max(minimum, value) - minimum) / valueRange) * plotHeight;

    context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    for (let index = 0; index <= tickCount; index += 1) {
      const lineY = padding.top + (plotHeight / tickCount) * index;
      context.strokeStyle = "rgba(124, 143, 255, 0.11)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.fillStyle = "rgba(154, 163, 199, 0.76)";
      context.textAlign = "right";
      context.fillText(
        String(Math.round(ceiling - valueRange * (index / tickCount))),
        padding.left - 8,
        lineY
      );
    }

    const fill = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
    fill.addColorStop(0, `${color}33`);
    fill.addColorStop(1, `${color}00`);
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(point.action), y(point[key]));
      else context.lineTo(x(point.action), y(point[key]));
    });
    context.lineTo(x(lastAction), padding.top + plotHeight);
    context.lineTo(x(firstAction), padding.top + plotHeight);
    context.closePath();
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(point.action), y(point[key]));
      else context.lineTo(x(point.action), y(point[key]));
    });
    context.strokeStyle = color;
    context.lineWidth = 2.25;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.shadowColor = `${color}66`;
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;

    const latest = points[points.length - 1];
    context.beginPath();
    context.arc(x(latest.action), y(latest[key]), 1.75, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();

    const jumpTargets = [];
    let previousValue = key === "rooms" ? 1 : 0;
    points.forEach((point) => {
      const value = Number(point[key]) || 0;
      if (value !== previousValue) {
        jumpTargets.push({ action: point.action, value, x: x(point.action), y: y(value) });
      }
      previousValue = value;
    });
    jumpTargets.forEach((target) => {
      context.beginPath();
      context.arc(target.x, target.y, 1.75, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
    });
    canvas._replayJumpTargets = jumpTargets;
    canvas.dataset.metricKey = key;
    canvas.dataset.jumpSummary = jumpTargets.length
      ? `Click a highlighted change to show its exact frame (${jumpTargets.length} change${jumpTargets.length === 1 ? "" : "s"})`
      : `No ${key} changes yet`;

    const actionLabels = [...new Set([firstAction, Math.round((firstAction + lastAction) / 2), lastAction])];
    context.fillStyle = "rgba(154, 163, 199, 0.76)";
    context.textBaseline = "alphabetic";
    actionLabels.forEach((action, index) => {
      context.textAlign = index === 0 ? "left" : index === actionLabels.length - 1 ? "right" : "center";
      context.fillText(String(action), x(action), height - 7);
    });
  }

  function explorationPoints() {
    const startingRoom = levelLabel(state.run?.level_id);
    const visitedRooms = new Set(startingRoom ? [startingRoom] : []);
    return [...state.moves.entries()]
      .sort(([left], [right]) => left - right)
      .map(([action, move]) => {
        if (move.room) visitedRooms.add(move.room);
        return {
          action: Number(action),
          rooms: visitedRooms.size,
          gems: Math.max(0, Number(move.gems) || 0)
        };
      });
  }

  function boardStateWindowSize(value) {
    return Math.min(
      BOARD_STATE_CUSTOM_WINDOW_MAX,
      Math.max(1, Math.round(Number(value) || BOARD_STATE_CUSTOM_WINDOW_DEFAULT))
    );
  }

  function boardStateMetricSettings() {
    if (state.boardStateMetricMode === "cumulative") {
      return { basis: state.boardStateMetricBasis, mode: "cumulative", windowLimit: null };
    }
    return {
      basis: state.boardStateMetricBasis,
      mode: "rolling",
      windowLimit: state.boardStateMetricMode === "last-n"
        ? boardStateWindowSize(state.boardStateCustomWindow)
        : BOARD_STATE_NOVELTY_WINDOW
    };
  }

  function playerWorldPositionKey(player, roomValue) {
    const position = heatmapPosition(player);
    if (!position) return "";
    const roomId = levelId(roomValue) || state.initialRoom;
    const mapped = runWorldMapLevels().find((level) => level.id === roomId);
    const match = levelLabel(roomId).match(/^([A-Z])x([A-Z])$/i);
    const columnIndex = mapped?.columnIndex ?? worldAxisIndex(match?.[1]);
    const rowIndex = mapped?.rowIndex ?? worldAxisIndex(match?.[2]);
    const elevation = Number.isFinite(position.elevation) ? position.elevation : 0;
    return columnIndex >= 0 && rowIndex >= 0
      ? `${columnIndex * 16 + position.x},${rowIndex * 16 + position.y},${elevation}`
      : `${roomId}:${position.x},${position.y},${elevation}`;
  }

  function isCameraRotationCommand(value) {
    const command = String(value || "")
      .trim()
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\s+/g, " ");
    return command === "rotate camera" || /^rotate camera (?:up|down|left|right)$/.test(command);
  }

  function boardStateNoveltyPoints() {
    const settings = boardStateMetricSettings();
    const timeline = [];
    [...state.moves.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .forEach(([action, move]) => {
        if (isCameraRotationCommand(move.action)) return;
        const key = settings.basis === "position"
          ? playerWorldPositionKey(move.player, move.roomId || move.room)
          : move.boardStateHash;
        if (key) timeline.push({ action: Number(action), key });
      });

    const seen = new Set();
    const points = [];
    let cumulativeNovel = 0;
    let cumulativeTotal = 0;
    const initialKey = settings.basis === "position"
      ? playerWorldPositionKey(state.initialPlayer, state.initialRoom)
      : state.initialBoardStateHash;
    if (initialKey) {
      seen.add(initialKey);
      cumulativeNovel = 1;
      cumulativeTotal = 1;
      if (settings.mode === "cumulative") {
        points.push({
          action: 0,
          basis: settings.basis,
          duplicate: false,
          mode: settings.mode,
          novel: cumulativeNovel,
          percentage: 100,
          repeats: 0,
          windowSize: cumulativeTotal
        });
      }
    }
    const noveltyWindow = [];
    let novelInWindow = 0;
    timeline.forEach((entry) => {
      const duplicate = seen.has(entry.key);
      seen.add(entry.key);
      const novel = duplicate ? 0 : 1;
      cumulativeNovel += novel;
      cumulativeTotal += 1;

      if (settings.mode === "cumulative") {
        points.push({
          action: entry.action,
          basis: settings.basis,
          duplicate,
          mode: settings.mode,
          novel: cumulativeNovel,
          percentage: cumulativeNovel / cumulativeTotal * 100,
          repeats: cumulativeTotal - cumulativeNovel,
          windowSize: cumulativeTotal
        });
        return;
      }

      noveltyWindow.push(novel);
      novelInWindow += novel;
      if (noveltyWindow.length > settings.windowLimit) {
        novelInWindow -= noveltyWindow.shift();
      }
      const windowSize = noveltyWindow.length;
      points.push({
        action: entry.action,
        basis: settings.basis,
        duplicate,
        mode: settings.mode,
        novel: novelInWindow,
        percentage: novelInWindow / windowSize * 100,
        repeats: windowSize - novelInWindow,
        windowSize
      });
    });
    return points;
  }

  function drawBoardStateChart() {
    const points = state.boardStatePoints;
    if (!boardStateCanvas || !points.length || boardStateChart?.hidden) return;
    const width = Math.max(280, Math.floor(boardStateCanvas.clientWidth));
    const height = Math.max(170, Math.floor(boardStateCanvas.clientHeight));
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    boardStateCanvas.width = Math.floor(width * ratio);
    boardStateCanvas.height = Math.floor(height * ratio);
    const context = boardStateCanvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padding = { top: 15, right: 15, bottom: 28, left: 48 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const firstAction = points[0].action;
    const lastAction = points[points.length - 1].action;
    const minimumPercentage = Math.min(...points.map((point) => point.percentage));
    const floor = Math.max(0, Math.min(90, Math.floor((minimumPercentage - 5) / 10) * 10));
    const range = Math.max(10, 100 - floor);
    const x = (action) => padding.left + (lastAction === firstAction
      ? plotWidth / 2
      : ((action - firstAction) / (lastAction - firstAction)) * plotWidth);
    const y = (percentage) => padding.top + plotHeight - ((percentage - floor) / range) * plotHeight;

    context.font = "9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const percentage = 100 - range * (index / 4);
      const lineY = padding.top + plotHeight * (index / 4);
      context.strokeStyle = "rgba(124, 143, 255, 0.11)";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(padding.left, lineY);
      context.lineTo(width - padding.right, lineY);
      context.stroke();
      context.fillStyle = "rgba(154, 163, 199, 0.76)";
      context.textAlign = "right";
      context.fillText(`${Math.round(percentage)}%`, padding.left - 8, lineY);
    }

    const fill = context.createLinearGradient(0, padding.top, 0, padding.top + plotHeight);
    fill.addColorStop(0, "rgba(101, 243, 212, 0.22)");
    fill.addColorStop(1, "rgba(101, 243, 212, 0)");
    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(point.action), y(point.percentage));
      else context.lineTo(x(point.action), y(point.percentage));
    });
    context.lineTo(x(lastAction), padding.top + plotHeight);
    context.lineTo(x(firstAction), padding.top + plotHeight);
    context.closePath();
    context.fillStyle = fill;
    context.fill();

    context.beginPath();
    points.forEach((point, index) => {
      if (index === 0) context.moveTo(x(point.action), y(point.percentage));
      else context.lineTo(x(point.action), y(point.percentage));
    });
    context.strokeStyle = "#65f3d4";
    context.lineWidth = 2.25;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = "rgba(101, 243, 212, 0.34)";
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;

    const targets = points.map((point) => ({
      ...point,
      x: x(point.action),
      y: y(point.percentage)
    }));
    boardStateCanvas._replayJumpTargets = targets;

    const actionLabels = [...new Set([firstAction, Math.round((firstAction + lastAction) / 2), lastAction])];
    context.fillStyle = "rgba(154, 163, 199, 0.76)";
    context.textBaseline = "alphabetic";
    actionLabels.forEach((action, index) => {
      context.textAlign = index === 0 ? "left" : index === actionLabels.length - 1 ? "right" : "center";
      context.fillText(String(action), x(action), height - 7);
    });
  }

  function renderBoardStateChart() {
    if (!boardStateChart || !boardStateCanvas || !boardStateLatest) return;
    const settings = boardStateMetricSettings();
    const points = boardStateNoveltyPoints();
    state.boardStatePoints = points;
    boardStateChart.hidden = points.length === 0;
    if (!points.length) return;
    const latest = points[points.length - 1];
    const subject = settings.basis === "position" ? "player world positions" : "board states";
    boardStateLatest.textContent = `${latest.percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    if (boardStateDescription) {
      boardStateDescription.textContent = settings.mode === "cumulative"
        ? `All observed ${subject} from the start of the run; camera angle excluded.`
        : `Globally new ${subject} among the latest ${settings.windowLimit.toLocaleString()} moves; camera angle excluded.`;
    }
    boardStateCanvas.setAttribute(
      "aria-label",
      settings.mode === "cumulative"
        ? `${latest.percentage.toFixed(1)} percent cumulative ${subject} novelty after action ${latest.action}; ${latest.novel} unique and ${latest.repeats} repeat observations among ${latest.windowSize} total observations`
        : `${latest.percentage.toFixed(1)} percent ${subject} novelty over the last ${latest.windowSize} moves after action ${latest.action}; ${latest.novel} globally new and ${latest.repeats} repeat observations in the window`
    );
    requestAnimationFrame(drawBoardStateChart);
  }

  function heatmapPosition(player) {
    const x = Number(player?.x);
    const y = Number(player?.y);
    const elevation = Number(player?.elevation);
    return Number.isFinite(x) && Number.isFinite(y)
      ? {
          x: Math.round(x),
          y: Math.round(y),
          elevation: Number.isFinite(elevation) ? elevation : 0
        }
      : null;
  }

  function heatmapVisitData() {
    const roomSize = 16;
    const roomVisits = new Map();
    const counts = [];
    let totalVisits = 0;
    const add = (player, roomValue) => {
      const position = heatmapPosition(player);
      if (!position) return;
      if (position.x < 0 || position.x >= roomSize || position.y < 0 || position.y >= roomSize) return;
      const room = levelId(roomValue) || state.initialRoom;
      if (!room) return;
      if (!roomVisits.has(room)) roomVisits.set(room, new Map());
      const visits = roomVisits.get(room);
      const key = `${position.x},${position.y}`;
      visits.set(key, (visits.get(key) || 0) + 1);
      totalVisits += 1;
    };
    add(state.initialPlayer, state.initialRoom);
    state.moves.forEach((move) => add(move.player, move.roomId || move.room));
    if (!roomVisits.size) return null;

    const worldLevels = new Map(runWorldMapLevels().map((level) => [level.id, level]));
    const rooms = [...roomVisits.entries()].flatMap(([id, visits]) => {
      const label = levelLabel(id);
      const mapped = worldLevels.get(id);
      const match = label.match(/^([A-Z])x([A-Z])$/i);
      const columnIndex = mapped?.columnIndex ?? worldAxisIndex(match?.[1]);
      const rowIndex = mapped?.rowIndex ?? worldAxisIndex(match?.[2]);
      if (columnIndex < 0 || rowIndex < 0) return [];
      const roomCounts = [...visits.values()];
      counts.push(...roomCounts);
      return [{
        id,
        label,
        columnIndex,
        rowIndex,
        visits,
        totalVisits: roomCounts.reduce((sum, count) => sum + count, 0),
        uniqueCells: visits.size
      }];
    });
    if (!rooms.length) return null;
    const minRoomColumn = Math.min(...rooms.map((room) => room.columnIndex));
    const maxRoomColumn = Math.max(...rooms.map((room) => room.columnIndex));
    const minRoomRow = Math.min(...rooms.map((room) => room.rowIndex));
    const maxRoomRow = Math.max(...rooms.map((room) => room.rowIndex));
    const visits = new Map();
    rooms.forEach((room) => {
      room.visits.forEach((count, key) => {
        const [x, y] = key.split(",").map(Number);
        visits.set(`${room.columnIndex * roomSize + x},${room.rowIndex * roomSize + y}`, count);
      });
    });
    return {
      rooms,
      roomsById: new Map(rooms.map((room) => [room.id, room])),
      roomsByPosition: new Map(rooms.map((room) => [`${room.columnIndex},${room.rowIndex}`, room])),
      roomSize,
      visits,
      totalVisits,
      uniqueCells: rooms.reduce((sum, room) => sum + room.uniqueCells, 0),
      maxCount: Math.max(...counts),
      minCount: Math.min(...counts),
      minRoomColumn,
      maxRoomColumn,
      minRoomRow,
      maxRoomRow,
      minX: minRoomColumn * roomSize,
      maxX: (maxRoomColumn + 1) * roomSize - 1,
      minY: minRoomRow * roomSize,
      maxY: (maxRoomRow + 1) * roomSize - 1,
      columns: (maxRoomColumn - minRoomColumn + 1) * roomSize,
      rows: (maxRoomRow - minRoomRow + 1) * roomSize
    };
  }

  function heatmapVisitSequence(data) {
    if (!data) return [];
    const sequence = [];
    const add = (player, roomValue) => {
      const position = heatmapPosition(player);
      if (!position || position.x < 0 || position.x >= data.roomSize || position.y < 0 || position.y >= data.roomSize) return;
      const room = data.roomsById.get(levelId(roomValue) || state.initialRoom);
      if (!room) return;
      sequence.push({
        x: room.columnIndex * data.roomSize + position.x,
        y: room.rowIndex * data.roomSize + position.y
      });
    };
    add(state.initialPlayer, state.initialRoom);
    [...state.moves.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .forEach(([, move]) => add(move.player, move.roomId || move.room));
    return sequence;
  }

  function heatmapColor(intensity) {
    const stops = [
      [0, [255, 216, 77]],
      [0.34, [255, 151, 45]],
      [0.67, [239, 62, 84]],
      [1, [139, 76, 220]]
    ];
    const value = Math.max(0, Math.min(1, intensity));
    const upperIndex = stops.findIndex(([stop]) => stop >= value);
    if (upperIndex <= 0) return `rgb(${stops[0][1].join(", ")})`;
    const [lowerStop, lowerColor] = stops[upperIndex - 1];
    const [upperStop, upperColor] = stops[upperIndex];
    const amount = (value - lowerStop) / (upperStop - lowerStop);
    const color = lowerColor.map((channel, index) => Math.round(channel + (upperColor[index] - channel) * amount));
    return `rgb(${color.join(", ")})`;
  }

  function paintHeatmap(context, data, width, height, visits = data.visits, theme = {}) {
    context.clearRect(0, 0, width, height);
    context.fillStyle = theme.background || "#070a16";
    context.fillRect(0, 0, width, height);

    const cellWidth = width / data.columns;
    const cellHeight = height / data.rows;
    const gap = Math.min(1.25, Math.min(cellWidth, cellHeight) * 0.08);
    const low = Math.log1p(data.minCount);
    const range = Math.log1p(data.maxCount) - low;
    for (let y = data.minY; y <= data.maxY; y += 1) {
      for (let x = data.minX; x <= data.maxX; x += 1) {
        const count = visits.get(`${x},${y}`) || 0;
        const left = (x - data.minX) * cellWidth + gap;
        const top = (y - data.minY) * cellHeight + gap;
        context.fillStyle = count
          ? heatmapColor(range > 0 ? (Math.log1p(count) - low) / range : 0)
          : theme.empty || "rgba(21, 26, 51, 0.72)";
        context.fillRect(left, top, Math.max(0.5, cellWidth - gap * 2), Math.max(0.5, cellHeight - gap * 2));
      }
    }

    context.strokeStyle = theme.grid || "rgba(124, 143, 255, 0.52)";
    context.lineWidth = Math.max(1, Math.min(2, Math.min(cellWidth, cellHeight) * 0.08));
    context.beginPath();
    for (let column = data.minRoomColumn; column <= data.maxRoomColumn + 1; column += 1) {
      const x = (column - data.minRoomColumn) * data.roomSize * cellWidth;
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    for (let row = data.minRoomRow; row <= data.maxRoomRow + 1; row += 1) {
      const y = (row - data.minRoomRow) * data.roomSize * cellHeight;
      context.moveTo(0, y);
      context.lineTo(width, y);
    }
    context.stroke();
  }

  function drawHeatmap() {
    const data = state.heatmapData;
    if (!heatmapCanvas || !heatmapViewport || !data || heatmapViewport.hidden) return;
    const availableWidth = Math.max(1, heatmapViewport.clientWidth - 28);
    const cellSize = Math.max(1, Math.min(40, availableWidth / data.columns, 720 / data.rows));
    const width = Math.max(1, Math.floor(cellSize * data.columns));
    const height = Math.max(1, Math.floor(cellSize * data.rows));
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    heatmapCanvas.style.width = `${width}px`;
    heatmapCanvas.style.height = `${height}px`;
    heatmapCanvas.width = Math.max(1, Math.round(width * pixelRatio));
    heatmapCanvas.height = Math.max(1, Math.round(height * pixelRatio));

    const context = heatmapCanvas.getContext("2d");
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    paintHeatmap(context, data, width, height);
  }

  function heatmapExportSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function heatmapMp4MimeType() {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
    return [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4;codecs=avc1.42001f",
      "video/mp4"
    ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function heatmapMp4Supported() {
    return Boolean(heatmapMp4MimeType()) && typeof heatmapCanvas?.captureStream === "function";
  }

  function selectedHeatmapExportFormat() {
    return heatmapExportFormat?.value === "mp4" ? "mp4" : "gif";
  }

  function updateHeatmapExportControl() {
    if (!heatmapExportButton) return;
    const mp4Option = heatmapExportFormat?.querySelector('option[value="mp4"]');
    const mp4Supported = heatmapMp4Supported();
    if (mp4Option) mp4Option.disabled = !mp4Supported;
    if (!mp4Supported && heatmapExportFormat?.value === "mp4") heatmapExportFormat.value = "gif";
    const format = selectedHeatmapExportFormat();
    if (!state.heatmapExporting) heatmapExportButton.textContent = `Export ${format.toUpperCase()}`;
    heatmapExportButton.disabled = state.heatmapExporting || (format === "mp4" && !mp4Supported);
    heatmapExportButton.title = format === "mp4"
      ? "Export a compact black-background MP4 of the heatmap forming"
      : "Export a compact black-background animated GIF of the heatmap forming";
  }

  function downloadHeatmapExport(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `maze-heatmap-${String(runId || "run").replace(/[^a-z0-9_-]+/gi, "-")}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function gifWriteText(bytes, value) {
    for (let index = 0; index < value.length; index += 1) bytes.push(value.charCodeAt(index));
  }

  function gifWriteUint16(bytes, value) {
    bytes.push(value & 0xff, value >> 8 & 0xff);
  }

  function gifLzwEncode(indices, minimumCodeSize) {
    const clearCode = 1 << minimumCodeSize;
    const endCode = clearCode + 1;
    const output = [];
    let bitBuffer = 0;
    let bitCount = 0;
    let codeSize = minimumCodeSize + 1;
    let nextCode = endCode + 1;
    const dictionary = new Map();
    const writeCode = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        output.push(bitBuffer & 0xff);
        bitBuffer >>= 8;
        bitCount -= 8;
      }
    };
    const reset = () => {
      dictionary.clear();
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
    };

    writeCode(clearCode);
    let prefix = indices[0] || 0;
    for (let index = 1; index < indices.length; index += 1) {
      const suffix = indices[index];
      const key = prefix * 256 + suffix;
      const existing = dictionary.get(key);
      if (existing !== undefined) {
        prefix = existing;
        continue;
      }
      writeCode(prefix);
      if (nextCode < 4096) {
        dictionary.set(key, nextCode);
        nextCode += 1;
        // The decoder's dictionary trails the encoder by one emitted code.
        // Grow only after allocating the first code beyond the current width.
        if (nextCode > 1 << codeSize && codeSize < 12) codeSize += 1;
      } else {
        writeCode(clearCode);
        reset();
      }
      prefix = suffix;
    }
    writeCode(prefix);
    writeCode(endCode);
    if (bitCount > 0) output.push(bitBuffer & 0xff);
    return output;
  }

  function gifWriteFrame(bytes, pixels, width, height, delay, transparent) {
    bytes.push(0x21, 0xf9, 0x04, transparent ? 0x05 : 0x04);
    gifWriteUint16(bytes, delay);
    bytes.push(0x00, 0x00);
    bytes.push(0x2c);
    gifWriteUint16(bytes, 0);
    gifWriteUint16(bytes, 0);
    gifWriteUint16(bytes, width);
    gifWriteUint16(bytes, height);
    bytes.push(0x00);

    const minimumCodeSize = 3;
    const encoded = gifLzwEncode(pixels, minimumCodeSize);
    bytes.push(minimumCodeSize);
    for (let offset = 0; offset < encoded.length; offset += 255) {
      const block = encoded.slice(offset, offset + 255);
      bytes.push(block.length, ...block);
    }
    bytes.push(0x00);
  }

  function heatmapGifPaletteIndex(count, data) {
    if (!count) return 1;
    const low = Math.log1p(data.minCount);
    const range = Math.log1p(data.maxCount) - low;
    const intensity = range > 0 ? (Math.log1p(count) - low) / range : 0;
    if (intensity < 0.25) return 2;
    if (intensity < 0.5) return 3;
    if (intensity < 0.75) return 4;
    return 5;
  }

  function heatmapGifBytes(data, sequence, onProgress) {
    const maxDimension = 320;
    const scale = Math.max(1, Math.min(3, Math.floor(maxDimension / data.columns), Math.floor(maxDimension / data.rows)));
    const width = data.columns * scale;
    const height = data.rows * scale;
    const bytes = [];
    gifWriteText(bytes, "GIF89a");
    gifWriteUint16(bytes, width);
    gifWriteUint16(bytes, height);
    bytes.push(0xf2, 0x00, 0x00);
    [
      [0, 0, 0],
      [0, 0, 0],
      [255, 216, 77],
      [255, 151, 45],
      [239, 62, 84],
      [139, 76, 220],
      [36, 36, 36],
      [0, 0, 0]
    ].forEach((color) => bytes.push(...color));
    bytes.push(0x21, 0xff, 0x0b);
    gifWriteText(bytes, "NETSCAPE2.0");
    bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);

    const fps = 25;
    const durationSeconds = 16;
    const totalFrames = fps * durationSeconds;
    const holdFrames = fps;
    const activeFrames = totalFrames - holdFrames;
    const delay = Math.round(100 / fps);
    const roomPixels = data.roomSize * scale;
    const base = new Uint8Array(width * height);
    base.fill(1);
    for (let column = 0; column <= data.maxRoomColumn - data.minRoomColumn + 1; column += 1) {
      const x = Math.min(width - 1, column * roomPixels);
      for (let y = 0; y < height; y += 1) base[y * width + x] = 6;
    }
    for (let row = 0; row <= data.maxRoomRow - data.minRoomRow + 1; row += 1) {
      const y = Math.min(height - 1, row * roomPixels);
      base.fill(6, y * width, (y + 1) * width);
    }
    gifWriteFrame(bytes, base, width, height, delay, false);

    const visits = new Map();
    const renderedColors = new Map();
    let visitIndex = 0;
    const paintCell = (frame, visit, paletteIndex) => {
      const cellX = (visit.x - data.minX) * scale;
      const cellY = (visit.y - data.minY) * scale;
      for (let offsetY = 0; offsetY < scale; offsetY += 1) {
        const y = cellY + offsetY;
        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
          const x = cellX + offsetX;
          if (x % roomPixels === 0 || y % roomPixels === 0) continue;
          frame[y * width + x] = paletteIndex;
        }
      }
    };

    for (let frameIndex = 1; frameIndex < totalFrames; frameIndex += 1) {
      const target = frameIndex >= activeFrames - 1
        ? sequence.length
        : Math.floor(frameIndex / Math.max(1, activeFrames - 1) * sequence.length);
      const frame = new Uint8Array(width * height);
      while (visitIndex < target) {
        const visit = sequence[visitIndex];
        const key = `${visit.x},${visit.y}`;
        const count = (visits.get(key) || 0) + 1;
        visits.set(key, count);
        const paletteIndex = heatmapGifPaletteIndex(count, data);
        if (renderedColors.get(key) !== paletteIndex) {
          renderedColors.set(key, paletteIndex);
          paintCell(frame, visit, paletteIndex);
        }
        visitIndex += 1;
      }
      gifWriteFrame(bytes, frame, width, height, delay, true);
      onProgress?.(target / sequence.length, frameIndex);
    }
    bytes.push(0x3b);
    return new Uint8Array(bytes);
  }

  async function exportHeatmapGif() {
    if (!heatmapExportButton || state.heatmapExporting) return;
    const data = state.heatmapData || heatmapVisitData();
    const sequence = heatmapVisitSequence(data);
    if (!data || sequence.length === 0) {
      setStatus("There are no heatmap visits to export yet.", true);
      return;
    }
    state.heatmapExporting = true;
    heatmapExportButton.disabled = true;
    if (heatmapExportFormat) heatmapExportFormat.disabled = true;
    heatmapExportButton.textContent = "Preparing…";
    setStatus("Building a compact heatmap GIF…");
    try {
      const gif = heatmapGifBytes(data, sequence, (progress, frameIndex) => {
        heatmapExportButton.textContent = `Exporting ${Math.round(progress * 100)}%`;
        if (frameIndex % 8 === 0) setStatus(`Building a compact heatmap GIF… ${Math.round(progress * 100)}%`);
      });
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const blob = new Blob([gif], { type: "image/gif" });
      if (!blob.size) throw new Error("The exported GIF was empty.");
      downloadHeatmapExport(blob, "gif");
      setStatus(`Heatmap GIF exported (${heatmapExportSize(blob.size)}).`);
    } catch (error) {
      setStatus(error.message || "Heatmap GIF export failed.", true);
    } finally {
      state.heatmapExporting = false;
      if (heatmapExportFormat) heatmapExportFormat.disabled = false;
      updateHeatmapExportControl();
    }
  }

  async function exportHeatmapMp4() {
    if (!heatmapExportButton || state.heatmapExporting) return;
    const mimeType = heatmapMp4MimeType();
    const data = state.heatmapData || heatmapVisitData();
    const sequence = heatmapVisitSequence(data);
    if (!data || sequence.length === 0) {
      setStatus("There are no heatmap visits to export yet.", true);
      return;
    }
    if (!mimeType || !heatmapMp4Supported()) {
      setStatus("MP4 export is not supported by this browser. Choose GIF instead.", true);
      return;
    }

    state.heatmapExporting = true;
    heatmapExportButton.disabled = true;
    if (heatmapExportFormat) heatmapExportFormat.disabled = true;
    heatmapExportButton.textContent = "Preparing…";
    setStatus("Building a compact heatmap MP4…");
    let stream = null;
    let recorder = null;
    try {
      const canvas = document.createElement("canvas");
      const maxDimension = 320;
      const scale = Math.max(1, Math.min(4, Math.floor(maxDimension / data.columns), Math.floor(maxDimension / data.rows)));
      canvas.width = data.columns * scale;
      canvas.height = data.rows * scale;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not create the MP4 canvas.");
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const cellWidth = canvas.width / data.columns;
      const cellHeight = canvas.height / data.rows;
      const gap = Math.min(1.25, Math.min(cellWidth, cellHeight) * 0.08);
      context.strokeStyle = "#242424";
      context.lineWidth = 1;
      context.beginPath();
      for (let column = data.minRoomColumn; column <= data.maxRoomColumn + 1; column += 1) {
        const x = (column - data.minRoomColumn) * data.roomSize * cellWidth;
        context.moveTo(x, 0);
        context.lineTo(x, canvas.height);
      }
      for (let row = data.minRoomRow; row <= data.maxRoomRow + 1; row += 1) {
        const y = (row - data.minRoomRow) * data.roomSize * cellHeight;
        context.moveTo(0, y);
        context.lineTo(canvas.width, y);
      }
      context.stroke();

      const fps = 25;
      const durationSeconds = 16;
      const totalFrames = fps * durationSeconds;
      const holdFrames = fps;
      const activeFrames = totalFrames - holdFrames;
      const frameDuration = 1000 / fps;
      const visits = new Map();
      let visitIndex = 0;
      const low = Math.log1p(data.minCount);
      const range = Math.log1p(data.maxCount) - low;
      const paintVisit = (visit, count) => {
        const left = (visit.x - data.minX) * cellWidth + gap;
        const top = (visit.y - data.minY) * cellHeight + gap;
        context.fillStyle = heatmapColor(range > 0 ? (Math.log1p(count) - low) / range : 0);
        context.fillRect(left, top, Math.max(0.5, cellWidth - gap * 2), Math.max(0.5, cellHeight - gap * 2));
      };
      stream = canvas.captureStream(0);
      let videoTrack = stream.getVideoTracks()[0];
      const manuallyCaptured = typeof videoTrack?.requestFrame === "function";
      if (!manuallyCaptured) {
        stream.getTracks().forEach((track) => track.stop());
        stream = canvas.captureStream(fps);
        videoTrack = stream.getVideoTracks()[0];
      }
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 320_000 });
      const chunks = [];
      const stopped = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.addEventListener("stop", resolve, { once: true });
        recorder.addEventListener("error", (event) => reject(event.error || new Error("MP4 recording failed.")), { once: true });
      });

      const renderFrame = (frameIndex) => {
        const target = frameIndex >= activeFrames - 1
          ? sequence.length
          : Math.floor(frameIndex / Math.max(1, activeFrames - 1) * sequence.length);
        while (visitIndex < target) {
          const visit = sequence[visitIndex];
          const key = `${visit.x},${visit.y}`;
          const count = (visits.get(key) || 0) + 1;
          visits.set(key, count);
          paintVisit(visit, count);
          visitIndex += 1;
        }
        // Mark the canvas dirty even during the final hold so MediaRecorder
        // preserves those black frames instead of shortening the MP4 by 1s.
        context.fillStyle = "#000";
        context.fillRect(canvas.width - 1, canvas.height - 1, 1, 1);
        heatmapExportButton.textContent = `Exporting ${Math.round(target / sequence.length * 100)}%`;
      };

      renderFrame(0);
      recorder.start(1000);
      if (manuallyCaptured) videoTrack.requestFrame();
      const startedAt = performance.now();
      for (let frameIndex = 1; frameIndex < totalFrames; frameIndex += 1) {
        const frameAt = startedAt + frameIndex * frameDuration;
        await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, frameAt - performance.now())));
        renderFrame(frameIndex);
        if (manuallyCaptured) videoTrack.requestFrame();
      }
      const stopAt = startedAt + durationSeconds * 1000;
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, stopAt - performance.now())));
      recorder.stop();
      await stopped;

      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      if (!blob.size) throw new Error("The exported MP4 was empty.");
      downloadHeatmapExport(blob, "mp4");
      setStatus(`Heatmap MP4 exported (${heatmapExportSize(blob.size)}).`);
    } catch (error) {
      if (recorder?.state === "recording") recorder.stop();
      setStatus(error.message || "Heatmap MP4 export failed.", true);
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      state.heatmapExporting = false;
      if (heatmapExportFormat) heatmapExportFormat.disabled = false;
      updateHeatmapExportControl();
    }
  }

  async function exportSelectedHeatmapFormat() {
    if (selectedHeatmapExportFormat() === "mp4") await exportHeatmapMp4();
    else await exportHeatmapGif();
  }

  function renderHeatmap() {
    if (!heatmapSection || !state.heatmapDirty) return;
    state.heatmapDirty = false;
    renderBoardStateChart();
    const data = heatmapVisitData();
    state.heatmapData = data;
    const available = Boolean(data);
    heatmapViewport.hidden = !available;
    heatmapSummary.hidden = !available;
    heatmapLegend.hidden = !available;
    heatmapEmpty.hidden = available;
    if (heatmapExportFormat) heatmapExportFormat.hidden = !available;
    if (heatmapExportButton) {
      heatmapExportButton.hidden = !available;
      updateHeatmapExportControl();
    }
    if (!data) return;

    const roomLabels = data.rooms.map((room) => room.label);
    const newCellRate = data.totalVisits ? data.uniqueCells / data.totalVisits * 100 : 0;
    heatmapSummary.querySelector('[data-heatmap-stat="cells"]').textContent = data.uniqueCells.toLocaleString();
    heatmapSummary.querySelector('[data-heatmap-stat="visits"]').textContent = data.totalVisits.toLocaleString();
    heatmapSummary.querySelector('[data-heatmap-stat="new-rate"]').textContent = `${newCellRate.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    heatmapSummary.setAttribute(
      "aria-label",
      `${data.uniqueCells.toLocaleString()} cells visited; ${data.totalVisits.toLocaleString()} total visits; ${newCellRate.toFixed(1)} percent of visits discovered a new cell`
    );
    heatmapCanvas.setAttribute(
      "aria-label",
      `Player visit heatmap across rooms ${roomLabels.join(", ")}; each room is 16 by 16 cells and positioned on the world map; ${data.uniqueCells.toLocaleString()} visited cells and ${data.totalVisits.toLocaleString()} total visits; elevation combined`
    );
    requestAnimationFrame(drawHeatmap);
  }

  function drawExplorationCharts() {
    const points = explorationPoints();
    drawMetricChart(roomsChart, points, "rooms", "#65f3d4");
    drawMetricChart(gemsChart, points, "gems", "#ffd15c");
  }

  function metricJumpAt(canvas, event) {
    const targets = Array.isArray(canvas?._replayJumpTargets) ? canvas._replayJumpTargets : [];
    if (!targets.length) return null;
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return targets.reduce((nearest, target) => {
      const distance = Math.hypot(target.x - x, target.y - y);
      return distance <= 20 && (!nearest || distance < nearest.distance)
        ? { ...target, distance }
        : nearest;
    }, null);
  }

  function metricTooltipFor(canvas) {
    return canvas === roomsChart ? roomsChartTooltip : canvas === gemsChart ? gemsChartTooltip : null;
  }

  function hideMetricTooltip(canvas) {
    const tooltip = metricTooltipFor(canvas);
    canvas.classList.remove("has-jump-target");
    if (tooltip) tooltip.hidden = true;
  }

  function showMetricTooltip(canvas, target, event) {
    const tooltip = metricTooltipFor(canvas);
    if (!tooltip) return;
    const cardBounds = canvas.closest(".run-metric-chart")?.getBoundingClientRect();
    if (!cardBounds) return;
    const noun = canvas.dataset.metricKey === "rooms"
      ? `${target.value.toLocaleString()} room${target.value === 1 ? "" : "s"} visited`
      : `${target.value.toLocaleString()} gem${target.value === 1 ? "" : "s"} collected`;
    tooltip.textContent = `Frame ${target.action.toLocaleString()} · ${noun}`;
    tooltip.style.left = `${event.clientX - cardBounds.left}px`;
    tooltip.style.top = `${event.clientY - cardBounds.top}px`;
    tooltip.hidden = false;
  }

  function wireMetricChart(canvas) {
    if (!canvas) return;
    canvas.addEventListener("pointermove", (event) => {
      const target = metricJumpAt(canvas, event);
      canvas.classList.toggle("has-jump-target", Boolean(target));
      if (target) showMetricTooltip(canvas, target, event);
      else hideMetricTooltip(canvas);
    });
    canvas.addEventListener("pointerleave", () => hideMetricTooltip(canvas));
    canvas.addEventListener("click", (event) => {
      const target = metricJumpAt(canvas, event);
      if (target) {
        hideMetricTooltip(canvas);
        void jumpToPrimaryFrame(target.action);
      }
    });
  }

  function firstRoomEntryTurns() {
    const entries = new Map();
    const startingRoom = levelId(initial.level_id || state.run?.level_id);
    if (startingRoom) entries.set(startingRoom, 0);
    [...state.moves.entries()]
      .sort(([left], [right]) => left - right)
      .forEach(([turn, move]) => {
        const room = levelId(move.roomId || move.room);
        if (room && !entries.has(room)) entries.set(room, Number(turn));
      });
    return entries;
  }

  function visitedRoomIds() {
    return new Set(firstRoomEntryTurns().keys());
  }

  function worldAxisIndex(value) {
    const letter = String(value || "").trim().toUpperCase();
    return /^[A-Z]$/.test(letter) ? letter.charCodeAt(0) - 65 : -1;
  }

  function runWorldMapLevels() {
    return (Array.isArray(runWorld?.levels) ? runWorld.levels : [])
      .map((level) => ({
        ...level,
        columnIndex: worldAxisIndex(level.column),
        rowIndex: worldAxisIndex(level.row)
      }))
      .filter((level) => level.id && level.columnIndex >= 0 && level.rowIndex >= 0);
  }

  function fittedRunWorldMapTileSize(columnCount, rowCount) {
    const viewport = roomsMapGrid?.parentElement;
    const availableWidth = Math.max(120, (viewport?.clientWidth || window.innerWidth || 720) - 28);
    const availableHeight = Math.max(120, (window.innerHeight || 720) - 260);
    return Math.max(
      10,
      Math.min(62, Math.floor(Math.min(availableWidth / columnCount, availableHeight / rowCount)))
    );
  }

  function hideRunWorldMapTooltip() {
    if (roomsMapTooltip) roomsMapTooltip.hidden = true;
  }

  function showRunWorldMapTooltip(cell) {
    if (!roomsMapTooltip || !cell) return;
    const turn = Number(cell.dataset.jumpTurn);
    const bounds = cell.getBoundingClientRect();
    roomsMapTooltip.textContent = `${cell.dataset.roomLabel} · First entered at Action ${turn}`;
    roomsMapTooltip.style.left = `${bounds.left + bounds.width / 2}px`;
    roomsMapTooltip.style.top = `${bounds.top}px`;
    roomsMapTooltip.hidden = false;
  }

  function renderRunWorldMap({ force = false } = {}) {
    if (!roomsMapGrid || roomsMapDialog?.hidden) return;
    const levels = runWorldMapLevels();
    if (levels.length === 0) return;
    const firstEntries = firstRoomEntryTurns();
    const visited = visitedRoomIds();
    const currentRoom = levelId(state.run?.current_room || initial.current_room || initial.level_id);
    const minColumn = Math.min(...levels.map((level) => level.columnIndex));
    const maxColumn = Math.max(...levels.map((level) => level.columnIndex));
    const minRow = Math.min(...levels.map((level) => level.rowIndex));
    const maxRow = Math.max(...levels.map((level) => level.rowIndex));
    const columnCount = maxColumn - minColumn + 1;
    const rowCount = maxRow - minRow + 1;
    const tileSize = fittedRunWorldMapTileSize(columnCount, rowCount);
    const signature = JSON.stringify({ currentRoom, tileSize, entries: [...firstEntries.entries()].sort() });
    if (!force && signature === state.worldMapSignature) return;
    state.worldMapSignature = signature;

    const mappedVisitedCount = levels.filter((level) => visited.has(level.id)).length;
    roomsMapSummary.textContent = `${mappedVisitedCount.toLocaleString()} of ${levels.length.toLocaleString()} rooms visited`;
    roomsMapGrid.setAttribute(
      "aria-label",
      `${mappedVisitedCount.toLocaleString()} of ${levels.length.toLocaleString()} rooms visited${currentRoom ? `; current room ${levelLabel(currentRoom)}` : ""}`
    );
    roomsMapGrid.style.setProperty("--run-world-map-columns", String(columnCount));
    roomsMapGrid.style.setProperty("--run-world-map-tile-size", `${tileSize}px`);
    roomsMapGrid.replaceChildren();

    levels.forEach((level) => {
      const isVisited = visited.has(level.id);
      const isCurrent = level.id === currentRoom;
      const firstEntryTurn = firstEntries.get(level.id);
      const cell = document.createElement(isVisited ? "button" : "div");
      if (isVisited) cell.type = "button";
      cell.className = "run-world-map__cell";
      cell.classList.toggle("is-visited", isVisited);
      cell.classList.toggle("is-current", isCurrent);
      cell.style.gridColumn = String(level.columnIndex - minColumn + 1);
      cell.style.gridRow = String(level.rowIndex - minRow + 1);
      if (isVisited) {
        cell.dataset.jumpTurn = String(firstEntryTurn);
        cell.dataset.roomLabel = levelLabel(level.id);
        cell.setAttribute("aria-describedby", "run-rooms-map-tooltip");
        cell.setAttribute("aria-label", `${levelLabel(level.id)}, first entered at Action ${firstEntryTurn}; show in viewer`);
        cell.addEventListener("click", () => {
          hideRunWorldMapTooltip();
          setRunWorldMapOpen(false);
          void jumpToPrimaryFrame(firstEntryTurn);
        });
      } else {
        cell.title = `${levelLabel(level.id)} — not visited`;
      }

      if (isVisited && level.preview_url) {
        const image = document.createElement("img");
        image.className = "run-world-map__thumb";
        image.alt = "";
        image.decoding = "async";
        image.src = level.preview_url;
        cell.append(image);
      }

      roomsMapGrid.append(cell);
    });
    updateReplayJumpSelection(replayTurn("primary"));
  }

  let roomsMapCloseTimer = 0;
  let roomsMapReturnFocus = null;

  function setRunWorldMapOpen(open) {
    if (!roomsMapDialog || !roomsMapButton || runWorldMapLevels().length === 0) return;
    window.clearTimeout(roomsMapCloseTimer);
    if (open) {
      roomsMapReturnFocus = document.activeElement;
      roomsMapDialog.hidden = false;
      roomsMapButton.setAttribute("aria-expanded", "true");
      document.documentElement.classList.add("has-run-world-map");
      state.worldMapSignature = "";
      window.requestAnimationFrame(() => {
        roomsMapDialog.classList.add("is-open");
        renderRunWorldMap({ force: true });
        roomsMapClose?.focus({ preventScroll: true });
      });
      return;
    }
    hideRunWorldMapTooltip();
    roomsMapDialog.classList.remove("is-open");
    roomsMapButton.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("has-run-world-map");
    roomsMapCloseTimer = window.setTimeout(() => {
      roomsMapDialog.hidden = true;
    }, 160);
    roomsMapReturnFocus?.focus?.({ preventScroll: true });
  }

  function renderExplorationCharts() {
    renderHeatmap();
    const points = explorationPoints();
    const signature = JSON.stringify(points);
    if (roomsMapDialog?.hidden === false) renderRunWorldMap();
    if (signature === state.explorationSignature) return;
    state.explorationSignature = signature;
    const available = points.length > 0;
    explorationGrid.hidden = !available;
    explorationEmpty.hidden = available;
    if (!available) return;

    const latest = points[points.length - 1];
    roomsLatest.textContent = latest.rooms.toLocaleString();
    gemsLatest.textContent = latest.gems.toLocaleString();
    const latestJump = (key, initialValue) => {
      let previous = initialValue;
      let found = null;
      points.forEach((point) => {
        if (point[key] !== previous) found = point;
        previous = point[key];
      });
      return found;
    };
    const roomJump = latestJump("rooms", 1);
    const gemJump = latestJump("gems", 0);
    [[roomsLatest, roomJump], [gemsLatest, gemJump]].forEach(([control, jump]) => {
      control.disabled = !jump;
      if (jump) {
        control.dataset.jumpTurn = String(jump.action);
        control.setAttribute("aria-label", `Show frame ${jump.action}`);
      } else {
        delete control.dataset.jumpTurn;
        control.removeAttribute("aria-label");
      }
    });
    roomsChart.setAttribute("aria-label", `${latest.rooms.toLocaleString()} rooms visited by action ${latest.action.toLocaleString()}`);
    gemsChart.setAttribute("aria-label", `${latest.gems.toLocaleString()} gems collected by action ${latest.action.toLocaleString()}`);
    requestAnimationFrame(drawExplorationCharts);
  }

  if (runWorldMapLevels().length === 0 && roomsMapButton) roomsMapButton.hidden = true;
  wireMetricChart(roomsChart);
  wireMetricChart(gemsChart);
  [roomsLatest, gemsLatest].forEach((control) => control?.addEventListener("click", () => {
    if (control.dataset.jumpTurn) void jumpToPrimaryFrame(Number(control.dataset.jumpTurn));
  }));
  roomsMapButton?.addEventListener("click", () => setRunWorldMapOpen(true));
  roomsMapClose?.addEventListener("click", () => setRunWorldMapOpen(false));
  roomsMapGrid?.addEventListener("pointerover", (event) => {
    const cell = event.target.closest("button.run-world-map__cell[data-jump-turn]");
    if (cell && roomsMapGrid.contains(cell)) showRunWorldMapTooltip(cell);
    else hideRunWorldMapTooltip();
  });
  roomsMapGrid?.addEventListener("pointerleave", hideRunWorldMapTooltip);
  roomsMapGrid?.addEventListener("focusin", (event) => {
    const cell = event.target.closest("button.run-world-map__cell[data-jump-turn]");
    if (cell) showRunWorldMapTooltip(cell);
  });
  roomsMapGrid?.addEventListener("focusout", hideRunWorldMapTooltip);
  roomsMapDialog?.addEventListener("click", (event) => {
    if (event.target === roomsMapDialog) setRunWorldMapOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && roomsMapDialog?.hidden === false) {
      event.preventDefault();
      setRunWorldMapOpen(false);
    }
  });
  window.addEventListener("resize", () => {
    requestAnimationFrame(() => {
      drawExplorationCharts();
      drawBoardStateChart();
      drawHeatmap();
      if (roomsMapDialog?.hidden === false) renderRunWorldMap({ force: true });
    });
  }, { passive: true });

  heatmapCanvas?.addEventListener("pointermove", (event) => {
    const data = state.heatmapData;
    if (!data || !heatmapTooltip) return;
    const bounds = heatmapCanvas.getBoundingClientRect();
    const column = Math.max(0, Math.min(data.columns - 1, Math.floor((event.clientX - bounds.left) / bounds.width * data.columns)));
    const row = Math.max(0, Math.min(data.rows - 1, Math.floor((event.clientY - bounds.top) / bounds.height * data.rows)));
    const worldX = data.minX + column;
    const worldY = data.minY + row;
    const roomColumn = Math.floor(worldX / data.roomSize);
    const roomRow = Math.floor(worldY / data.roomSize);
    const room = data.roomsByPosition.get(`${roomColumn},${roomRow}`);
    const x = worldX - roomColumn * data.roomSize;
    const y = worldY - roomRow * data.roomSize;
    const count = data.visits.get(`${worldX},${worldY}`) || 0;
    const viewportBounds = heatmapViewport.getBoundingClientRect();
    heatmapTooltip.textContent = `${room?.label || "Unvisited room"} · x ${x} · y ${y} · ${count.toLocaleString()} visit${count === 1 ? "" : "s"}`;
    heatmapTooltip.style.left = `${event.clientX - viewportBounds.left}px`;
    heatmapTooltip.style.top = `${event.clientY - viewportBounds.top}px`;
    heatmapTooltip.hidden = false;
  });
  heatmapCanvas?.addEventListener("pointerleave", () => {
    if (heatmapTooltip) heatmapTooltip.hidden = true;
  });
  boardStateCanvas?.addEventListener("pointermove", (event) => {
    const target = metricJumpAt(boardStateCanvas, event);
    boardStateCanvas.classList.toggle("has-jump-target", Boolean(target));
    if (!target || !boardStateTooltip) {
      if (boardStateTooltip) boardStateTooltip.hidden = true;
      return;
    }
    const cardBounds = boardStateChart.getBoundingClientRect();
    const observation = target.basis === "position" ? "position" : "state";
    const stateText = target.duplicate ? `repeat ${observation}` : `globally new ${observation}`;
    const scopeText = target.mode === "cumulative"
      ? `${target.windowSize.toLocaleString()} observed state${target.windowSize === 1 ? "" : "s"}`
      : `${target.windowSize.toLocaleString()} move${target.windowSize === 1 ? "" : "s"}`;
    boardStateTooltip.textContent = `Action ${target.action.toLocaleString()} · ${target.percentage.toFixed(1)}% novel over ${scopeText} · ${target.repeats.toLocaleString()} repeat${target.repeats === 1 ? "" : "s"} · ${stateText}`;
    boardStateTooltip.style.left = `${event.clientX - cardBounds.left}px`;
    boardStateTooltip.style.top = `${event.clientY - cardBounds.top}px`;
    boardStateTooltip.hidden = false;
  });
  boardStateCanvas?.addEventListener("pointerleave", () => {
    boardStateCanvas.classList.remove("has-jump-target");
    if (boardStateTooltip) boardStateTooltip.hidden = true;
  });
  boardStateCanvas?.addEventListener("click", (event) => {
    const target = metricJumpAt(boardStateCanvas, event);
    if (target) void jumpToPrimaryFrame(target.action);
  });
  boardStateScope?.addEventListener("change", () => {
    state.boardStateMetricMode = boardStateScope.value;
    if (boardStateCustomWindow) boardStateCustomWindow.hidden = state.boardStateMetricMode !== "last-n";
    renderBoardStateChart();
    if (state.boardStateMetricMode === "last-n") {
      requestAnimationFrame(() => boardStateWindowInput?.select());
    }
  });
  boardStateBasis?.addEventListener("change", () => {
    state.boardStateMetricBasis = boardStateBasis.value;
    renderBoardStateChart();
  });
  boardStateWindowInput?.addEventListener("input", () => {
    if (!boardStateWindowInput.value) return;
    state.boardStateCustomWindow = boardStateWindowSize(boardStateWindowInput.value);
    renderBoardStateChart();
  });
  boardStateWindowInput?.addEventListener("change", () => {
    state.boardStateCustomWindow = boardStateWindowSize(boardStateWindowInput.value);
    boardStateWindowInput.value = String(state.boardStateCustomWindow);
    renderBoardStateChart();
  });
  heatmapExportFormat?.addEventListener("change", updateHeatmapExportControl);
  heatmapExportButton?.addEventListener("click", () => {
    void exportSelectedHeatmapFormat();
  });

  // ---- combined moves + reasoning feed --------------------------------------

  function ingestActions(actions) {
    for (const action of actions) {
      const invalidReason = String(action.error || (!String(action.command_text || "").trim() ? "empty response" : "")).trim();
      const flags = [
        action.valid === false || invalidReason ? "invalid" : null,
        action.moved === false ? "blocked" : null,
        action.player_dead ? "died" : null,
        action.solved ? "SOLVED" : null
      ].filter(Boolean);
      const nextMove = {
        action: invalidReason ? `Invalid: ${invalidReason}` : action.command_text,
        boardStateHash: String(action.board_state_hash || ""),
        room: levelLabel(action.current_room),
        roomId: levelId(action.current_room),
        gems: action.gem_count ?? 0,
        player: heatmapPosition(action.player),
        timestamp: action.timestamp || null,
        flags
      };
      const previousMove = state.moves.get(action.turn);
      if (
        !previousMove ||
        previousMove.action !== nextMove.action ||
        previousMove.room !== nextMove.room ||
        previousMove.gems !== nextMove.gems ||
        previousMove.player?.x !== nextMove.player?.x ||
        previousMove.player?.y !== nextMove.player?.y ||
        previousMove.boardStateHash !== nextMove.boardStateHash ||
        previousMove.timestamp !== nextMove.timestamp ||
        previousMove.flags.join("|") !== nextMove.flags.join("|")
      ) {
        state.moves.set(action.turn, nextMove);
        state.heatmapDirty = true;
        state.feedVersion += 1;
      }
      if (!state.replayCursors.has("primary")) {
        if (action.level && !isVision) showAsciiBoard(action.level);
        if (isJson && action.json_observation) {
          showJsonObservation(action.json_observation, action.turn);
        }
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
            roomId: levelId(entry.room),
            gems: entry.gems ?? 0,
            timestamp: entry.timestamp || null,
            flags: [entry.moved === false ? "blocked" : null, entry.player_dead ? "died" : null].filter(Boolean)
          });
          state.feedVersion += 1;
        }
      }
    }
  }

  function feedSearchTerms(query) {
    const parts = String(query || "").match(/"[^"]+"|\S+/g) || [];
    return [...new Set(parts.map((part) => part.replace(/^"|"$/g, "").trim().toLowerCase()).filter(Boolean))];
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightText(value, terms) {
    if (!terms.length) return escapeText(value);
    const pattern = new RegExp(`(${terms.slice().sort((left, right) => right.length - left.length).map(escapeRegExp).join("|")})`, "gi");
    return String(value ?? "").split(pattern).map((part, index) =>
      index % 2 ? `<mark>${escapeText(part)}</mark>` : escapeText(part)
    ).join("");
  }

  function formatReasoning(reasoning, terms) {
    const text = String(reasoning || "");
    let formatted = "";
    let offset = 0;
    text.replace(/\*\*([\s\S]*?)\*\*/g, (match, strong, index) => {
      formatted += highlightText(text.slice(offset, index), terms);
      formatted += `<strong>${highlightText(strong, terms)}</strong>`;
      offset = index + match.length;
      return match;
    });
    formatted += highlightText(text.slice(offset), terms);
    return formatted.replace(/\r?\n/g, "<br>");
  }

  function moveSearchText(num, move, reasoning, activeAgents, moveTokens) {
    return [
      num,
      move.action,
      move.room,
      move.roomId,
      `${move.gems} gems`,
      ...(move.flags || []),
      move.player ? `x ${move.player.x} y ${move.player.y}` : "",
      move.timestamp,
      activeAgents ? `${activeAgents} agents` : "",
      Number.isFinite(moveTokens) ? `${moveTokens} tokens` : "",
      reasoning
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function isMultiAgentRun() {
    return Boolean(state.run.swarm || Number(state.run.explorer_instances) > 0);
  }

  function feedExportPayload() {
    const moves = [...state.moves.keys()].sort((left, right) => left - right).map((turn) => {
      const move = state.moves.get(turn);
      const tokens = state.tokenCounts.get(turn);
      return {
        turn: Number(turn),
        timestamp: move.timestamp || null,
        action: move.action || "",
        room: move.roomId || levelId(move.room),
        player: move.player || null,
        gem_count: Math.max(0, Number(move.gems) || 0),
        flags: [...(move.flags || [])],
        active_agents: state.agentCounts.get(turn) || (state.run.swarm ? 0 : 1),
        tokens: Number.isFinite(tokens) ? tokens : null,
        reasoning: state.reasoning.get(turn) || null
      };
    });
    return {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      export_scope: "all_moves",
      run: {
        id: runId,
        game_id: state.run.game_id || null,
        level_id: state.run.level_id || null,
        status: state.run.status || null,
        provider: state.run.provider || state.run.model || null,
        model: state.run.model_name || state.run.model || null,
        observation_mode: state.run.mode || null,
        launch_parameters: state.run.launch_params || null
      },
      move_count: moves.length,
      moves
    };
  }

  function exportFeedJson() {
    const payload = feedExportPayload();
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `agent-run-${String(runId).replace(/[^a-z0-9_-]+/gi, "-")}-moves.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function feedTextExport(payload) {
    const lines = [
      "Maze Bench Agent Reasoning Log",
      `Run ID: ${payload.run.id || "—"}`,
      `Exported: ${payload.exported_at}`,
      `Status: ${payload.run.status || "—"}`,
      `Provider: ${payload.run.provider || "—"}`,
      `Model: ${payload.run.model || "—"}`,
      `Observation mode: ${payload.run.observation_mode || "—"}`,
      `Moves: ${payload.move_count}`,
      ""
    ];

    payload.moves.forEach((move) => {
      lines.push(`Action ${move.turn}: ${move.action || "Unknown action"}`);
      if (move.timestamp) lines.push(`Timestamp: ${move.timestamp}`);
      lines.push(`Room: ${move.room || "—"}`);
      if (move.player) lines.push(`Position: ${move.player.x}, ${move.player.y}`);
      lines.push(`Gems: ${move.gem_count}`);
      if (move.flags.length) lines.push(`Flags: ${move.flags.join(", ")}`);
      lines.push(`Active agents: ${move.active_agents}`);
      if (Number.isFinite(move.tokens)) lines.push(`Tokens: ${move.tokens}`);
      lines.push("Reasoning:");
      lines.push(move.reasoning || "(No reasoning recorded.)");
      lines.push("", "---", "");
    });

    return `${lines.join("\n").trimEnd()}\n`;
  }

  function exportFeedText() {
    const payload = feedExportPayload();
    const blob = new Blob([feedTextExport(payload)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `agent-run-${String(runId).replace(/[^a-z0-9_-]+/gi, "-")}-reasoning.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderNotesState(message = "", explicitState = "") {
    if (!notesInput || !notesSaveButton || !notesStatus || !notesStatusText) return;
    const dirty = notesInput.value.trim() !== state.savedNotes;
    const status = explicitState || (dirty ? "dirty" : state.savedNotes ? "saved" : "empty");
    notesSaveButton.disabled = !dirty;
    notesStatus.dataset.state = status;
    notesStatusText.textContent = message || (dirty ? "Unsaved" : state.savedNotes ? "Saved" : "No notes yet");
    if (notesCount) notesCount.textContent = `${notesInput.value.length.toLocaleString()} / 50,000`;
  }

  async function saveRunNotes() {
    if (!notesInput || !notesSaveButton) return;
    notesSaveButton.disabled = true;
    if (notesSaveLabel) notesSaveLabel.textContent = "Saving…";
    renderNotesState("Saving…", "saving");
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/notes`, {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ notes: notesInput.value })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Could not save notes (${response.status}).`);
      state.savedNotes = String(payload.notes?.notes || "");
      state.run.run_notes = state.savedNotes;
      notesInput.value = state.savedNotes;
      renderNotesState(state.savedNotes ? "Saved just now" : "Notes cleared", "saved");
    } catch (error) {
      renderNotesState("Save failed", "error");
      setStatus(error.message, true);
    } finally {
      if (notesSaveLabel) notesSaveLabel.textContent = "Save notes";
      notesSaveButton.disabled = notesInput.value.trim() === state.savedNotes;
    }
  }

  function renderFeed({ resetScroll = false } = {}) {
    const query = state.feedQuery.trim();
    if (state.renderedFeedVersion === state.feedVersion && state.renderedFeedQuery === query) return;
    const terms = feedSearchTerms(query);
    const multiAgentRun = isMultiAgentRun();
    const allMoveNums = [...state.moves.keys()].sort((a, b) => a - b);
    const moveNums = allMoveNums.filter((num) => {
      if (!terms.length) return true;
      const move = state.moves.get(num);
      const text = moveSearchText(
        num,
        move,
        state.reasoning.get(num),
        multiAgentRun ? state.agentCounts.get(num) || 0 : 0,
        state.tokenCounts.get(num)
      );
      return terms.every((term) => text.includes(term));
    });
    const hiddenMoveCount = Math.max(0, moveNums.length - state.feedRenderLimit);
    const renderedMoveNums = hiddenMoveCount > 0 ? moveNums.slice(-state.feedRenderLimit) : moveNums;
    if (feedExportButton) feedExportButton.disabled = allMoveNums.length === 0;
    if (feedTextExportButton) feedTextExportButton.disabled = allMoveNums.length === 0;
    if (feedResult) {
      feedResult.textContent = terms.length
        ? hiddenMoveCount
          ? `${renderedMoveNums.length.toLocaleString()} of ${moveNums.length.toLocaleString()} matching moves shown`
          : `${moveNums.length.toLocaleString()} of ${allMoveNums.length.toLocaleString()} moves`
        : allMoveNums.length
          ? hiddenMoveCount
            ? `${renderedMoveNums.length.toLocaleString()} of ${allMoveNums.length.toLocaleString()} moves shown`
            : `${allMoveNums.length.toLocaleString()} move${allMoveNums.length === 1 ? "" : "s"}`
          : "Waiting for moves";
    }
    if (!allMoveNums.length) {
      feedEl.innerHTML = '<p class="muted">Waiting for the agent\'s first move…</p>';
      state.renderedFeedVersion = state.feedVersion;
      state.renderedFeedQuery = query;
      return;
    }

    if (!moveNums.length) {
      feedEl.innerHTML = `<div class="agent-feed__empty"><strong>No matching moves</strong><span>Try fewer terms or clear “${escapeText(query)}”.</span></div>`;
      state.renderedFeedVersion = state.feedVersion;
      state.renderedFeedQuery = query;
      feedEl.scrollTop = 0;
      return;
    }

    const previousTop = feedEl.scrollTop;
    const distanceFromBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight;
    const followLatest = !terms.length && !resetScroll && distanceFromBottom <= 40;
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

    const loadMore = hiddenMoveCount
      ? `<button class="agent-feed__load-more" type="button" data-feed-load-more>
          Show previous ${Math.min(FEED_RENDER_BATCH, hiddenMoveCount).toLocaleString()} moves
          <small>${hiddenMoveCount.toLocaleString()} older move${hiddenMoveCount === 1 ? "" : "s"} not rendered</small>
        </button>`
      : "";
    feedEl.innerHTML = loadMore + renderedMoveNums
      .map((num) => {
        const move = state.moves.get(num);
        const reasoning = state.reasoning.get(num);
        const activeAgents = state.agentCounts.get(num) || (state.run.swarm ? 0 : 1);
        const moveTokens = state.tokenCounts.get(num);
        const parsedTimestamp = move.timestamp ? new Date(move.timestamp) : null;
        const timestamp = parsedTimestamp && Number.isFinite(parsedTimestamp.getTime())
          ? parsedTimestamp.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })
          : "";
        const statusClass = move.flags.includes("died")
          ? " is-danger"
          : move.flags.includes("blocked")
            ? " is-blocked"
            : move.flags.includes("SOLVED")
              ? " is-solved"
              : "";
        const agentBadge = multiAgentRun && activeAgents
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
        const flagBadges = move.flags.map((flag) =>
          `<span class="agent-feed__flag is-${escapeText(flag.toLowerCase())}">${highlightText(flag, terms)}</span>`
        ).join("");
        const longReasoning = Boolean(reasoning && reasoning.length > 280);
        const expanded = state.expandedReasoning.has(num) || terms.length > 0;
        return `<article class="agent-feed__row${statusClass}" data-move="${escapeText(num)}">
          <div class="agent-feed__head">
            <div class="agent-feed__identity">
              <span class="agent-feed__num" aria-label="Action ${escapeText(num)}">${escapeText(num)}</span>
              <strong class="agent-feed__action">${highlightText(move.action || "Unknown action", terms)}</strong>
              <button type="button" class="agent-feed__jump" data-jump-turn="${escapeText(num)}">Jump to Action ${escapeText(num)}</button>
            </div>
            ${timestamp ? `<time class="agent-feed__time" datetime="${escapeText(move.timestamp)}">${escapeText(timestamp)}</time>` : ""}
          </div>
          <div class="agent-feed__details">
            <span class="agent-feed__meta"><b>Room</b>${highlightText(move.room || "—", terms)}</span>
            <span class="agent-feed__meta"><b>Gems</b>${highlightText(move.gems, terms)}</span>
            ${move.player ? `<span class="agent-feed__meta"><b>Position</b>${highlightText(`${move.player.x}, ${move.player.y}`, terms)}</span>` : ""}
            ${tokenBadge}
            ${agentBadge}
            ${flagBadges}
          </div>
          ${reasoning ? `<section class="agent-feed__reasoning${longReasoning ? " is-collapsible" : ""}${expanded ? " is-expanded" : ""}">
            <div class="agent-feed__reasoning-head">
              <span>Reasoning</span>
              ${longReasoning ? `<button type="button" data-feed-expand="${escapeText(num)}" aria-expanded="${expanded ? "true" : "false"}">${expanded ? "Show less" : "Show more"}</button>` : ""}
            </div>
            <p>${formatReasoning(reasoning, terms)}</p>
          </section>` : `<p class="agent-feed__no-reasoning">No reasoning recorded for this move.</p>`}
        </article>`;
      })
      .join("");
    state.renderedFeedVersion = state.feedVersion;
    state.renderedFeedQuery = query;
    updateReplayJumpSelection(replayTurn("primary"));

    if (resetScroll) {
      feedEl.scrollTop = 0;
    } else if (followLatest) {
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

  let feedSearchFrame = 0;
  feedSearch?.addEventListener("input", () => {
    state.feedQuery = feedSearch.value;
    state.feedRenderLimit = FEED_RENDER_BATCH;
    feedSearchClear.hidden = !state.feedQuery;
    cancelAnimationFrame(feedSearchFrame);
    feedSearchFrame = requestAnimationFrame(() => renderFeed({ resetScroll: true }));
  });
  feedSearch?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && feedSearch.value) {
      event.preventDefault();
      feedSearch.value = "";
      state.feedQuery = "";
      state.feedRenderLimit = FEED_RENDER_BATCH;
      feedSearchClear.hidden = true;
      renderFeed({ resetScroll: true });
    }
  });
  feedSearchClear?.addEventListener("click", () => {
    feedSearch.value = "";
    state.feedQuery = "";
    state.feedRenderLimit = FEED_RENDER_BATCH;
    feedSearchClear.hidden = true;
    feedSearch.focus();
    renderFeed({ resetScroll: true });
  });
  feedExportButton?.addEventListener("click", exportFeedJson);
  feedTextExportButton?.addEventListener("click", exportFeedText);
  feedEl?.addEventListener("click", (event) => {
    const loadMore = event.target.closest("[data-feed-load-more]");
    if (loadMore) {
      state.feedRenderLimit += FEED_RENDER_BATCH;
      state.renderedFeedVersion = -1;
      renderFeed();
      return;
    }
    const frame = event.target.closest("[data-jump-turn]");
    if (frame) {
      event.preventDefault();
      void jumpToPrimaryFrame(Number(frame.dataset.jumpTurn));
      return;
    }
    const button = event.target.closest("[data-feed-expand]");
    if (!button) return;
    const move = Number(button.dataset.feedExpand);
    const reasoning = button.closest(".agent-feed__reasoning");
    const expanded = !reasoning.classList.contains("is-expanded");
    reasoning.classList.toggle("is-expanded", expanded);
    button.setAttribute("aria-expanded", String(expanded));
    button.textContent = expanded ? "Show less" : "Show more";
    if (expanded) state.expandedReasoning.add(move);
    else state.expandedReasoning.delete(move);
  });

  // ---- live image -----------------------------------------------------------

  const captionEl = document.getElementById("run-live-caption");

  function cancelReplayFrameResolution() {
    state.replayFrameRequest += 1;
    if (state.replayFrameTimer) clearTimeout(state.replayFrameTimer);
    state.replayFrameTimer = null;
  }

  function resolveReplayFrame(turn) {
    if (isPrime || isVision || !state.replayCursors.has("primary")) return;
    cancelReplayFrameResolution();
    const requestId = state.replayFrameRequest;
    const requestedTurn = Math.max(0, Number(turn) || 0);

    const attempt = async (retries = 0) => {
      try {
        const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/frame?turn=${requestedTurn}`);
        const payload = await response.json();
        if (requestId !== state.replayFrameRequest || replayTurn("primary") !== requestedTurn) return;
        const renderedTurn = Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : requestedTurn;
        if (payload.url && renderedTurn === requestedTurn) {
          showImage(payload.url, renderedTurn);
          return;
        }
        if (payload.pending && retries < 12) {
          state.replayFrameTimer = setTimeout(() => attempt(retries + 1), 250);
        }
      } catch (_error) {
        // The observation remains visible; a later manual step can try again.
      }
    };

    void attempt();
  }

  function showImage(url, turn) {
    if (!url) return;
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
    if (observation.board && observation.mode !== "vision") {
      showAsciiBoard(observation.board);
    }
    if (observation.mode === "json" && observation.json_observation) {
      showJsonObservation(observation.json_observation, turn);
    }
    if (observation.frame_url) {
      cancelReplayFrameResolution();
      showImage(observation.frame_url, turn);
      return;
    }

    const hasRenderedImage = Boolean(state.lastImageUrl || liveImage?.src);
    liveImage.hidden = !hasRenderedImage;
    livePlaceholder.hidden = hasRenderedImage;
    livePlaceholder.classList.add("is-history");
    const label = livePlaceholder?.querySelector("span:last-child");
    if (label) label.textContent = observation.mode === "vision"
      ? `No saved vision frame for move ${turn}`
      : `Rendering move ${turn}…`;
    if (captionEl) {
      const turnLabel = turn === 0 ? "move 0 · starting state" : `after move ${turn}`;
      captionEl.textContent = hasRenderedImage ? `${turnLabel} · rendered view catching up` : turnLabel;
      captionEl.hidden = false;
    }
    if (observation.mode !== "vision" && state.playingView !== "primary") resolveReplayFrame(turn);
  }

  async function refreshLatestJsonObservation() {
    if (
      !isJson ||
      state.jsonObservationPending ||
      state.replayCursors.has("primary") ||
      state.jsonObservationTurn >= state.afterTurn
    ) return;

    const turn = state.afterTurn;
    state.jsonObservationPending = true;
    try {
      const response = await fetch(
        `/api/agent/runs/${encodeURIComponent(runId)}/observation?instance=primary&turn=${turn}`
      );
      if (!response.ok) return;
      const observation = await response.json();
      if (observation.board) showAsciiBoard(observation.board);
      if (observation.json_observation) {
        showJsonObservation(observation.json_observation, observation.turn);
      }
    } finally {
      state.jsonObservationPending = false;
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
    const track = document.getElementById("run-replay-track");
    const label = document.getElementById("run-replay-label");
    const progressBox = document.getElementById("run-replay-progress");
    const video = document.getElementById("run-video");
    const videoUrl = `/agent-runs/${encodeURIComponent(runId)}/files/maze_replay.mp4`;

    if (run.has_video) {
      section.hidden = false;
      progressBox.hidden = true;
      downloadVideoButton.href = videoUrl;
      downloadVideoButton.hidden = false;
      if (!state.videoShown) {
        video.src = `${videoUrl}?v=${encodeURIComponent(run.video_snapshot_turns || run.turns || Date.now())}`;
        video.hidden = false;
        state.videoShown = true;
      }
      return;
    }

    downloadVideoButton.hidden = true;

    if (run.video_status === "failed") {
      section.hidden = true;
      progressBox.hidden = false;
      bar.style.width = "0%";
      track?.setAttribute("aria-valuenow", "0");
      label.textContent = run.video_error || "Video generation failed. You can try again.";
      return;
    }

    // Rendering in progress (paused snapshot or terminal replay).
    const rendering = run.video_status === "rendering";
    if (rendering || (progress && progress.percent != null && progress.phase !== "done")) {
      section.hidden = true;
      progressBox.hidden = false;
      const pct = progress && Number.isFinite(progress.percent) ? progress.percent : 0;
      bar.style.width = `${pct}%`;
      track?.setAttribute("aria-valuenow", String(Math.round(pct)));
      const phase = progress && progress.phase ? progress.phase : "starting";
      const eta = progress && Number.isFinite(progress.eta_ms)
        ? ` · about ${formatDuration(progress.eta_ms)} left`
        : " · measuring render speed…";
      const detail = progress && progress.current != null && progress.total != null
        ? ` · ${progress.current}/${progress.total} ${progress.unit || ""}`
        : "";
      label.textContent = `${phase}${detail} · ${pct}%${eta}`;
      return;
    }

    section.hidden = true;
    progressBox.hidden = true;
    track?.setAttribute("aria-valuenow", "0");
    video.hidden = true;
    video.removeAttribute("src");
    video.load();
    state.videoShown = false;
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
      const initialBoardStateHash = String(progress.initial_board_state_hash || "");
      if (initialBoardStateHash && initialBoardStateHash !== state.initialBoardStateHash) {
        state.initialBoardStateHash = initialBoardStateHash;
        state.heatmapDirty = true;
      }
      const initialPlayer = heatmapPosition(progress.initial_player);
      if (
        initialPlayer &&
        (initialPlayer.x !== state.initialPlayer?.x || initialPlayer.y !== state.initialPlayer?.y)
      ) {
        state.initialPlayer = initialPlayer;
        state.heatmapDirty = true;
      }
      state.instanceActivity = progress.instance_activity || state.instanceActivity;

      describeRun(progress.run);
      renderTokenUsage(progress.token_usage);
      renderStats(progress.run);
      renderSwarmViews(progress.swarm_views);

      if (isPrime) {
        // Hosted Prime lifecycle and logs stream immediately. The actions,
        // usage, boards, and replay are enriched from the finalized sample.
        ingestActions(progress.actions || []);
        if (isJson) void refreshLatestJsonObservation();
        ingestReasoning(progress.reasoning || []);
        renderExplorationCharts();
        renderFeed();
        renderMainReplayControls();
        const seeEmpty = document.getElementById("run-see-empty");
        if (seeEmpty && boardEl && boardEl.textContent) {
          seeEmpty.hidden = true;
        }
        updateReplay(progress.run, progress.replay_progress);
      } else {
        ingestActions(progress.actions || []);
        if (isJson) void refreshLatestJsonObservation();
        ingestReasoning(progress.reasoning || []);
        renderExplorationCharts();
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
        const previousLogScrollTop = logEl.scrollTop;
        const previousLogScrollLeft = logEl.scrollLeft;
        logEl.append(document.createTextNode(progress.log_chunk));
        logEl.scrollTop = previousLogScrollTop;
        logEl.scrollLeft = previousLogScrollLeft;
      }
      state.logOffset = progress.log_offset;

      const running = ["running", "pausing", "stopping"].includes(progress.run.status);
      // Prime renders its replay inside the same process, so the run stays
      // "running" while the video builds; don't treat a terminal-without-video
      // Prime run as still-rendering (the video step is best-effort there).
      const waitingForVideo = !running && progress.run.video_status === "rendering";
      const waitingForPrimeSync = !running && progress.run.prime_evaluation_sync_status === "syncing";
      if (running) {
        if (progress.run.status === "pausing") {
          setStatus(`Pausing after move ${progress.run.pause_after_turn || "the next completed action"}…`);
        } else if (progress.run.status === "stopping") {
          setStatus(progress.run.auto_quit_triggered
            ? "Auto-quitting — state novelty reached the configured threshold."
            : "Stopping…");
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
        setStatus(progress.run.status === "paused"
          ? "Paused — rendering a replay snapshot…"
          : "Rendering the replay video…");
        state.timer = setTimeout(poll, 2000);
      } else if (waitingForPrimeSync) {
        setStatus("Run ended — syncing the evaluation to your Prime dashboard…");
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
        const rolloutError = String(progress.run.rollout_error || "").trim();
        setStatus(
          progress.run.auto_quit_triggered && progress.run.status === "finished"
            ? `Auto-quit — ${Number(progress.run.auto_quit_percentage).toFixed(1)}% of observed states were new (${progress.run.auto_quit_novel_states}/${progress.run.auto_quit_observed_states}).`
            : progress.run.status === "failed" && rolloutError
            ? `Run failed — ${rolloutError}.`
            : progress.run.status !== "finished"
              ? `Run ${progress.run.status}.`
            : isPrime
              ? ""
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

  primeSyncButton?.addEventListener("click", async () => {
    try {
      primeSyncButton.disabled = true;
      primeSyncButton.textContent = "Syncing to Prime…";
      await runAction("prime-sync");
      setStatus("Syncing the evaluation to your Prime dashboard…");
      clearTimeout(state.timer);
      state.timer = setTimeout(poll, 500);
    } catch (error) {
      primeSyncButton.disabled = false;
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
      state.run = payload.run || state.run;
      renderControls(state.run);
      updateReplay(state.run, null);
      clearTimeout(state.timer);
      poll();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  continueButton?.addEventListener("click", async () => {
    const answer = window.prompt("How many more moves should it run?", "10");
    if (answer === null) return;
    const requestedMoves = Number(answer);
    const moves = Number.isFinite(requestedMoves) && requestedMoves > 0
      ? Math.floor(requestedMoves)
      : 0;
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

  async function startVideoGeneration(action, statusMessage) {
    generateVideoButton.disabled = true;
    regenerateVideoButton.disabled = true;
    try {
      const payload = await runAction(action);
      state.run = payload.run || state.run;
      renderControls(state.run);
      updateReplay(state.run, { phase: "starting", percent: 0 });
      setStatus(statusMessage);
      clearTimeout(state.timer);
      poll();
    } catch (error) {
      generateVideoButton.disabled = false;
      regenerateVideoButton.disabled = false;
      setStatus(error.message, true);
    }
  }

  generateVideoButton?.addEventListener("click", () => {
    startVideoGeneration("video", "Generating replay video…");
  });

  regenerateVideoButton?.addEventListener("click", () => {
    startVideoGeneration("video/regenerate", "Regenerating replay video…");
  });

  cancelVideoButton?.addEventListener("click", async () => {
    cancelVideoButton.disabled = true;
    try {
      const payload = await runAction("video/cancel");
      state.run = payload.run || state.run;
      renderControls(state.run);
      updateReplay(state.run, null);
      setStatus("Replay video generation canceled.");
      clearTimeout(state.timer);
      poll();
    } catch (error) {
      cancelVideoButton.disabled = false;
      setStatus(error.message, true);
    }
  });

  notesInput?.addEventListener("input", () => renderNotesState());
  notesInput?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (!notesSaveButton.disabled) void saveRunNotes();
    }
  });
  notesSaveButton?.addEventListener("click", saveRunNotes);

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

  const asciiBoardResizeObserver = window.ResizeObserver && boardWrap
    ? new window.ResizeObserver(() => requestAnimationFrame(fitAsciiBoard))
    : null;
  asciiBoardResizeObserver?.observe(boardWrap);

  describeRun(initial);
  renderStats(initial);
  renderMainReplayControls();
  if (notesInput) notesInput.value = state.savedNotes;
  renderNotesState();
  poll();
})();
