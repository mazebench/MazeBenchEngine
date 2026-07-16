const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  killPlaywrightBrowserProcess,
  playwrightBrowserProcess,
  signalProcessGroup
} = require("../scripts/playwright-process");

const ROOT_DIR = path.resolve(__dirname, "..");
const RENDERER = path.join(ROOT_DIR, "scripts", "maze-render-frame.js");
const BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(100);
  }
  throw new Error(message);
}

function startRenderer() {
  const child = spawn(process.execPath, [RENDERER, "--serve"], {
    cwd: ROOT_DIR,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let buffer = "";
  let stderr = "";
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line) waiters.shift()?.resolve(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    waiters.splice(0).forEach((waiter) => waiter.reject(error));
  });
  child.on("close", (code) => {
    const error = new Error(`renderer exited with ${code}: ${stderr.trim()}`);
    waiters.splice(0).forEach((waiter) => waiter.reject(error));
  });

  return {
    child,
    request(message) {
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    }
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    wait(25_000).then(() => {
      throw new Error("renderer did not exit within 25 seconds");
    })
  ]);
}

async function runCase(stop) {
  const renderer = startRenderer();
  let browserInfo = null;
  try {
    const response = await renderer.request({
      command: "init",
      draft: true,
      fast: true,
      gameId: "maze",
      height: 128,
      levelId: "level_HxI",
      view: "top-diagonal",
      width: 128,
      yaw: 0
    });
    assert.equal(response.ok, true);
    assert.ok(Number(response.browser_pid) > 1, "renderer should report its Playwright browser PID");
    browserInfo = playwrightBrowserProcess(response.browser_pid);
    assert.ok(browserInfo, "reported browser PID should be a live Playwright browser");
    assert.ok(fs.existsSync(browserInfo.profile), "Playwright profile should exist while rendering");

    await stop(renderer);
    await waitForExit(renderer.child);
    await waitFor(
      () => !playwrightBrowserProcess(browserInfo.pid) && !fs.existsSync(browserInfo.profile),
      5000,
      `browser ${browserInfo.pid} or profile survived renderer shutdown`
    );
  } finally {
    if (browserInfo) killPlaywrightBrowserProcess(browserInfo);
    signalProcessGroup(renderer.child.pid, "SIGKILL");
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT_DIR, "node_modules", "playwright-core"))) {
    console.log("renderer-lifecycle: skipped (playwright-core is not installed)");
    return;
  }
  const hasSystemBrowser = BROWSERS.some((browser) => fs.existsSync(browser));
  const hasBundledBrowser =
    fs.existsSync("/ms-playwright") || Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (!hasSystemBrowser && !hasBundledBrowser) {
    console.log("renderer-lifecycle: skipped (no Chromium-family browser is installed)");
    return;
  }

  await runCase(async (renderer) => {
    const response = await renderer.request({ command: "close" });
    assert.equal(response.closing, true);
  });
  await runCase(async (renderer) => {
    renderer.child.kill("SIGTERM");
  });
  console.log("renderer-lifecycle: browser and profile cleanup verified");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
