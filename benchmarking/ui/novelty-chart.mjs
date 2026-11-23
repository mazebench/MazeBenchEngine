import { rollingNovelty } from "./novelty-series.mjs";

const canvas = document.getElementById("novelty-chart");
const picker = document.getElementById("novelty-window");
const custom = document.getElementById("novelty-window-custom");
const windowValue = document.getElementById("novelty-window-value");
const storageKey = "mazebench.noveltyWindow";
let windowSize = 100;
let lastValues = [];
let lastToolsEnabled = false;
try {
  const saved = Number(localStorage.getItem(storageKey));
  if (Number.isSafeInteger(saved) && saved > 0) windowSize = saved;
} catch { /* Browser storage is optional. */ }

function syncPicker() {
  const preset = [...picker.options].some(option => option.value === String(windowSize));
  picker.value = preset ? String(windowSize) : "custom";
  custom.hidden = preset;
  custom.value = String(windowSize);
}

function updateWindow(value) {
  const next = Number(value);
  if (!Number.isSafeInteger(next) || next < 1) return false;
  windowSize = next;
  try { localStorage.setItem(storageKey, String(windowSize)); } catch {}
  drawNovelty(lastValues, lastToolsEnabled);
  return true;
}

picker.addEventListener("change", () => {
  custom.hidden = picker.value !== "custom";
  if (picker.value === "custom") {
    custom.value = String(windowSize);
    custom.focus();
    custom.select();
  } else {
    updateWindow(picker.value);
  }
});
custom.addEventListener("input", () => updateWindow(custom.value));
custom.addEventListener("change", () => {
  if (!updateWindow(custom.value)) custom.value = String(windowSize);
});
syncPicker();

function setCanvasSize(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(280, Math.floor(canvas.clientWidth || 600));
  const height = Math.max(160, Math.floor(canvas.clientHeight || 220));
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

export function drawNovelty(values, toolsEnabled) {
  lastValues = values;
  lastToolsEnabled = toolsEnabled;
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#090b0e";
  context.fillRect(0, 0, width, height);
  const rolling = rollingNovelty(values, windowSize);
  canvas.setAttribute("aria-label", `Novelty rate from action 0 (initial state), rolling window of ${windowSize} recorded states`);
  if (!rolling.length) { windowValue.textContent = "No recorded states yet"; return; }
  const moves = rolling.length - 1;
  const count = Math.min(windowSize, moves);
  const range = moves ? `${moves < windowSize ? "first" : "last"} ${count.toLocaleString()} move${count === 1 ? "" : "s"}` : "initial state";
  windowValue.textContent = `${Math.round(rolling.at(-1) * 100)}% · ${range}`;
  const padding = { left: 34, right: 18, top: 20, bottom: 26 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  context.font = "10px ui-monospace, monospace";
  context.textAlign = "right";
  context.fillStyle = "#6f7985";
  context.strokeStyle = "#20252c";
  context.lineWidth = 1;
  for (const rate of [0, 0.5, 1]) {
    const y = padding.top + chartHeight * (1 - rate);
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
    context.fillText(`${Math.round(rate * 100)}%`, padding.left - 6, y + 3);
  }
  const xAt = (index) => padding.left + (moves ? index / moves * chartWidth : 0);
  const yAt = (rate) => padding.top + (1 - rate) * chartHeight;
  const accent = toolsEnabled ? "#ffbd5b" : "#6cd7ff";
  const gradient = context.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
  gradient.addColorStop(0, toolsEnabled ? "rgba(255,189,91,.28)" : "rgba(108,215,255,.28)");
  gradient.addColorStop(1, "rgba(8,9,11,0)");
  context.beginPath();
  rolling.forEach((rate, index) => {
    const x = xAt(index);
    const y = yAt(rate);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.lineTo(xAt(rolling.length - 1), padding.top + chartHeight);
  context.lineTo(xAt(0), padding.top + chartHeight);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
  context.beginPath();
  rolling.forEach((rate, index) => {
    const x = xAt(index);
    const y = yAt(rate);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.stroke();
  if (!moves) {
    context.beginPath();
    context.arc(xAt(0), yAt(rolling[0]), 3, 0, Math.PI * 2);
    context.fillStyle = accent;
    context.fill();
  }
  context.fillStyle = "#6f7985";
  context.textAlign = "left";
  context.fillText("action 0", padding.left, height - 7);
  if (moves) {
    context.textAlign = "right";
    context.fillText(`action ${moves}`, width - padding.right, height - 7);
  }
}

