import { drawNovelty } from "../ui/novelty-chart.mjs";

const ids = [
  "connection-status", "load-error", "error-copy", "run-content", "model-hero", "run-failure", "run-failure-reason", "retry-new-run",
  "model-monogram", "run-kicker", "run-title", "run-subtitle", "run-id", "run-status",
  "pause-run", "resume-run", "stop-run", "delete-run", "pair-compare", "stat-actions", "stat-gems", "stat-rooms", "stat-cells",
  "stat-novelty", "stat-blocked", "stat-deaths", "stat-tokens", "board-room", "board-move",
  "board", "frame-first", "frame-previous", "frame-play", "frame-next", "frame-last",
  "frame-scrubber", "frame-position", "frame-source", "replay-speed", "heatmap", "heatmap-count", "novelty-value", "novelty-chart", "progress-value",
  "progress-chart", "feed-count", "feed", "workspace-title", "isolation-status",
  "workspace-files", "continuations", "final-message", "interview-state", "new-interview",
  "interview-count", "interview-list", "interview-active-title", "interview-snapshot",
  "end-interview", "interview-fork", "interview-messages", "interview-form", "interview-question",
  "interview-status", "interview-send"
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const runId = new URLSearchParams(location.search).get("id");
let polling = false;
let stoppedPolling = false;
let currentRun = null;
let currentFrame = 0;
let followingLatest = true;
let playbackTimeout = null;
let playbackActive = false;
let playbackGeneration = 0;
let frameRequest = 0;
const frameCache = new Map();
let currentInterview = null;
let currentInterviewLibrary = null;
let selectedInterviewId = null;
let creatingInterview = false;
let refreshPromise = null;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

function statusLabel(value) {
  return String(value || "unknown").replaceAll("-", " ");
}

function isFinished(run) {
  return ["completed", "failed", "stopped"].includes(run.status);
}

function compactDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatNumber(value) {
  return new Intl.NumberFormat(undefined, { notation: value >= 100_000 ? "compact" : "standard" })
    .format(Number(value) || 0);
}

function usageTotal(usage) {
  if (!usage) return 0;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  return (usage.input_tokens || usage.inputTokens || 0) + (usage.output_tokens || usage.outputTokens || 0);
}

function modelMonogram(model) {
  const meaningful = String(model || "M").split(/[-_.]/).filter(Boolean).filter((part) => !/^(gpt|codex|5|6)$/.test(part));
  return (meaningful.at(-1)?.[0] || "M").toUpperCase();
}

function conditionLabel(run) {
  return run.tools_enabled ? "Python workspace enabled" : "No Python workspace";
}

function setCanvasSize(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(280, Math.floor(canvas.clientWidth || 600));
  const height = Math.max(160, Math.floor(canvas.clientHeight || 220));
  const targetWidth = Math.floor(width * ratio);
  const targetHeight = Math.floor(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function renderBoard(display) {
  elements.board.replaceChildren();
  const coloredRows = Array.isArray(display?.colored_level) ? display.colored_level : [];
  if (coloredRows.length) {
    for (const segments of coloredRows) {
      const row = document.createElement("div");
      row.className = "ascii-row";
      for (const segment of segments) {
        const span = document.createElement("span");
        span.textContent = String(segment.text || "");
        if (/^#[0-9a-f]{6}$/i.test(segment.color || "")) span.style.color = segment.color;
        row.append(span);
      }
      elements.board.append(row);
    }
  } else {
    const fallback = document.createElement("pre");
    fallback.textContent = display?.level || "Waiting for the first observation…";
    elements.board.append(fallback);
  }
  elements.board.setAttribute("aria-label", display?.level ? `Current ASCII maze board\n${display.level}` : "Current ASCII maze board");
}

function syncTransport() {
  const maximum = currentRun?.action_count || 0;
  elements["frame-scrubber"].max = String(maximum);
  elements["frame-scrubber"].value = String(currentFrame);
  elements["frame-position"].textContent = `${currentFrame} / ${maximum}`;
  elements["frame-first"].disabled = currentFrame <= 0;
  elements["frame-previous"].disabled = currentFrame <= 0;
  elements["frame-next"].disabled = currentFrame >= maximum;
  elements["frame-last"].disabled = currentFrame >= maximum;
}

function stopPlayback() {
  playbackActive = false;
  playbackGeneration += 1;
  if (playbackTimeout) clearTimeout(playbackTimeout);
  playbackTimeout = null;
  elements["frame-play"].textContent = "▶ Play";
  elements["frame-play"].classList.remove("playing");
  elements["frame-play"].setAttribute("aria-pressed", "false");
}

async function showFrame(index, { keepPlaying = false } = {}) {
  if (!currentRun) return;
  const maximum = currentRun.action_count || 0;
  const selected = Math.max(0, Math.min(maximum, Math.round(Number(index) || 0)));
  const request = ++frameRequest;
  currentFrame = selected;
  followingLatest = selected === maximum;
  syncTransport();

  if (selected === maximum && currentRun.display) {
    renderBoard(currentRun.display);
    elements["board-room"].textContent = `Room ${currentRun.display.room || currentRun.room || "—"}`;
    elements["board-move"].textContent = `move ${selected}`;
    elements["frame-source"].textContent = "Live engine frame · exact colors";
  } else {
    elements["frame-source"].textContent = `Rendering move_${selected}.txt with engine colors…`;
    let snapshot = frameCache.get(selected);
    if (!snapshot) snapshot = await api(
      `/api/benchmark/v1/runs/${encodeURIComponent(runId)}/display/${selected}`
    );
    frameCache.set(selected, snapshot);
    if (request !== frameRequest) return;
    renderBoard(snapshot);
    elements["board-room"].textContent = `Room ${snapshot.room}`;
    elements["board-move"].textContent = `move ${selected}`;
    elements["frame-source"].textContent = `${snapshot.source_record || `records/move_history/move_${selected}.txt`} · exact engine colors`;
  }

  if (!keepPlaying) stopPlayback();
}

function waitForPlayback(delay, generation) {
  return new Promise((resolve) => {
    playbackTimeout = setTimeout(() => {
      playbackTimeout = null;
      resolve(playbackActive && playbackGeneration === generation);
    }, delay);
  });
}

async function startPlayback() {
  if (!currentRun) return;
  if (playbackActive) {
    stopPlayback();
    return;
  }
  playbackActive = true;
  const generation = ++playbackGeneration;
  elements["frame-play"].textContent = "❚❚ Pause";
  elements["frame-play"].classList.add("playing");
  elements["frame-play"].setAttribute("aria-pressed", "true");
  try {
    const maximum = currentRun.action_count || 0;
    if (currentFrame >= maximum) await showFrame(0, { keepPlaying: true });
    while (playbackActive && playbackGeneration === generation && currentFrame < maximum) {
      const shouldAdvance = await waitForPlayback(replayDelay(), generation);
      if (!shouldAdvance) return;
      await showFrame(currentFrame + 1, { keepPlaying: true });
    }
    if (playbackGeneration === generation) stopPlayback();
  } catch (error) {
    if (playbackGeneration === generation) {
      stopPlayback();
      elements["frame-source"].textContent = error.message;
    }
  }
}

function replayDelay() {
  const delay = Math.max(20, Math.min(5000, Math.round(Number(elements["replay-speed"].value) || 220)));
  elements["replay-speed"].value = String(delay);
  return delay;
}

function heatColor(fraction) {
  const stops = [
    [20, 26, 34],
    [255, 213, 87],
    [255, 126, 58],
    [222, 55, 92],
    [148, 72, 214]
  ];
  const scaled = Math.min(0.999, Math.max(0, fraction)) * (stops.length - 1);
  const index = Math.floor(scaled);
  const blend = scaled - index;
  const left = stops[index];
  const right = stops[Math.min(index + 1, stops.length - 1)];
  const channel = (position) => Math.round(left[position] + (right[position] - left[position]) * blend);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function drawHeatmap(positions, toolsEnabled) {
  const { context, width, height } = setCanvasSize(elements.heatmap);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#07090c";
  context.fillRect(0, 0, width, height);
  const valid = (positions || []).filter((position) => position && Number.isFinite(position.worldX) && Number.isFinite(position.worldY));
  elements["heatmap-count"].textContent = `${valid.length} visit${valid.length === 1 ? "" : "s"}`;
  if (!valid.length) return;

  const counts = new Map();
  for (const position of valid) {
    const key = `${position.worldX},${position.worldY}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const points = [...counts].map(([key, count]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, count };
  });
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const columns = Math.max(5, maxX - minX + 1);
  const rows = Math.max(5, maxY - minY + 1);
  const padding = 24;
  const cell = Math.max(3, Math.min((width - padding * 2) / columns, (height - padding * 2) / rows));
  const offsetX = (width - columns * cell) / 2;
  const offsetY = (height - rows * cell) / 2;
  const maximum = Math.max(...points.map((point) => point.count));

  context.strokeStyle = "#151a21";
  context.lineWidth = 1;
  for (let column = 0; column <= columns; column += 1) {
    const x = offsetX + column * cell;
    context.beginPath();
    context.moveTo(x, offsetY);
    context.lineTo(x, offsetY + rows * cell);
    context.stroke();
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = offsetY + row * cell;
    context.beginPath();
    context.moveTo(offsetX, y);
    context.lineTo(offsetX + columns * cell, y);
    context.stroke();
  }
  for (const point of points) {
    const intensity = Math.log2(point.count + 1) / Math.log2(maximum + 1);
    context.fillStyle = heatColor(intensity);
    context.fillRect(
      offsetX + (point.x - minX) * cell + 1,
      offsetY + (point.y - minY) * cell + 1,
      Math.max(1, cell - 2),
      Math.max(1, cell - 2)
    );
  }
  const current = valid.at(-1);
  context.strokeStyle = toolsEnabled ? "#ffbd5b" : "#6cd7ff";
  context.lineWidth = 2;
  context.strokeRect(
    offsetX + (current.worldX - minX) * cell + 1,
    offsetY + (current.worldY - minY) * cell + 1,
    Math.max(1, cell - 2),
    Math.max(1, cell - 2)
  );
}

function drawProgress(run) {
  const { context, width, height } = setCanvasSize(elements["progress-chart"]);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#090b0e";
  context.fillRect(0, 0, width, height);
  const accent = run.tools_enabled ? "#ffbd5b" : "#6cd7ff";
  const rows = [
    { label: "Gems", value: run.gems_collected || 0, total: run.gems_total || 100 },
    { label: "Action budget", value: run.action_count || 0, total: run.action_limit || Math.max(1, run.action_count || 1) }
  ];
  const left = 108;
  const right = 52;
  const barWidth = Math.max(80, width - left - right);
  context.font = "11px ui-monospace, monospace";
  rows.forEach((row, index) => {
    const y = 54 + index * 75;
    const fraction = Math.max(0, Math.min(1, row.value / Math.max(1, row.total)));
    context.fillStyle = "#8c96a2";
    context.textAlign = "right";
    context.fillText(row.label, left - 14, y + 4);
    context.fillStyle = "#20252c";
    context.fillRect(left, y - 9, barWidth, 18);
    context.fillStyle = accent;
    context.fillRect(left, y - 9, barWidth * fraction, 18);
    context.fillStyle = "#dfe6eb";
    context.textAlign = "left";
    context.fillText(`${row.value}/${run.action_limit === null && index === 1 ? "∞" : row.total}`, left + 8, y + 4);
    context.fillStyle = "#8c96a2";
    context.textAlign = "right";
    context.fillText(`${Math.round(fraction * 100)}%`, width - 12, y + 4);
  });
}

function feedText(entry) {
  if (entry.type === "tool") {
    const input = entry.arguments && Object.keys(entry.arguments).length ? ` ${JSON.stringify(entry.arguments)}` : "";
    return `${entry.tool || "tool"}${input}`;
  }
  return entry.text || "";
}

function renderFeed(run) {
  elements.feed.replaceChildren();
  const entries = (run.feed || []).slice(-60);
  elements["feed-count"].textContent = `${entries.length} event${entries.length === 1 ? "" : "s"}`;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "Waiting for model activity…";
    elements.feed.append(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = `feed-entry${entry.type === "tool" ? " tool" : ""}`;
    const meta = document.createElement("div");
    const type = document.createElement("span");
    const time = document.createElement("time");
    type.textContent = entry.type === "agent_message" ? "model" : entry.type;
    time.textContent = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    meta.append(type, time);
    const copy = document.createElement("p");
    copy.textContent = feedText(entry);
    item.append(meta, copy);
    elements.feed.append(item);
  }
}

function renderWorkspace(run) {
  elements["workspace-files"].replaceChildren();
  elements["workspace-title"].textContent = run.tools_enabled ? "Python workspace" : "Python unavailable";
  const isolation = run.isolation || {};
  elements["isolation-status"].textContent = !run.capability_boundary_verified
    ? "legacy · not validated"
    : run.tools_enabled
      ? isolation.verified ? "OS isolation · checked" : "isolation pending"
      : "maze tools · checked";
  const files = run.workspace_files || [];
  if (!run.tools_enabled || !files.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = run.tools_enabled ? "The model has not written any files." : "This condition has no writable workspace.";
    elements["workspace-files"].append(empty);
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("span");
    const size = document.createElement("span");
    name.textContent = file.path || file.name || "file";
    size.textContent = `${formatNumber(file.bytes ?? file.size ?? 0)} B`;
    row.append(name, size);
    elements["workspace-files"].append(row);
  }
}

function renderPair(run, allRuns) {
  elements["pair-compare"].replaceChildren();
  const peers = run.pair_id ? allRuns.filter((candidate) => candidate.pair_id === run.pair_id) : [];
  if (peers.length < 2) {
    elements["pair-compare"].hidden = true;
    return;
  }
  elements["pair-compare"].hidden = false;
  for (const peer of peers.sort((left, right) => Number(left.tools_enabled) - Number(right.tools_enabled))) {
    const link = document.createElement("a");
    link.className = `pair-card${peer.tools_enabled ? " tools" : ""}${peer.id === run.id ? " selected" : ""}`;
    link.href = `./run.html?id=${encodeURIComponent(peer.id)}`;
    const label = document.createElement("span");
    label.textContent = peer.tools_enabled ? "Python on" : "Python off";
    const result = document.createElement("strong");
    result.textContent = `${peer.gems_collected || 0} gems · ${peer.action_count || 0} actions`;
    link.append(label, result);
    elements["pair-compare"].append(link);
  }
}

function interviewMessage(message) {
  const article = document.createElement("article");
  article.className = `interview-message ${message.role === "assistant" ? "model" : "user"}`;
  const meta = document.createElement("div");
  const author = document.createElement("strong");
  const time = document.createElement("time");
  author.textContent = message.role === "assistant" ? currentRun?.model || "Model" : "You";
  time.textContent = message.at
    ? new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  meta.append(author, time);
  const content = document.createElement("p");
  content.textContent = message.content || "";
  article.append(meta, content);
  return article;
}

function interviewStateLabel(status) {
  return ({
    ready: "Open",
    running: "Answering",
    queued: "Queued",
    forking: "Branching",
    failed: "Needs attention",
    ended: "Ended"
  })[status] || statusLabel(status);
}

function syncInterviewSendButton() {
  const status = currentInterview?.status;
  const blocked = ["running", "queued", "forking"].includes(status);
  const selectedOpen = Boolean(currentInterview?.available) && status !== "ended";
  const canBranch = Boolean(currentInterviewLibrary?.available) && (
    !currentInterview || status === "ended" || !currentInterview.fork_thread_id
  );
  const unanswered = status === "failed" && currentInterview?.messages?.at(-1)?.role === "user";
  const hasQuestion = Boolean(elements["interview-question"].value.trim());
  elements["interview-send"].disabled = creatingInterview || blocked || !hasQuestion || (!selectedOpen && !canBranch);
  elements["interview-send"].textContent = creatingInterview
    ? "Branching…"
    : status === "queued"
      ? "Queued"
      : unanswered
        ? "Retry question"
        : selectedOpen
          ? "Ask model"
          : canBranch
            ? "Branch & ask"
            : "Ask model";
}

function renderInterview(library, interview) {
  currentInterviewLibrary = library;
  currentInterview = interview;
  const messages = interview?.messages || [];
  const chats = library?.chats || [];
  elements["interview-count"].textContent = String(chats.length);
  elements["interview-list"].replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "interview-list-empty";
    empty.textContent = library?.available
      ? "No branches yet. Create one at the benchmark’s current moment."
      : "The benchmark thread is still starting.";
    elements["interview-list"].append(empty);
  } else {
    for (const chat of chats) {
      const row = document.createElement("button");
      const top = document.createElement("span");
      const title = document.createElement("strong");
      const state = document.createElement("i");
      const snapshot = document.createElement("small");
      row.type = "button";
      row.dataset.chatId = chat.id;
      row.className = `interview-chat-row${chat.id === selectedInterviewId ? " selected" : ""}${chat.status === "ended" ? " ended" : ""}`;
      title.textContent = chat.title;
      state.textContent = interviewStateLabel(chat.status);
      snapshot.textContent = `move ${chat.branched_at_action} · ${chat.message_count} message${chat.message_count === 1 ? "" : "s"}`;
      top.append(title, state);
      row.append(top, snapshot);
      elements["interview-list"].append(row);
    }
  }

  elements["interview-messages"].replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "interview-empty";
    const title = document.createElement("strong");
    const copy = document.createElement("p");
    title.textContent = interview ? "Ask anything about this snapshot." : "No chat selected.";
    copy.textContent = interview
      ? "Type your own question below. This branch has no tools and cannot alter the benchmark."
      : "Create a new chat to branch from the latest benchmark moment.";
    empty.append(title, copy);
    elements["interview-messages"].append(empty);
  } else {
    for (const message of messages) elements["interview-messages"].append(interviewMessage(message));
  }
  const running = interview?.status === "running";
  const queued = interview?.status === "queued";
  const forking = interview?.status === "forking";
  const ended = interview?.status === "ended";
  const available = Boolean(interview?.available) && !ended;
  elements["interview-state"].textContent = forking
    ? "Branching now"
    : running
    ? "Model answering"
    : queued
      ? "Waiting for Codex"
    : ended
      ? "Chat ended"
      : interview?.fork_thread_id
        ? "Fork active"
        : library?.available ? "Ready to branch" : "Waiting for thread";
  elements["interview-state"].className = `fork-badge${running || forking ? " running" : ""}${queued ? " queued" : ""}${interview?.fork_thread_id && !ended ? " active" : ""}`;
  elements["new-interview"].disabled = creatingInterview || !library?.available;
  elements["new-interview"].textContent = creatingInterview ? "Branching…" : "＋ New chat";
  elements["interview-active-title"].textContent = interview?.title || "Select or create a chat";
  elements["interview-snapshot"].textContent = interview
    ? `Branched at move ${interview.branched_at_action} while the run was ${statusLabel(interview.run_status_at_branch)}.`
    : "A new chat branches from the latest benchmark moment.";
  elements["interview-fork"].textContent = interview?.fork_thread_id
    ? `fork ${interview.fork_thread_id.slice(-12)}`
    : "not created";
  elements["end-interview"].disabled = !interview || running || forking || ended;
  // Let the user draft freely; only sending waits for an open interview fork.
  elements["interview-question"].disabled = running || queued;
  const unanswered = interview?.status === "failed" && messages.at(-1)?.role === "user"
    ? messages.at(-1).content
    : "";
  if (unanswered && !elements["interview-question"].value) {
    elements["interview-question"].value = unanswered;
  }
  syncInterviewSendButton();
  elements["interview-status"].textContent = interview?.error
    ? interview.error
    : queued
      ? `${interview.notice || "Codex is temporarily unavailable. Your question will retry automatically."}${interview.next_retry_at ? ` Next attempt ${new Date(interview.next_retry_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.` : ""}`
    : running
      ? "The forked model is answering…"
      : ended
        ? "This chat is read-only now. Start a new chat to branch from the benchmark’s latest moment."
      : available
        ? "Type any question. No tools or maze actions are available inside this fork."
        : library?.available
          ? "Create or select an open chat."
          : "The benchmark thread is still starting; branching will unlock automatically.";
  if (messages.length) elements["interview-messages"].scrollTop = elements["interview-messages"].scrollHeight;
}

function renderRun(run, allRuns, interviewLibrary, interview) {
  elements["run-content"].hidden = false;
  elements["load-error"].hidden = true;
  const changedRun = currentRun?.id !== run.id;
  currentRun = run;
  if (changedRun) {
    frameCache.clear();
    followingLatest = true;
  }
  document.body.classList.toggle("tools-on", Boolean(run.tools_enabled));
  document.title = `${run.model} · MazeBench record`;
  elements["model-monogram"].textContent = modelMonogram(run.model);
  elements["run-kicker"].textContent = `Codex model evaluation · ${conditionLabel(run)}`;
  elements["run-title"].textContent = run.model;
  elements["run-subtitle"].textContent = `${run.effort} reasoning · started ${compactDate(run.created_at)} · ${run.action_limit ?? "unlimited"} action limit`;
  elements["run-id"].textContent = run.id;
  elements["run-status"].textContent = statusLabel(run.status);
  elements["run-status"].className = `status-pill ${run.status}`;
  elements["run-failure"].hidden = run.status !== "failed";
  elements["run-failure-reason"].textContent = run.error || "The runner stopped before finishing. Inspect the activity record for details.";
  const terminalGame = ["won", "action-limit"].includes(run.game_status);
  const activeRun = Boolean(run.runner_active);
  const resumableBoundary = Boolean(run.capability_boundary_verified);
  elements["pause-run"].hidden = !activeRun || run.status === "pausing";
  elements["pause-run"].disabled = !activeRun;
  elements["resume-run"].hidden = terminalGame || !resumableBoundary ||
    (!["paused", "stopped"].includes(run.status) && !run.compaction_recoverable);
  elements["resume-run"].disabled = false;
  elements["stop-run"].hidden = terminalGame || ["stopped", "failed", "completed"].includes(run.status);
  elements["stop-run"].disabled = false;
  elements["delete-run"].disabled = activeRun;
  elements["delete-run"].title = activeRun ? "Stop or pause this run before deleting it." : "Permanently delete this run record.";
  elements["stat-actions"].textContent = `${run.action_count || 0}${run.action_limit ? ` / ${run.action_limit}` : ""}`;
  elements["stat-gems"].textContent = `${run.gems_collected || 0} / ${run.gems_total || 100}`;
  elements["stat-rooms"].textContent = formatNumber(run.rooms_visited || 1);
  elements["stat-cells"].textContent = formatNumber(run.unique_cells || 0);
  elements["stat-novelty"].textContent = `${Math.round((run.novelty_rate || 0) * 100)}%`;
  elements["stat-blocked"].textContent = formatNumber(run.blocked_actions || 0);
  elements["stat-deaths"].textContent = formatNumber(run.deaths || 0);
  elements["stat-tokens"].textContent = formatNumber(usageTotal(run.usage));
  elements["novelty-value"].textContent = `${Math.round((run.novelty_rate || 0) * 100)}% overall`;
  const progress = run.action_limit ? Math.min(100, (run.action_count || 0) / run.action_limit * 100) : 0;
  elements["progress-value"].textContent = run.game_status === "won" ? "objective complete" : run.action_limit ? `${Math.round(progress)}% of budget` : "unlimited run";
  elements.continuations.textContent = formatNumber(run.continuation_count || 0);
  elements["final-message"].textContent = run.final_message || (isFinished(run) ? "The model did not leave a final message." : "No final model message yet.");
  if (followingLatest || changedRun) {
    currentFrame = run.action_count || 0;
    renderBoard(run.display);
    elements["board-room"].textContent = `Room ${run.display?.room || run.room || "—"}`;
    elements["board-move"].textContent = `move ${run.display?.observation_revision ?? run.action_count ?? 0}`;
    elements["frame-source"].textContent = "Live engine frame · exact colors";
  }
  syncTransport();
  drawHeatmap(run.positions, run.tools_enabled);
  drawNovelty(run.novelty, run.tools_enabled);
  drawProgress(run);
  renderFeed(run);
  renderWorkspace(run);
  renderPair(run, allRuns);
  renderInterview(interviewLibrary, interview);
  elements["connection-status"].textContent = run.status === "failed" ? "run failed · see error details" : isFinished(run) ? `recorded · ${statusLabel(run.game_status || run.status)}` : "live · supervisor online";
  elements["connection-status"].classList.remove("error");
  stoppedPolling = isFinished(run);
}

function showError(error) {
  elements["run-content"].hidden = true;
  elements["load-error"].hidden = false;
  elements["error-copy"].textContent = error.message;
  elements["connection-status"].textContent = "record unavailable";
  elements["connection-status"].classList.add("error");
}

function refresh() {
  if (!runId) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  polling = true;
  refreshPromise = (async () => {
    try {
      const [run, library, interviewLibrary] = await Promise.all([
        api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}`),
        api("/api/benchmark/v1/runs"),
        api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`)
      ]);
      if (!interviewLibrary.chats.some((chat) => chat.id === selectedInterviewId)) {
        selectedInterviewId = interviewLibrary.chats[0]?.id || null;
      }
      const interview = selectedInterviewId
        ? await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(selectedInterviewId)}`)
        : null;
      renderRun(run, library.runs || [], interviewLibrary, interview);
    } catch (error) {
      stoppedPolling = true;
      showError(error);
    } finally {
      polling = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function refreshAfterMutation() {
  if (refreshPromise) await refreshPromise;
  return refresh();
}

elements["stop-run"].addEventListener("click", async () => {
  elements["stop-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    stoppedPolling = false;
    await refreshAfterMutation();
  } catch (error) {
    elements["stop-run"].disabled = false;
    showError(error);
  }
});

elements["pause-run"].addEventListener("click", async () => {
  elements["pause-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/pause`, { method: "POST" });
    stoppedPolling = false;
    await refreshAfterMutation();
  } catch (error) {
    elements["pause-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

elements["resume-run"].addEventListener("click", async () => {
  elements["resume-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
    stoppedPolling = false;
    await refreshAfterMutation();
  } catch (error) {
    elements["resume-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

elements["delete-run"].addEventListener("click", async () => {
  if (!currentRun || currentRun.runner_active) return;
  const confirmed = window.confirm(
    `Permanently delete ${currentRun.model} run ${currentRun.id}?\n\nThis removes its record, workspace, replay, and interview chats. This cannot be undone.`
  );
  if (!confirmed) return;
  elements["delete-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    window.location.assign("./");
  } catch (error) {
    elements["delete-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

function seekFrame(index) {
  stopPlayback();
  showFrame(index).catch((error) => {
    elements["frame-source"].textContent = error.message;
  });
}

elements["frame-first"].addEventListener("click", () => seekFrame(0));
elements["frame-previous"].addEventListener("click", () => seekFrame(currentFrame - 1));
elements["frame-play"].addEventListener("click", startPlayback);
elements["frame-next"].addEventListener("click", () => seekFrame(currentFrame + 1));
elements["frame-last"].addEventListener("click", () => seekFrame(currentRun?.action_count || 0));
elements["frame-scrubber"].addEventListener("input", (event) => seekFrame(event.currentTarget.value));
elements["replay-speed"].addEventListener("change", replayDelay);

elements["interview-list"].addEventListener("click", async (event) => {
  const row = event.target.closest("[data-chat-id]");
  if (!row) return;
  selectedInterviewId = row.dataset.chatId;
  try {
    const interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(selectedInterviewId)}`);
    renderInterview(currentInterviewLibrary, interview);
  } catch (error) {
    elements["interview-status"].textContent = error.message;
  }
});

elements["new-interview"].addEventListener("click", async () => {
  if (creatingInterview || !currentInterviewLibrary?.available) return;
  creatingInterview = true;
  renderInterview(currentInterviewLibrary, currentInterview);
  try {
    const interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`, {
      method: "POST",
      body: "{}"
    });
    selectedInterviewId = interview.id;
    creatingInterview = false;
    await refreshAfterMutation();
    elements["interview-question"].focus();
  } catch (error) {
    creatingInterview = false;
    renderInterview(currentInterviewLibrary, currentInterview);
    elements["interview-status"].textContent = error.message;
  }
});

elements["end-interview"].addEventListener("click", async () => {
  if (!currentInterview || currentInterview.status === "running") return;
  elements["end-interview"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(currentInterview.id)}/end`, {
      method: "POST",
      body: "{}"
    });
    await refreshAfterMutation();
  } catch (error) {
    elements["end-interview"].disabled = false;
    elements["interview-status"].textContent = error.message;
  }
});

elements["interview-question"].addEventListener("input", syncInterviewSendButton);

elements["interview-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = elements["interview-question"].value.trim();
  if (!question || ["running", "queued", "forking"].includes(currentInterview?.status)) return;
  let interview = currentInterview;
  let optimistic = null;
  try {
    if (!interview?.available || interview.status === "ended") {
      if (!currentInterviewLibrary?.available || creatingInterview) return;
      creatingInterview = true;
      renderInterview(currentInterviewLibrary, currentInterview);
      interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`, {
        method: "POST",
        body: "{}"
      });
      selectedInterviewId = interview.id;
      creatingInterview = false;
    }
    optimistic = {
      ...interview,
      status: "running",
      error: null,
      messages: [
        ...(interview.messages || []),
        { role: "user", content: question, at: new Date().toISOString() }
      ]
    };
    elements["interview-question"].value = "";
    renderInterview(currentInterviewLibrary, optimistic);
    const answer = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(interview.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ question })
    });
    renderInterview(currentInterviewLibrary, answer);
    await refreshAfterMutation();
  } catch (error) {
    creatingInterview = false;
    renderInterview(currentInterviewLibrary, optimistic
      ? { ...optimistic, status: "failed", error: error.message }
      : currentInterview);
    elements["interview-status"].textContent = error.message;
    elements["interview-question"].value = question;
    syncInterviewSendButton();
  }
});

window.addEventListener("resize", () => {
  if (!polling && !elements["run-content"].hidden) refresh();
});

if (!runId) {
  showError(new Error("No run id was supplied in this record URL."));
} else {
  await refresh();
  setInterval(() => {
    const liveInterview = currentInterviewLibrary?.chats?.some((chat) =>
      ["forking", "running", "queued"].includes(chat.status));
    if (!stoppedPolling || liveInterview || !currentInterviewLibrary?.available) refresh();
  }, 1500);
}

elements["retry-new-run"].addEventListener("click", async () => {
  if (!currentRun) return;
  const button = elements["retry-new-run"];
  button.disabled = true;
  try {
    const run = await api("/api/benchmark/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        model: currentRun.model, effort: currentRun.effort, tools_enabled: currentRun.tools_enabled,
        action_limit: currentRun.action_limit, start_room: currentRun.start_room
      })
    });
    location.href = `./run.html?id=${encodeURIComponent(run.id)}`;
  } catch (error) {
    elements["run-failure-reason"].textContent = error.message;
    button.disabled = false;
  }
});
