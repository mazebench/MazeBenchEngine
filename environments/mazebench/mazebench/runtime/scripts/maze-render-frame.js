#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function normalizeDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return DIRECTIONS.has(direction) ? direction : "";
}

function normalizeLevelToken(value) {
  return String(value || "").trim().replace(/^level_/i, "").toUpperCase();
}

function parseCommandLine(line) {
  const cleaned = String(line || "").trim();

  if (!cleaned) {
    return null;
  }

  if (cleaned.startsWith("{")) {
    try {
      const payload = JSON.parse(cleaned);
      const command = String(payload.command || payload.action || "").trim().toLowerCase();
      const direction = normalizeDirection(payload.direction);

      if (command === "move" && direction) {
        return { command: "move", direction };
      }
      if ((command === "rotate_camera" || command === "rotate") && direction) {
        return { command: "rotate_camera", direction };
      }
      if (command === "reset" || command === "reset_level") {
        return { command: "reset_level" };
      }
      if (command === "undo" || command === "quit") {
        return { command };
      }
      if (command === "goto_level" || command === "go_to_level" || command === "goto") {
        const level = normalizeLevelToken(payload.level);
        const x = String(payload.x || level[0] || "").toUpperCase();
        const y = String(payload.y || level[2] || "").toUpperCase();

        if (/^[A-Z]$/.test(x) && /^[A-Z]$/.test(y)) {
          return { command: "goto_level", x, y };
        }
      }
    } catch {
      return null;
    }
  }

  const lower = cleaned.toLowerCase();

  if (DIRECTIONS.has(lower)) {
    return { command: "move", direction: lower };
  }
  if (lower === "undo" || lower === "quit") {
    return { command: lower };
  }
  if (lower === "reset" || lower === "reset level" || lower === "reset_level") {
    return { command: "reset_level" };
  }

  let match = lower.match(/^rotate\s+camera\s+(up|down|left|right)$/);
  if (match) {
    return { command: "rotate_camera", direction: match[1] };
  }

  match = cleaned.match(/^go\s+to\s+level\s+([A-Za-z])\s+([A-Za-z])$/i);
  if (match) {
    return { command: "goto_level", x: match[1].toUpperCase(), y: match[2].toUpperCase() };
  }

  return null;
}

async function launchBrowser(chromium, browserName = "") {
  const requested = String(browserName || "").trim().toLowerCase();
  const candidates = [];

  if (requested && !["chrome", "brave", "chromium", "edge"].includes(requested)) {
    candidates.push(browserName);
  } else if (requested === "chrome") {
    candidates.push(DEFAULT_BROWSER_PATHS[0]);
  } else if (requested === "brave") {
    candidates.push(DEFAULT_BROWSER_PATHS[1]);
  } else if (requested === "chromium") {
    candidates.push(DEFAULT_BROWSER_PATHS[2]);
  } else if (requested === "edge") {
    candidates.push(DEFAULT_BROWSER_PATHS[3]);
  } else {
    candidates.push(...DEFAULT_BROWSER_PATHS);
  }

  let lastError = null;
  for (const executablePath of candidates) {
    if (!fs.existsSync(executablePath)) {
      continue;
    }
    try {
      return await chromium.launch({
        executablePath,
        args: ["--disable-gpu", "--use-angle=swiftshader"],
        headless: true
      });
    } catch (error) {
      lastError = error;
    }
  }

  try {
    return await chromium.launch({
      args: ["--disable-gpu", "--use-angle=swiftshader"],
      headless: true
    });
  } catch (error) {
    throw lastError || error;
  }
}

async function startServer() {
  const { createRequestHandler } = require(path.join(ROOT_DIR, "server", "app"));
  const server = http.createServer(createRequestHandler());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Could not start local maze server");
  }

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    port: address.port
  };
}

async function waitUntilSettled(page, maxFrames = 90) {
  await page.evaluate(async (frameLimit) => {
    function isBusy() {
      const app = window.__PIXEL_GAME_APP__;
      return Boolean(
        app?.isAnimating ||
          app?.isTransitioningLevel ||
          app?.threeRenderer?.isDebugCameraAnimating?.()
      );
    }

    for (let index = 0; index < frameLimit; index += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      if (!isBusy()) {
        break;
      }
    }
  }, maxFrames);
}

async function captureFrame(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    const app = window.__PIXEL_GAME_APP__;
    const canvas =
      app?.canvas ||
      app?.viewCanvas ||
      app?.sceneCanvas ||
      document.getElementById("maze-canvas");

    if (!canvas) {
      throw new Error("Could not find maze canvas");
    }

    return canvas.toDataURL("image/png");
  });
}

