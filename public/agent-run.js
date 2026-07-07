(() => {
  const initial = window.__AGENT_RUN__ || {};
  const runId = initial.id;
  const isVision = initial.mode === "vision";
  const statusEl = document.getElementById("run-status");
  const boardEl = document.getElementById("run-board");
  const boardWrap = document.getElementById("run-board-wrap");
  const feedEl = document.getElementById("run-feed");
  const logEl = document.getElementById("run-log");
  const stopButton = document.getElementById("stop-run");
  const liveImage = document.getElementById("run-live-image");
  const livePlaceholder = document.getElementById("run-live-placeholder");

  const state = {
    afterTurn: 0,
    logOffset: 0,
    run: initial,
    timer: null,
    moves: new Map(), // move# -> { action, room, gems, flags }
    reasoning: new Map(), // move# -> reasoning text
    lastRenderedTurn: 0,
    frameRendering: false,
    videoShown: false
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

  function describeRun(run) {
    document.getElementById("run-title").textContent =
      `${run.model}${run.model_name ? ` (${run.model_name})` : ""} on ${run.game_title || run.game_id}`;
    const bits = [
      `run ${run.id}`,
      run.level_id ? `level ${levelLabel(run.level_id)}` : null,
      run.moves ? `${run.moves} move budget` : null,
      run.mode,
      run.kind === "local" ? (run.container ? "container" : "host") : "prime verifiers",
      run.note || ""
    ].filter(Boolean);
    document.getElementById("run-meta").textContent = bits.join(" · ");
  }

  function renderStats(run) {
    const chips = [
      ["status", run.status],
      ["moves", `${run.turns}/${run.moves}`],
      ["gems", String(run.gem_count ?? 0)],
      ["room", levelLabel(run.current_room)],
      run.solved ? ["result", "SOLVED"] : null
    ].filter(Boolean);
    document.getElementById("run-stats").innerHTML = chips
      .map(
        ([label, value]) =>
          `<span class="agent-stat"><span class="agent-stat__label">${escapeText(label)}</span> ${escapeText(value)}</span>`
      )
      .join("");
    stopButton.hidden = !(run.status === "running" || run.status === "stopping");
  }

  // ---- combined moves + reasoning feed --------------------------------------

  function ingestActions(actions) {
    for (const action of actions) {
      const flags = [
        action.moved === false ? "blocked" : null,
        action.player_dead ? "died" : null,
        action.solved ? "SOLVED" : null
      ].filter(Boolean);
      state.moves.set(action.turn, {
        action: action.command_text,
        room: levelLabel(action.current_room),
        gems: action.gem_count ?? 0,
        flags
      });
      if (action.level && !isVision) {
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
        if (entry.reasoning) state.reasoning.set(entry.move, entry.reasoning);
        // Reasoning distill also carries the action + result; fill gaps from it.
        if (!state.moves.has(entry.move)) {
          state.moves.set(entry.move, {
            action: entry.action,
            room: levelLabel(entry.room),
            gems: entry.gems ?? 0,
            flags: [entry.moved === false ? "blocked" : null, entry.player_dead ? "died" : null].filter(Boolean)
          });
        }
      }
    }
  }

  function renderFeed() {
    const moveNums = [...state.moves.keys()].sort((a, b) => a - b);
    if (!moveNums.length) {
      feedEl.innerHTML = '<p class="muted">Waiting for the agent\'s first move…</p>';
      return;
    }
    feedEl.innerHTML = moveNums
      .map((num) => {
        const move = state.moves.get(num);
        const reasoning = state.reasoning.get(num);
        const meta = [`${escapeText(move.room)}`, `${escapeText(move.gems)} gems`, ...move.flags.map(escapeText)]
          .filter(Boolean)
          .join(" · ");
        return `<div class="agent-feed__row">
          <div class="agent-feed__head">
            <span class="agent-feed__num">${escapeText(num)}</span>
            <span class="agent-feed__action">${escapeText(move.action)}</span>
            <span class="agent-feed__meta">${meta}</span>
          </div>
          ${reasoning ? `<p class="agent-feed__reasoning">${escapeText(reasoning)}</p>` : ""}
        </div>`;
      })
      .join("");
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  // ---- live image -----------------------------------------------------------

  function showImage(url) {
    if (!url) return;
    liveImage.src = url + (url.includes("?") ? "" : `?t=${Date.now()}`);
    liveImage.hidden = false;
    livePlaceholder.hidden = true;
  }

  // Text-mode runs have no agent frames, so render one on demand for the latest
  // turn (throttled to one render at a time so we never queue browser boots).
  async function maybeRenderTextFrame() {
    if (isVision || state.frameRendering) return;
    const latest = state.afterTurn;
    if (latest <= state.lastRenderedTurn) return;

    state.frameRendering = true;
    try {
      const response = await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/frame?turn=${latest}`);
      const payload = await response.json();
      if (payload.url) {
        showImage(payload.url);
        state.lastRenderedTurn = latest;
      } else if (payload.error && livePlaceholder && !liveImage.src) {
        livePlaceholder.querySelector("span:last-child").textContent = payload.error;
      }
    } catch (error) {
      /* transient — try again next tick */
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

    // Rendering in progress (run finished but the mp4 isn't ready yet).
    const rendering = run.status !== "running" && run.video && !run.has_video;
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

      describeRun(progress.run);
      renderStats(progress.run);
      ingestActions(progress.actions || []);
      ingestReasoning(progress.reasoning || []);
      renderFeed();

      if (isVision && progress.vision_frame_url) {
        showImage(progress.vision_frame_url);
      } else if (!isVision) {
        maybeRenderTextFrame();
      }

      if (progress.log_chunk) {
        logEl.textContent += progress.log_chunk;
        logEl.scrollTop = logEl.scrollHeight;
      }
      state.logOffset = progress.log_offset;

      updateReplay(progress.run, progress.replay_progress);

      const running = progress.run.status === "running" || progress.run.status === "stopping";
      const waitingForVideo = !running && progress.run.video && !progress.run.has_video;
      if (running) {
        setStatus(progress.run.status === "stopping" ? "Stopping…" : "Live — the agent is playing.");
        state.timer = setTimeout(poll, 1500);
      } else if (waitingForVideo) {
        setStatus("Run finished — rendering the replay video…");
        state.timer = setTimeout(poll, 2000);
      } else {
        setStatus(
          progress.run.status === "finished"
            ? `Finished — ${progress.run.gem_count ?? 0} gems in ${progress.run.turns} moves${progress.run.solved ? " (solved!)" : ""}.`
            : `Run ${progress.run.status}.`,
          progress.run.status === "failed"
        );
      }
    } catch (error) {
      setStatus(error.message, true);
      state.timer = setTimeout(poll, 4000);
    }
  }

  stopButton?.addEventListener("click", async () => {
    try {
      await fetch(`/api/agent/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
      setStatus("Stopping…");
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // In vision mode the ASCII board is irrelevant (the agent only sees images),
  // so show just the image, centered.
  if (isVision) {
    boardWrap.hidden = true;
    document.getElementById("run-live-grid").classList.add("is-image-only");
  }

  describeRun(initial);
  renderStats(initial);
  poll();
})();
