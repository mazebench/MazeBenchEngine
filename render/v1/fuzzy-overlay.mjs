// Lightweight overlay adapted from MazeBenchEngine's fuzzy CRT effect. The
// original values use 10 noise phases at 8 FPS with a 0.1 grain amplitude.

const NOISE_SIZE = 128;
const NOISE_PHASES = 10;
const NOISE_FRAME_MS = 1000 / 8;

function fract(value) {
  return value - Math.floor(value);
}

function sourceNoise(x, y, phase) {
  const phaseX = phase * 7;
  const phaseY = phase * 13;
  return fract(Math.sin((x + phaseX) * 12.9898 + (y + phaseY) * 78.233) * 43758.5453);
}

function noiseTile(phase) {
  const tile = document.createElement("canvas");
  tile.width = NOISE_SIZE;
  tile.height = NOISE_SIZE;
  const context = tile.getContext("2d", { alpha: true });
  const image = context.createImageData(NOISE_SIZE, NOISE_SIZE);
  for (let y = 0; y < NOISE_SIZE; y += 1) {
    for (let x = 0; x < NOISE_SIZE; x += 1) {
      const index = (y * NOISE_SIZE + x) * 4;
      const value = Math.round(sourceNoise(x, y, phase) * 255);
      image.data[index] = value;
      image.data[index + 1] = value;
      image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return tile;
}

export class MazeFuzzyOverlayV1 {
  constructor(sourceCanvas, enabled = true) {
    this.sourceCanvas = sourceCanvas;
    this.enabled = enabled;
    this.phase = 0;
    this.lastFrame = 0;
    this.frameId = 0;
    this.tiles = enabled
      ? Array.from({ length: NOISE_PHASES }, (_, phase) => noiseTile(phase))
      : [];
    this.canvas = document.createElement("canvas");
    this.canvas.className = "maze-fuzzy-overlay";
    this.canvas.setAttribute("aria-hidden", "true");
    this.sourceCanvas.classList.add("maze-render-canvas");
    if (enabled && sourceCanvas.parentElement) {
      sourceCanvas.insertAdjacentElement("afterend", this.canvas);
      this.resize();
      this.paint();
      this.frameId = requestAnimationFrame((now) => this.step(now));
    }
  }

  resize() {
    if (!this.enabled) return;
    const width = Math.max(1, Math.round(this.sourceCanvas.clientWidth));
    const height = Math.max(1, Math.round(this.sourceCanvas.clientHeight));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  paint() {
    if (!this.enabled) return;
    this.resize();
    const context = this.canvas.getContext("2d", { alpha: true });
    const pattern = context.createPattern(this.tiles[this.phase], "repeat");
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = pattern;
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  step(now) {
    if (!this.enabled) return;
    if (now - this.lastFrame >= NOISE_FRAME_MS) {
      this.lastFrame = now;
      this.phase = (this.phase + 1) % NOISE_PHASES;
      this.paint();
    }
    this.frameId = requestAnimationFrame((next) => this.step(next));
  }
}
