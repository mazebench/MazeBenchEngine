#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  defaultReplayOptions,
  renderReplayVideo,
  validateReplayOptions
} = require("./maze-export-replay");

const SOLUTION_DIRECTIONS = Object.freeze({
  D: "down",
  L: "left",
  R: "right",
  U: "up"
});

function solutionActions(solutionPath) {
  return Array.from(String(solutionPath || ""), (move) => {
    const direction = SOLUTION_DIRECTIONS[move];
    if (!direction) throw new Error(`Unsupported solution move: ${move}`);
    return direction;
  });
}

function replayOptions(overrides = {}) {
  return validateReplayOptions({
    ...defaultReplayOptions(),
    accelerated: true,
    crf: 19,
    fps: 24,
    height: 720,
    intro: true,
    motionScale: 4,
    nativeRecorder: true,
    preset: "veryfast",
    tailSeconds: 1,
    width: 720,
    ...overrides,
    format: "mp4"
  });
}

async function renderMp4WithFallback(actions, mazeOptions, outputDir) {
  const attempts = [
    replayOptions(),
    replayOptions({ nativeRecorder: false }),
    replayOptions({ accelerated: false, nativeRecorder: false })
  ];
  let lastError = null;

  for (const options of attempts) {
    try {
      return await renderReplayVideo(actions, mazeOptions, outputDir, options);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not render solution video.");
}

function convertMp4ToGif(mp4Path, gifPath) {
  const conversion = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      mp4Path,
      "-filter_complex",
      "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=sierra2_4a",
      "-loop",
      "0",
      gifPath
    ],
    { encoding: "utf8" }
  );

  if (conversion.error || conversion.status !== 0) {
    throw new Error(conversion.stderr || conversion.error?.message || "Could not encode GIF.");
  }
}

async function main(argv = process.argv.slice(2)) {
  const [inputPath, outputDir, format = "mp4", requestedFileName = ""] = argv;
  if (!inputPath || !outputDir || !["gif", "mp4"].includes(format)) {
    throw new Error(
      "Usage: node scripts/maze-export-solution.js <solution.json> <output-dir> <mp4|gif> [filename]"
    );
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const actions = solutionActions(payload.path);
  const mazeOptions = {
    gameId: String(payload.gameId || "maze"),
    gameWonGemCount: 100,
    levelId: String(payload.levelId || "level_HxI"),
    playData: payload.playData,
    view: "top-diagonal",
    yaw: 0
  };
  const rendered = await renderMp4WithFallback(actions, mazeOptions, resolvedOutputDir);
  const extension = format === "gif" ? ".gif" : ".mp4";
  const fallbackName = `maze-solution${extension}`;
  const outputName = path.basename(requestedFileName || fallbackName);
  const outputPath = path.join(resolvedOutputDir, outputName);

  if (format === "gif") {
    convertMp4ToGif(rendered.videoPath, outputPath);
    fs.rmSync(rendered.videoPath, { force: true });
  } else if (path.resolve(rendered.videoPath) !== path.resolve(outputPath)) {
    fs.renameSync(rendered.videoPath, outputPath);
  }

  process.stdout.write(`${outputPath}\n`);
  return outputPath;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  convertMp4ToGif,
  main,
  replayOptions,
  solutionActions
};
