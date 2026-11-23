import { IceSession, goalsCovered, iceAscii, parseIceLevel } from "./engine.mjs";
const elements = Object.fromEntries(["board", "loading", "moves", "covered", "status", "undo", "reset", "next-level", "level-title", "level-list", "level-total", "world-progress", "progress-count"].map(id => [id, document.getElementById(id)]));
const progressKey = "mazebench.ice-maze.v1.progress";
let world, session, index = 0, animation = null, frame = 0, gesture = null;
let completed = {};
try { const saved = JSON.parse(localStorage.getItem(progressKey) || "{}"); if (saved && typeof saved === "object" && !Array.isArray(saved)) completed = saved; } catch { /* Browser persistence is optional. */ }

function draw() {
  if (!session) return;
  const canvas = elements.board;
  const size = Math.max(200, canvas.clientWidth), scale = Math.min(3, devicePixelRatio || 1);
  if (canvas.width !== Math.round(size * scale)) { canvas.width = Math.round(size * scale); canvas.height = canvas.width; }
  const ctx = canvas.getContext("2d"), level = session.level, cell = size / Math.max(level.width, level.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, size, size);
  for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
    const wall = level.terrain[y][x] === "#";
    ctx.fillStyle = wall ? "#273c4c" : "#c2e6f3"; ctx.fillRect(x * cell, y * cell, cell, cell);
    if (!wall) {
      ctx.strokeStyle = "#a8d4e5"; ctx.lineWidth = 1; ctx.strokeRect(x * cell + .5, y * cell + .5, cell - 1, cell - 1);
      ctx.strokeStyle = "#e8f9ff"; ctx.beginPath(); ctx.moveTo((x + .25) * cell, (y + .67) * cell); ctx.lineTo((x + .72) * cell, (y + .4) * cell); ctx.stroke();
    }
  }
  for (const p of level.goals) {
    ctx.fillStyle = "#e9af68"; ctx.beginPath(); ctx.arc((p.x + .5) * cell, (p.y + .5) * cell, cell * .24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#a7662a"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#fff0d9"; ctx.beginPath(); ctx.arc((p.x + .5) * cell, (p.y + .5) * cell, cell * .1, 0, Math.PI * 2); ctx.fill();
  }
  let players = session.players;
  if (animation) {
    const t = Math.min(1, (performance.now() - animation.start) / 220), eased = t * t * (3 - 2 * t);
    players = animation.paths.map(path => { const a = path[0], b = path.at(-1); return { x: a.x + (b.x - a.x) * eased, y: a.y + (b.y - a.y) * eased }; });
    if (t === 1) { animation = null; sync(); }
  }
  for (const [i, p] of players.entries()) {
    const covered = !animation && level.goals.some(goal => goal.x === p.x && goal.y === p.y);
    ctx.fillStyle = "#47758255"; ctx.beginPath(); ctx.ellipse((p.x + .5) * cell, (p.y + .69) * cell, cell * .3, cell * .13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = covered ? "#168a5b" : "#28aa78"; ctx.strokeStyle = "#106044"; ctx.lineWidth = Math.max(1, cell * .035);
    ctx.beginPath(); ctx.arc((p.x + .5) * cell, (p.y + .47) * cell, cell * .29, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#e1fff0"; ctx.font = `700 ${Math.round(cell * .26)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(covered ? "✓" : String(i + 1), (p.x + .5) * cell, (p.y + .47) * cell);
  }
  if (animation) frame = requestAnimationFrame(draw);
}

function sync(message) {
  const covered = goalsCovered(session.level, session.players), won = session.solved;
  elements.moves.textContent = session.moves;
  elements.covered.textContent = `${covered} / ${session.level.goals.length}`;
  elements.undo.disabled = !session.history.length || Boolean(animation);
  elements["next-level"].hidden = !won || index === world.levels.length - 1 || Boolean(animation);
  elements.status.classList.toggle("solved", won);
  elements.status.textContent = message || (won ? index === world.levels.length - 1 ? "Final level solved. Beautifully done!" : "Every goal is covered. Level complete!" : "Use arrow keys or WASD to slide everyone together.");
  elements.board.setAttribute("aria-label", `Level ${index + 1}, ${session.players.length} players, ${covered} of ${session.level.goals.length} goals covered. ${iceAscii(session.level, session.players)}`);
  if (won) {
    completed[index + 1] = Math.min(Number.isInteger(completed[index + 1]) ? completed[index + 1] : Infinity, session.moves);
    try { localStorage.setItem(progressKey, JSON.stringify(completed)); } catch { /* Optional. */ }
  }
  let count = 0;
  for (const button of elements["level-list"].children) {
    const n = Number(button.dataset.level), done = Number.isInteger(completed[n]) && completed[n] >= 0;
    button.classList.toggle("complete", done); if (done) count++;
    if (n === index + 1) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
    button.setAttribute("aria-label", `Level ${n}${done ? `, solved in ${completed[n]} moves` : ""}`);
  }
  elements["progress-count"].textContent = `${count} / ${world.levels.length}`; elements["world-progress"].value = count;
}

function selectLevel(number, updateUrl = true) {
  if (!Number.isInteger(number) || number < 1 || number > world.levels.length) number = 1;
  cancelAnimationFrame(frame); animation = null; index = number - 1; session = new IceSession(world.levels[index]);
  elements["level-title"].textContent = `Level ${number}`; document.title = `Ice Maze · Level ${number} · MazeBench`;
  if (updateUrl) { const url = new URL(location.href); url.searchParams.set("level", number); history.replaceState(null, "", url); }
  sync(); draw();
}
function move(direction) {
  if (!session || animation) return;
  const result = session.move(direction);
  if (!result.changed) { sync(session.solved ? undefined : "No room to slide in that direction."); return; }
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) animation = { start: performance.now(), paths: result.paths };
  sync(); draw();
}
function undo() { if (!session || animation) return; session.undo(); sync(); draw(); }
elements.undo.addEventListener("click", undo);
elements.reset.addEventListener("click", () => { if (session) selectLevel(index + 1); });
elements["next-level"].addEventListener("click", () => { if (session.solved) selectLevel(index + 2); });
elements["level-list"].addEventListener("click", event => { const button = event.target.closest("button[data-level]"); if (button) selectLevel(Number(button.dataset.level)); });
document.querySelectorAll("[data-direction]").forEach(button => button.addEventListener("click", () => move(button.dataset.direction)));
addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  const direction = { ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", ArrowLeft: "left", w: "up", d: "right", s: "down", a: "left" }[event.key];
  if (direction) { event.preventDefault(); move(direction); }
  else if (event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
  else if (event.key.toLowerCase() === "r" && session) { event.preventDefault(); selectLevel(index + 1); }
});
elements.board.addEventListener("pointerdown", event => { gesture = { x: event.clientX, y: event.clientY }; elements.board.setPointerCapture(event.pointerId); });
elements.board.addEventListener("pointerup", event => {
  if (!gesture) return; const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y; gesture = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 18) return;
  move(Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "down" : "up");
});
elements.board.addEventListener("pointercancel", () => { gesture = null; });
new ResizeObserver(() => { if (!animation) draw(); }).observe(elements.board);
try {
  const response = await fetch("../../level-data/ice-maze/v1/world.json"); if (!response.ok) throw new Error("Ice Maze levels could not be loaded.");
  world = await response.json(); world.levels.forEach(parseIceLevel);
  elements["level-total"].textContent = `1–${world.levels.length}`; elements["world-progress"].max = world.levels.length;
  for (const level of world.levels) { const button = document.createElement("button"); button.type = "button"; button.textContent = level.id; button.dataset.level = level.id; elements["level-list"].append(button); }
  elements.loading.hidden = true; selectLevel(Number(new URLSearchParams(location.search).get("level") || 1));
} catch (error) { elements.loading.textContent = error.message; elements.status.textContent = "Please reload to try again."; }
