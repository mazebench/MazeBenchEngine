import { parseSlotskiLevel, moveSlotski, slotskiSolved, slotskiAscii, expandSlotskiSequence, validateSlotskiAction } from "./engine.mjs";

const response = await fetch("../../level-data/slotski/v1/world.json");
if (!response.ok) throw new Error("Could not load Slotski.");
const world = await response.json(), level = parseSlotskiLevel(world.levels[0]);
let blocks = structuredClone(level.blocks), history = [], moves = 0, selected = level.target;
const board = document.getElementById("board"), status = document.getElementById("status");

function render(message = "") {
  const focused = document.activeElement?.dataset.block;
  board.replaceChildren(...blocks.map(block => {
    const button = document.createElement("button");
    button.className = `block${block.id === level.target ? " target" : ""}`;
    button.dataset.block = block.id; button.textContent = block.id;
    button.setAttribute("aria-label", `Block ${block.id}, ${block.width} by ${block.height}, column ${block.x + 1}, row ${block.y + 1}`);
    button.setAttribute("aria-pressed", String(block.id === selected));
    for (const [key, value] of Object.entries({ x: block.x, y: block.y, w: block.width, h: block.height })) button.style.setProperty(`--${key}`, value);
    return button;
  }));
  if (focused) board.querySelector(`[data-block="${focused}"]`)?.focus({ preventScroll: true });
  const solved = slotskiSolved(level, blocks);
  document.getElementById("move-count").textContent = `${moves} move${moves === 1 ? "" : "s"}`;
  document.getElementById("selection").textContent = `Block ${selected} selected`;
  document.getElementById("undo").disabled = !history.length;
  for (const button of document.querySelectorAll("[data-direction]")) button.disabled = solved;
  document.getElementById("ascii").textContent = slotskiAscii(level, blocks);
  status.textContent = solved ? `Solved in ${moves} moves! A reached the exit.` : message || "Select a block, then use the arrows or WASD to move one cell.";
}
function apply(action) {
  if (action === "reset") { blocks = structuredClone(level.blocks); history = []; moves = 0; return true; }
  if (action === "undo") { if (history.length) { blocks = history.pop(); moves--; } return true; }
  if (slotskiSolved(level, blocks)) return false;
  const result = moveSlotski(level, blocks, action); selected = action[0];
  if (result.changed) { history.push(structuredClone(blocks)); blocks = result.blocks; moves++; }
  return result.changed;
}
function act(action) { const changed = apply(action); render(changed ? "" : `Block ${selected} is blocked in that direction.`); }
board.addEventListener("click", event => { if (event.target.dataset.block) { selected = event.target.dataset.block; render(); } });
for (const button of document.querySelectorAll("[data-direction]")) button.addEventListener("click", () => act(selected + button.dataset.direction));
document.getElementById("undo").addEventListener("click", () => act("undo"));
document.getElementById("reset").addEventListener("click", () => act("reset"));
document.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.matches("input, textarea, select")) return;
  const direction = { ArrowUp: "U", ArrowDown: "D", ArrowLeft: "L", ArrowRight: "R", w: "U", s: "D", a: "L", d: "R" }[event.key];
  if (direction) { event.preventDefault(); act(selected + direction); }
});
document.getElementById("commands").addEventListener("submit", event => {
  event.preventDefault();
  try {
    const actions = expandSlotskiSequence(document.getElementById("sequence").value);
    for (const action of actions) validateSlotskiAction(level, action);
    let blocked = 0;
    for (const action of actions) { if (slotskiSolved(level, blocks)) break; if (!apply(action)) blocked++; }
    render(blocked ? `${blocked} blocked move${blocked === 1 ? "" : "s"}; remaining moves applied in order.` : "Sequence applied.");
  } catch (error) { status.textContent = error.message; }
});
render();
