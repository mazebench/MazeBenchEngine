(() => {
  const initial = window.__AGENT_RUN__ || {};
  const runId = initial.id;
  const isVision = initial.mode === "vision";
  // Prime Verifiers runs have no local maze board / frames / per-move reasoning;
  // the page shows a log-centric view, so skip all maze-specific rendering.
  const isPrime = initial.kind === "prime" || initial.model === "prime";
  const statusEl = document.getElementById("run-status");
  const boardEl = document.getElementById("run-board");
  const boardWrap = document.getElementById("run-board-wrap");
  const feedEl = document.getElementById("run-feed");
  const logEl = document.getElementById("run-log");
  const stopButton = document.getElementById("stop-run");
  const pauseButton = document.getElementById("pause-run");
  const resumeButton = document.getElementById("resume-run");
  const continueButton = document.getElementById("continue-run");
  const deleteButton = document.getElementById("delete-run");
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
    lastImageUrl: null,
    frameRendering: false,
    frameFailures: 0,
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
      run.reasoning ? `reasoning ${run.reasoning}` : null,
      run.continued ? `continued ×${run.continued}` : null,
      run.kind === "local" ? (run.container ? "container" : "host") : "prime verifiers",
      run.note || ""
    ].filter(Boolean);
    document.getElementById("run-meta").textContent = bits.join(" · ");
  }

  function renderStats(run) {
    const chips = isPrime
      ? [
          ["status", run.status],
          ["turn budget", String(run.moves ?? "")],
          run.turns ? ["moves", String(run.turns)] : null,
          run.turns ? ["gems", String(run.gem_count ?? 0)] : null,
          run.solved ? ["result", "SOLVED"] : null
        ].filter(Boolean)
      : [
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
    renderControls(run);
  }

  function renderControls(run) {
    stopButton.hidden = !(run.status === "running" || run.status === "stopping");
    pauseButton.hidden = !run.pausable;
    resumeButton.hidden = !run.resumable;
    continueButton.hidden = !run.continuable;
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

  const captionEl = document.getElementById("run-live-caption");

  function showImage(url, turn) {
    if (!url) return;
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
      captionEl.textContent = `after move ${turn}`;
      captionEl.hidden = false;
    }
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
        state.frameFailures = 0;
        showImage(payload.url, latest);
        state.lastRenderedTurn = latest;
      } else if (payload.error) {
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

      if (isPrime) {
        // Prime isn't live; the board, per-move reasoning, and replay video are
        // all built from the eval results once it finishes, so ingest whatever
        // has landed. In text mode ingestActions fills the ASCII board.
        ingestActions(progress.actions || []);
        ingestReasoning(progress.reasoning || []);
        renderFeed();
        const seeEmpty = document.getElementById("run-see-empty");
        if (seeEmpty && boardEl && boardEl.textContent) {
          seeEmpty.hidden = true;
        }
        updateReplay(progress.run, progress.replay_progress);
      } else {
        ingestActions(progress.actions || []);
        ingestReasoning(progress.reasoning || []);
        renderFeed();

        if (isVision && progress.vision_frame_url) {
          showImage(progress.vision_frame_url, state.afterTurn);
        } else if (!isVision) {
          maybeRenderTextFrame();
        }

        updateReplay(progress.run, progress.replay_progress);
      }

      if (progress.log_chunk) {
        logEl.textContent += progress.log_chunk;
        logEl.scrollTop = logEl.scrollHeight;
      }
      state.logOffset = progress.log_offset;

      const running = progress.run.status === "running" || progress.run.status === "stopping";
      // Prime renders its replay inside the same process, so the run stays
      // "running" while the video builds; don't treat a terminal-without-video
      // Prime run as still-rendering (the video step is best-effort there).
      const waitingForVideo = !isPrime && !running && progress.run.video && !progress.run.has_video;
      if (running) {
        if (progress.run.status === "stopping") {
          setStatus("Stopping…");
        } else if (isPrime) {
          const rp = progress.replay_progress;
          setStatus(
            rp && rp.phase && rp.phase !== "done"
              ? `Rendering replay video… ${rp.percent ?? 0}%`
              : "Live — Prime's Verifiers eval is running."
          );
        } else {
          setStatus("Live — the agent is playing.");
        }
        state.timer = setTimeout(poll, 1500);
      } else if (waitingForVideo) {
        setStatus("Run finished — rendering the replay video…");
        state.timer = setTimeout(poll, 2000);
      } else if (progress.run.status === "paused") {
        setStatus(
          progress.run.pause_reason === "quota"
            ? `Paused — out of funds/credits/usage${
                progress.run.pause_message ? `: ${progress.run.pause_message}` : ""
              }. Resume once you have credits.`
            : "Paused. Resume to pick up where it left off.",
          progress.run.pause_reason === "quota"
        );
        // Keep polling slowly so the page reflects a resume from elsewhere.
        state.timer = setTimeout(poll, 4000);
      } else {
        setStatus(
          progress.run.status !== "finished"
            ? `Run ${progress.run.status}.`
            : isPrime
              ? `Eval finished — ${progress.run.turns || 0} move${progress.run.turns === 1 ? "" : "s"}${
                  progress.run.has_video ? ", replay video above" : ""
                }; see the runner log for rewards and scores.`
              : `Finished — ${progress.run.gem_count ?? 0} gems in ${progress.run.turns} moves${progress.run.solved ? " (solved!)" : ""}.`,
          progress.run.status === "failed"
        );
        // The text-mode image renders async and lags the board; keep polling
        // until it catches up to the final move so the two end up in sync.
        // Give up after a few consecutive renderer failures — otherwise a
        // finished run whose renderer keeps erroring polls forever.
        if (!isPrime && !isVision && state.lastRenderedTurn < state.afterTurn && state.frameFailures < 5) {
          maybeRenderTextFrame();
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
      setStatus("Paused. Resume to pick up where it left off.");
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
  poll();
})();
