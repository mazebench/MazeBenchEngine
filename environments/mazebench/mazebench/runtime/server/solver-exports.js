const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOLUTION_PATH_PATTERN = /^[UDLR]*$/;
const SOLUTION_PATH_MAX_LENGTH = 10000;
const SOLUTION_PLAY_DATA_MAX_BYTES = 4 * 1024 * 1024;
const SOLUTION_EXPORT_FORMATS = new Set(["gif", "mp4"]);
const SOLUTION_EXPORT_JOB_RETENTION_MS = 15 * 60 * 1000;
const SOLUTION_EXPORT_ERROR_MAX_BYTES = 64 * 1024;
const SOLUTION_EXPORT_TIMEOUT_MS = 12 * 60 * 1000;

function normalizeSolutionExportRequest(payload, requestedFormat) {
  const format = String(requestedFormat || "mp4").trim().toLowerCase();
  if (!SOLUTION_EXPORT_FORMATS.has(format)) {
    throw new Error("Solution export format must be mp4 or gif.");
  }

  const solutionPath = String(payload?.path ?? "").trim().toUpperCase();
  if (
    solutionPath.length > SOLUTION_PATH_MAX_LENGTH ||
    !SOLUTION_PATH_PATTERN.test(solutionPath)
  ) {
    throw new Error("Solution path must contain only U, D, L, and R moves.");
  }

  const playData = payload?.playData;
  if (!playData || typeof playData !== "object" || Array.isArray(playData)) {
    throw new Error("Solution export needs a play-mode room snapshot.");
  }

  const width = Number(playData.width);
  const height = Number(playData.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 256 ||
    height > 256 ||
    !Array.isArray(playData.terrain) ||
    !Array.isArray(playData.actors)
  ) {
    throw new Error("Solution export room snapshot is invalid.");
  }

  const serializedPlayData = JSON.stringify(playData);
  if (Buffer.byteLength(serializedPlayData, "utf8") > SOLUTION_PLAY_DATA_MAX_BYTES) {
    throw new Error("Solution export room snapshot is too large.");
  }

  return {
    format,
    path: solutionPath,
    playData: JSON.parse(serializedPlayData)
  };
}

