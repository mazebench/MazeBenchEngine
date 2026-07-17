const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createSolverExportService,
  normalizeSolutionExportRequest,
  solutionExportFileName
} = require("../server/solver-exports");
const { replayOptions, solutionActions } = require("../scripts/maze-export-solution");

const root = path.join(__dirname, "..");
const authorSource = fs.readFileSync(path.join(root, "public", "author.js"), "utf8");
const replaySource = fs.readFileSync(
  path.join(root, "scripts", "maze-export-replay.js"),
  "utf8"
);
const routerSource = fs.readFileSync(path.join(root, "server", "router.js"), "utf8");

const playData = {
  actors: [{ type: "player", x: 0, y: 0 }],
  editorRender: false,
  height: 1,
  terrain: [[{ type: "floor" }]],
  width: 1
};

assert.deepEqual(normalizeSolutionExportRequest({ path: "uDlR", playData }, "GIF"), {
  format: "gif",
  path: "UDLR",
  playData
});
assert.throws(
  () => normalizeSolutionExportRequest({ path: "UX", playData }, "mp4"),
  /only U, D, L, and R/
);
assert.throws(
  () => normalizeSolutionExportRequest({ path: "U", playData }, "webm"),
  /mp4 or gif/
);
assert.throws(
  () => normalizeSolutionExportRequest({ path: "U", playData: { width: 0 } }, "mp4"),
  /snapshot is invalid/
);
assert.equal(
  solutionExportFileName("draft / one", "level_AxB", "mp4"),
  "draft-one-level_AxB-solution.mp4"
);
assert.deepEqual(solutionActions("UDLR"), ["up", "down", "left", "right"]);
assert.equal(replayOptions().format, "mp4");
assert.equal(replayOptions().accelerated, true);

assert.match(authorSource, /class="solver-dock__minimize"/);
assert.match(authorSource, /function setSolverDockMinimized\(minimized, options = \{\}\)/);
assert.match(authorSource, /classList\.add\("is-layout-tweening"\)/);
assert.match(authorSource, /cubic-bezier\(0\.22, 1, 0\.36, 1\)/);
assert.match(authorSource, /setSolverDockMinimized\(true\);[\s\S]*?state\.isSolutionPlaying = true/);
assert.match(authorSource, /class="solver-dock__export-format"/);
assert.match(authorSource, /option value="mp4">MP4<\/option><option value="gif">GIF<\/option>/);
assert.match(authorSource, /solverGhostIconSvg/);
assert.match(authorSource, /solverMinimizeIconSvg/);
assert.match(authorSource, /solverStopIconSvg/);
assert.match(authorSource, /solverDismissIconSvg/);
assert.match(authorSource, /Play Solution/);
assert.match(authorSource, /class="solver-dock__stop-playback"/);
assert.match(authorSource, /function stopSolutionPlayback\(\)/);
assert.match(authorSource, /solutionPlaybackAbortController/);
assert.match(authorSource, /playbackController\.signal\.aborted/);
assert.match(authorSource, /function downloadSolutionExport\(requestedFormat\)/);
assert.match(authorSource, /function showSolutionExportProgress\(format, progress/);
assert.match(authorSource, /await waitForSolutionExport\(job, format\)/);
assert.match(authorSource, /editorRender: false/);
assert.match(authorSource, /authorData\.solutionExportApiUrl/);
assert.match(routerSource, /segments\[4\] === "solution-export"/);
assert.match(routerSource, /solverExports\.start/);
assert.match(routerSource, /solverExports\.status/);
assert.match(routerSource, /solverExports\.artifact/);
assert.match(routerSource, /Content-Disposition/);
assert.match(replaySource, /if \(mazeOptions\.playData\)/);
assert.match(replaySource, /app\.applyLevelState\(playData/);

async function testExportJobLifecycle() {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-solver-export-test-"));
  const scriptsDir = path.join(fakeRoot, "scripts");
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(
    path.join(scriptsDir, "maze-export-solution.js"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const [, outputDir, , fileName] = process.argv.slice(2);',
      'fs.writeFileSync(path.join(outputDir, "replay-progress.json"), JSON.stringify({ phase: "capturing", percent: 42, current: 21, total: 50, unit: "frames" }));',
      'setTimeout(() => fs.writeFileSync(path.join(outputDir, fileName), "rendered"), 20);'
    ].join("\n"),
    "utf8"
  );

  try {
    const service = createSolverExportService({ env: process.env, rootDir: fakeRoot });
    const started = service.start({
      format: "mp4",
      gameId: "maze",
      levelId: "level_AxA",
      payload: { path: "R", playData }
    });
    const identity = { gameId: "maze", jobId: started.id, levelId: "level_AxA" };
    assert.equal(started.status, "rendering");

    let status = started;
    for (let attempt = 0; attempt < 100 && status.status === "rendering"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = service.status(identity);
    }

    assert.equal(status.status, "ready");
    assert.equal(status.progress.percent, 100);
    const artifact = service.artifact(identity);
    assert.equal(artifact.contentType, "video/mp4");
    assert.equal(fs.readFileSync(artifact.filePath, "utf8"), "rendered");
    artifact.cleanup();
    assert.equal(service.status(identity), null);
  } finally {
    fs.rmSync(fakeRoot, { force: true, recursive: true });
  }
}

testExportJobLifecycle()
  .then(() => {
    console.log("solver-export: OK — solver solutions minimize and export through play mode.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