async function renderFrame(payload) {
  const { chromium } = await import("playwright-core");
  const options = {
    actions: Array.isArray(payload.actions) ? payload.actions : [],
    browser: String(payload.browser || ""),
    cameraStepDegrees: Number(payload.cameraStepDegrees || 18),
    cameraTiltDegrees: Number(payload.cameraTiltDegrees || 58),
    cameraZoom: Number(payload.cameraZoom || 1),
    draft: payload.draft !== false,
    fast: payload.fast !== false,
    gameId: String(payload.gameId || "maze"),
    height: Number(payload.height || 512),
    levelId: String(payload.levelId || "level_HxI"),
    width: Number(payload.width || 512),
    yaw: Number(payload.yaw || 0)
  };
  const server = await startServer();
  const browser = await launchBrowser(chromium, options.browser);

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { width: options.width, height: options.height }
    });
    const levelUrl = `http://127.0.0.1:${server.port}/play/${encodeURIComponent(
      options.gameId
    )}/${encodeURIComponent(options.levelId)}`;

    await page.addInitScript(() => {
      window.__PIXEL_GAME_DEBUG__ = true;
      window.__PIXEL_GAME_REPLAY_CAPTURE__ = true;
    });
    await page.goto(levelUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const app = window.__PIXEL_GAME_APP__;
      return Boolean(app?.movement && app?.threeRenderer && app?.render);
    });
    await page.addStyleTag({
      content: `
        html, body {
          background: #050608 !important;
          height: 100% !important;
          margin: 0 !important;
          overflow: hidden !important;
          width: 100% !important;
        }
        .play-shell {
          display: block !important;
          height: 100vh !important;
          min-height: 100vh !important;
          width: 100vw !important;
        }
        .play-header {
          display: none !important;
        }
        .play-stage,
        .maze-frame {
          border: 0 !important;
          border-radius: 0 !important;
          box-shadow: none !important;
          height: 100vh !important;
          margin: 0 !important;
          max-height: none !important;
          max-width: none !important;
          padding: 0 !important;
          width: 100vw !important;
        }
        #maze-canvas {
          display: block !important;
          height: 100vh !important;
          width: 100vw !important;
        }
      `
    });
    await page.evaluate(async ({ draft, fast, height, width }) => {
      const app = window.__PIXEL_GAME_APP__;

      if (draft) {
        const scale = Math.max(
          0.1,
          Math.min(1, width / app.viewportRect.width, height / app.viewportRect.height)
        );
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => scale
        });
      }

      window.dispatchEvent(new Event("resize"));
      app.syncPlayLayout?.();
      app.setupCanvas?.();
      app.state.effects.fuzzyEnabled = !draft;
      app.state.effects.edgeOutlinesEnabled = !draft;
      app.state.effects.noisePhase = 0;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      app.syncFuzzyToggle?.();
      app.syncEdgeToggle?.();

      if (fast) {
        [
          "MOVE_DURATION_MS",
          "GATE_RISE_DURATION_MS",
          "GATE_FALL_DURATION_MS",
          "ORANGE_WALL_RISE_DURATION_MS",
          "ORANGE_WALL_FALL_DURATION_MS",
          "PLAYER_LIFT_RISE_DURATION_MS",
          "PLAYER_LIFT_FALL_DURATION_MS",
          "HOLE_FALL_DURATION_MS",
          "LEVEL_TRANSITION_DURATION_MS"
        ].forEach((key) => {
          if (Number.isFinite(app[key])) {
            app[key] = 1;
          }
        });
      }

      await app.preloadImages?.();
      await app.threeRendererReady;
      app.syncCameraTarget?.(true);
      app.render?.();
    }, options);

    let cameraTiltDegrees = options.cameraTiltDegrees;
    let cameraYawTurns = ((options.yaw % 4) + 4) % 4;

    async function setCameraView() {
      await page.evaluate(
        ({ tiltDegrees, yawTurns, zoom }) => {
          const tilt = (tiltDegrees * Math.PI) / 180;
          window.__PIXEL_GAME_APP__?.threeRenderer?.setDebugCameraView?.({
            animate: false,
            mode: "perspective",
            tilt,
            yaw: yawTurns * (Math.PI / 2),
            zoom
          });
        },
        { tiltDegrees: cameraTiltDegrees, yawTurns: cameraYawTurns, zoom: options.cameraZoom }
      );
      await waitUntilSettled(page, 20);
    }

    await setCameraView();
    await waitUntilSettled(page);

    for (const commandText of options.actions) {
      const parsed = parseCommandLine(commandText);
      if (!parsed) {
        continue;
      }

      if (parsed.command === "move") {
        const key = {
          down: "ArrowDown",
          left: "ArrowLeft",
          right: "ArrowRight",
          up: "ArrowUp"
        }[parsed.direction];
        await page.keyboard.press(key);
        await waitUntilSettled(page);
      } else if (parsed.command === "rotate_camera") {
        if (parsed.direction === "left") {
          cameraYawTurns -= 1;
        } else if (parsed.direction === "right") {
          cameraYawTurns += 1;
        } else if (parsed.direction === "up") {
          cameraTiltDegrees = Math.max(20, cameraTiltDegrees - options.cameraStepDegrees);
        } else if (parsed.direction === "down") {
          cameraTiltDegrees = Math.min(82, cameraTiltDegrees + options.cameraStepDegrees);
        }
        await setCameraView();
      } else if (parsed.command === "undo") {
        await page.keyboard.press("z");
        await waitUntilSettled(page);
      } else if (parsed.command === "reset_level") {
        await page.keyboard.press("r");
        await waitUntilSettled(page);
      } else if (parsed.command === "goto_level") {
        const levelId = `level_${parsed.x}x${parsed.y}`;
        await page.evaluate(async (nextLevelId) => {
          const app = window.__PIXEL_GAME_APP__;
          const response = await fetch(
            `/api/play/${encodeURIComponent(app.currentGameId)}/${encodeURIComponent(nextLevelId)}`
          );

          if (!response.ok) {
            throw new Error(`Could not load ${nextLevelId}`);
          }

          const levelState = await response.json();
          app.applyLevelState(levelState, {
            deferRender: true,
            immediateCamera: true,
            resetHistory: false,
            resetLevelEntry: true
          });
          await app.preloadImagesForLevelState?.(levelState);
          app.render?.();
        }, levelId);
        await waitUntilSettled(page);
      }
    }

    await setCameraView();
    return await captureFrame(page);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function main() {
  const payload = JSON.parse(readStdin() || "{}");
  const dataUrl = await renderFrame(payload);
  process.stdout.write(`${JSON.stringify({ data_url: dataUrl })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  renderFrame
};