function safeExportNamePart(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function solutionExportFileName(gameId, levelId, format) {
  return [
    safeExportNamePart(gameId, "maze"),
    safeExportNamePart(levelId, "level"),
    "solution"
  ].join("-") + `.${format}`;
}

function createSolverExportService({ env = process.env, rootDir }) {
  const exportScript = path.join(rootDir, "scripts", "maze-export-solution.js");
  const jobs = new Map();

  function cleanupJob(job) {
    if (!job || job.cleaned) return;
    job.cleaned = true;
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    jobs.delete(job.id);
    fs.rmSync(job.outputDir, { force: true, recursive: true });
  }

  function scheduleCleanup(job) {
    if (job.cleanupTimer) clearTimeout(job.cleanupTimer);
    job.cleanupTimer = setTimeout(
      () => cleanupJob(job),
      SOLUTION_EXPORT_JOB_RETENTION_MS
    );
    job.cleanupTimer.unref?.();
  }

  function readJobProgress(job) {
    if (job.status === "ready") {
      return { phase: "done", percent: 100 };
    }
    if (job.status === "failed") {
      return {
        error: job.error,
        phase: "failed",
        percent: Math.min(99, job.highestPercent || 0)
      };
    }

    let progress = { phase: "starting", percent: 0 };
    try {
      progress = JSON.parse(fs.readFileSync(job.progressPath, "utf8"));
    } catch (_error) {
      /* The renderer creates the progress file after its first setup checks. */
    }

    let phase = String(progress.phase || "starting");
    let percent = Number(progress.percent);
    percent = Number.isFinite(percent) ? Math.max(0, Math.min(99, percent)) : 0;

    // renderReplayVideo reaches 100 before maze-export-solution performs its
    // final rename or GIF conversion. Keep the UI truthful until the child
    // actually exits with a complete artifact.
    if (phase === "done") {
      phase = job.format === "gif" ? "encoding GIF" : "finishing MP4";
      percent = job.format === "gif" ? 96 : 99;
    }

    job.highestPercent = Math.max(job.highestPercent || 0, percent);
    return {
      ...progress,
      phase,
      percent: job.highestPercent
    };
  }

  function summarizeJob(job) {
    return {
      error: job.status === "failed" ? job.error : undefined,
      format: job.format,
      id: job.id,
      progress: readJobProgress(job),
      status: job.status
    };
  }

  function jobFor({ gameId, jobId, levelId }) {
    const job = jobs.get(String(jobId || ""));
    if (!job || job.gameId !== gameId || job.levelId !== levelId) return null;
    return job;
  }

  function start({ format, gameId, levelId, payload }) {
    const request = normalizeSolutionExportRequest(payload, format);
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-solver-export-"));
    const inputPath = path.join(outputDir, "solution.json");
    const fileName = solutionExportFileName(gameId, levelId, request.format);
    const filePath = path.join(outputDir, fileName);
    const job = {
      child: null,
      cleaned: false,
      cleanupTimer: null,
      error: "",
      fileName,
      filePath,
      format: request.format,
      gameId,
      highestPercent: 0,
      id: crypto.randomUUID(),
      levelId,
      outputDir,
      progressPath: path.join(outputDir, "replay-progress.json"),
      settled: false,
      status: "rendering",
      stderr: "",
      timeoutTimer: null
    };

    fs.writeFileSync(
      inputPath,
      `${JSON.stringify({
        gameId,
        levelId,
        path: request.path,
        playData: request.playData
      })}\n`,
      "utf8"
    );

    jobs.set(job.id, job);
    const child = spawn(
      process.execPath,
      [exportScript, inputPath, outputDir, request.format, fileName],
      {
        cwd: rootDir,
        env,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    job.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      job.stderr = `${job.stderr}${chunk}`.slice(-SOLUTION_EXPORT_ERROR_MAX_BYTES);
    });

    const finish = (code, spawnError = null) => {
      if (job.settled) return;
      job.settled = true;
      if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
      job.child = null;
      const rendered =
        !spawnError &&
        code === 0 &&
        fs.existsSync(filePath) &&
        fs.statSync(filePath).size > 0;

      if (rendered) {
        job.status = "ready";
      } else {
        const detail =
          job.stderr.trim() ||
          spawnError?.message ||
          (code === 0
            ? "Solution renderer did not create a downloadable file."
            : `Solution renderer exited with status ${code ?? "unknown"}.`);
        job.error = `Could not render the solution ${request.format.toUpperCase()}: ${detail}`;
        job.status = "failed";
      }
      scheduleCleanup(job);
    };

    child.once("error", (error) => finish(null, error));
    child.once("exit", (code) => finish(code));
    job.timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null, new Error("Solution renderer timed out."));
    }, SOLUTION_EXPORT_TIMEOUT_MS);
    job.timeoutTimer.unref?.();
    return summarizeJob(job);
  }

  function status(identity) {
    const job = jobFor(identity);
    return job ? summarizeJob(job) : null;
  }

  function artifact(identity) {
    const job = jobFor(identity);
    if (!job || job.status !== "ready") return null;
    return {
      cleanup: () => cleanupJob(job),
      contentType: job.format === "gif" ? "image/gif" : "video/mp4",
      fileName: job.fileName,
      filePath: job.filePath,
      format: job.format
    };
  }

  function cancel(identity) {
    const job = jobFor(identity);
    if (!job) return false;
    if (job.child && job.status === "rendering") {
      job.settled = true;
      job.child.kill("SIGTERM");
    }
    cleanupJob(job);
    return true;
  }

  return { artifact, cancel, start, status };
}

module.exports = {
  createSolverExportService,
  normalizeSolutionExportRequest,
  solutionExportFileName
};
