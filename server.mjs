import { CurrentVersions } from "./benchmarking/current-version.mjs";
import { ensureServerHeap, startReaderService } from "./benchmarking/server-resources.mjs";
import { createCatalogServer } from "./benchmarking/catalog-server.mjs";
import { createLocalProjectHandler } from "./scripts/lib/local-project-http.mjs";
import { createCapabilityServer } from "./benchmarking/capability-server.mjs";
import { createVisionServer } from "./benchmarking/vision/server.mjs";
import { createProviderVisionServer } from "./benchmarking/vision-providers/server.mjs";
import { createRecoveryServer } from "./benchmarking/recovery-server.mjs";
import { createAutoResumeServer } from "./benchmarking/auto-resume-server.mjs";
import "./benchmarking/codex-releases.mjs";
import { createRuntimeReleaseServer } from "./benchmarking/runtime-release-server.mjs";
import { installClaudeOutputLimit } from "./benchmarking/claude-output-limit.mjs";
import { publishEditorRoom } from "./benchmarking/storage/live-world.mjs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { resumeExclusively } from "./benchmarking/storage/resume-lock.mjs";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor } from "./benchmarking/kimi/supervisor.mjs";
import { withRunnerLiveness } from "./benchmarking/server-lifecycle.mjs";
import { RunLibrary } from "./benchmarking/run-library.mjs";
import { RunDashboard } from "./benchmarking/run-dashboard.mjs";
import { ReportReader } from "./benchmarking/report-reader.mjs";
import { previewBenchmarkPrompt } from "./benchmarking/prompt-preview.mjs";
import { TokenTelemetry } from "./benchmarking/token-telemetry.mjs";
import { isTrustedLocalRequest } from "./benchmarking/v1/http-security.mjs";
import { decodeVoxelRoom, encodeVoxelRoom } from "./render/v1/voxel-world-v2.mjs";

await ensureServerHeap();
const root = path.dirname(fileURLToPath(import.meta.url));
const v1LevelRoot = path.join(root, "level-data", "v1", "main-world");
const v2LevelRoot = path.join(root, "level-data", "v2", "main-world");
const v1Manifest = JSON.parse(await readFile(path.join(v1LevelRoot, "world_map.json"), "utf8"));
const v2Manifest = JSON.parse(await readFile(path.join(v2LevelRoot, "world.json"), "utf8"));
const allowedV1Levels = new Set(Object.keys(v1Manifest.levels || {}));
const allowedV2Levels = new Set(Object.keys(v2Manifest.rooms || {}));
const host = process.env.MAZEBENCH_BENCHMARK_HOST || "127.0.0.1";
const port = Number(process.env.MAZEBENCH_BENCHMARK_PORT || 8080);
const benchmarkSupervisor = new (withRunnerLiveness(BenchmarkSupervisor))(root);
installClaudeOutputLimit(benchmarkSupervisor);
const runLibrary = new RunLibrary({ markInterrupted: true });
const runDashboard = new RunDashboard(runLibrary);
const reportReader = new ReportReader();
const tokenTelemetry = new TokenTelemetry();
const versions = new CurrentVersions(root);
const localProject = createLocalProjectHandler(path.join(root, "project-data"));

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"]
]);

function send(response, status, body, type = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

async function requestBody(request, maximumBytes = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error("Request payload is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateLevel(source) {
  const rows = source.split(/\r?\n/).filter((row) => row.length > 0);
  if (rows.length !== 16 || rows.some((row) => row.split(" ").length !== 16)) {
    throw new Error("Main-world levels must remain exactly 16 by 16 cells.");
  }
  return rows.join("\n") + (source.endsWith("\n") ? "\n" : "");
}

async function saveV1Level(request, response, fileName) {
  if (!allowedV1Levels.has(fileName)) {
    send(response, 404, JSON.stringify({ error: "Unknown main-world level." }), "application/json");
    return;
  }
  try {
    const source = validateLevel(await requestBody(request));
    await writeFile(path.join(v1LevelRoot, fileName), source, "utf8");
    send(response, 200, JSON.stringify({ ok: true, fileName }), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

let editorSaveQueue = Promise.resolve();
async function saveV2Level(request, response, fileName) {
  if (!allowedV2Levels.has(fileName)) {
    send(response, 404, JSON.stringify({ error: "Unknown v2 main-world level." }), "application/json");
    return;
  }
  try {
    const payload = JSON.parse(await requestBody(request));
    const room = decodeVoxelRoom(payload);
    if (room.width !== 16 || room.height !== 16) {
      throw new Error("Main-world v2 rooms must remain exactly 16 by 16 cells.");
    }
    const unknown = room.objects.find((object) =>
      !v2Manifest.blocks.some((block) => block.id === object.blockId));
    if (unknown) throw new Error(`Unknown v2 blockId: ${unknown.blockId}.`);
    const canonical = encodeVoxelRoom(room);
    const source = `${JSON.stringify(canonical)}\n`;
    const save = editorSaveQueue.catch(() => {}).then(async () => {
      const temp = path.join(v2LevelRoot, `.${fileName}-${randomUUID()}.tmp`);
      try { await writeFile(temp,source,{flag:'wx'}); await rename(temp,path.join(v2LevelRoot,fileName)); }
      finally { await rm(temp,{force:true}); }
      const published = await publishEditorRoom(root,[benchmarkSupervisor.recordsRoot,
        process.env.MAZEBENCH_VISION_RECORDS_ROOT || path.join(os.homedir(),'records','mazebench-vision')],fileName,source);
      try { versions.read(); } catch (error) { console.error(`Version registration: ${error.message}`); }
      return published;
    });
    editorSaveQueue = save;
    const updates = await save;
    send(response, 200, JSON.stringify({ok:true,fileName,objectCount:room.objects.length,run_updates:updates}), "application/json");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error.message }), "application/json");
  }
}

async function benchmarkApi(request, response, url) {
  try {
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/prompt") {
      sendJson(response, 200, await previewBenchmarkPrompt(root, Object.fromEntries(url.searchParams)));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/providers") {
      sendJson(response, 200, await benchmarkSupervisor.providers({ force: url.searchParams.get("force") === "1" }));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/status") {
      sendJson(response, 200, await benchmarkSupervisor.status({ force: url.searchParams.get("force") === "1" }));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/models") {
      sendJson(response, 200, await benchmarkSupervisor.models());
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/benchmark/v1/runs") {
      sendJson(response, 200, { runs: await (url.searchParams.get("view") === "library"
        ? runLibrary.list(benchmarkSupervisor) : benchmarkSupervisor.list()) });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/v1/runs") {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      if (payload.observation_mode === "vision") throw new Error("Vision runs must use the image runner. Reload the launcher; no run was launched.");
      sendJson(response, 202, await benchmarkSupervisor.launch(payload));
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/benchmark/v1/pairs") {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      if (payload.observation_mode === "vision") throw new Error("Vision runs must use the image runner. Reload the launcher; no run was launched.");
      sendJson(response, 202, await benchmarkSupervisor.launchPair(payload));
      return true;
    }
    const recordMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/record\/(.+)$/);
    if (request.method === "GET" && recordMatch) {
      const content = await benchmarkSupervisor.record(
        decodeURIComponent(recordMatch[1]),
        decodeURIComponent(recordMatch[2])
      );
      send(response, 200, content, "text/plain; charset=utf-8");
      return true;
    }
    const displayMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/display\/(\d+)$/);
    if (request.method === "GET" && displayMatch) {
      sendJson(response, 200, await runDashboard.frame(benchmarkSupervisor,
        decodeURIComponent(displayMatch[1]),
        displayMatch[2]
      ));
      return true;
    }
    const interviewsMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews$/);
    if (request.method === "GET" && interviewsMatch) {
      sendJson(response, 200, await benchmarkSupervisor.listInterviews(
        decodeURIComponent(interviewsMatch[1])
      ));
      return true;
    }
    if (request.method === "POST" && interviewsMatch) {
      sendJson(response, 201, await benchmarkSupervisor.createInterview(
        decodeURIComponent(interviewsMatch[1])
      ));
      return true;
    }
    const interviewChatMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)$/);
    if (request.method === "GET" && interviewChatMatch) {
      sendJson(response, 200, await benchmarkSupervisor.getInterviewChat(
        decodeURIComponent(interviewChatMatch[1]),
        decodeURIComponent(interviewChatMatch[2])
      ));
      return true;
    }
    const interviewMessageMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)\/messages$/);
    if (request.method === "POST" && interviewMessageMatch) {
      const payload = JSON.parse(await requestBody(request, 32 * 1024) || "{}");
      sendJson(response, 200, await benchmarkSupervisor.askInterview(
        decodeURIComponent(interviewMessageMatch[1]),
        decodeURIComponent(interviewMessageMatch[2]),
        payload.question
      ));
      return true;
    }
    const interviewEndMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/interviews\/([^/]+)\/end$/);
    if (request.method === "POST" && interviewEndMatch) {
      sendJson(response, 200, await benchmarkSupervisor.endInterview(
        decodeURIComponent(interviewEndMatch[1]),
        decodeURIComponent(interviewEndMatch[2])
      ));
      return true;
    }
    const runMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)$/);
    const tokensMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/tokens$/);
    const chartsMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/charts$/);
    if (request.method === "GET" && chartsMatch) {
      const id = decodeURIComponent(chartsMatch[1]);
      const directory = benchmarkSupervisor.runDirectory(id);
      sendJson(response, 200, await reportReader.read(directory, "charts", benchmarkSupervisor.active.has(id)));
      return true;
    }
    if (request.method === "GET" && tokensMatch) {
      const id = decodeURIComponent(tokensMatch[1]);
      sendJson(response, 200, await reportReader.read(benchmarkSupervisor.runDirectory(id), "tokens", benchmarkSupervisor.active.has(id)));
      return true;
    }
    if (request.method === "GET" && runMatch) {
      const id = decodeURIComponent(runMatch[1]);
      const view = url.searchParams.get("view");
      if (["overview", "analysis", "activity"].includes(view)) {
        sendJson(response, 200, view === "analysis"
          ? await reportReader.read(benchmarkSupervisor.runDirectory(id), "analysis", benchmarkSupervisor.active.has(id))
          : await runDashboard[view](benchmarkSupervisor, id));
        return true;
      }
      const run = await benchmarkSupervisor.get(id, {historyCursor:url.searchParams.get("history_cursor")});
      const telemetry = await tokenTelemetry.read(benchmarkSupervisor.runDirectory(id)).catch(() => null);
      if (telemetry?.totals) run.usage = telemetry.totals;
      sendJson(response, 200, run);
      return true;
    }
    if (request.method === "DELETE" && runMatch) {
      sendJson(response, 200, await benchmarkSupervisor.delete(decodeURIComponent(runMatch[1])));
      return true;
    }
    const stopMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/stop$/);
    if (request.method === "POST" && stopMatch) {
      sendJson(response, 200, await benchmarkSupervisor.stop(decodeURIComponent(stopMatch[1])));
      return true;
    }
    const pauseMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/pause$/);
    if (request.method === "POST" && pauseMatch) {
      sendJson(response, 200, await benchmarkSupervisor.pause(decodeURIComponent(pauseMatch[1])));
      return true;
    }
    const resumeMatch = url.pathname.match(/^\/api\/benchmark\/v1\/runs\/([^/]+)\/resume$/);
    if (request.method === "POST" && resumeMatch) {
      sendJson(response, 202, await resumeExclusively(benchmarkSupervisor,decodeURIComponent(resumeMatch[1])));
      return true;
    }
  } catch (error) {
    const message = String(error?.message || error || "Benchmark request failed.");
    const status = /not found/i.test(message) ? 404 : 400;
    sendJson(response, status, { error: message });
    return true;
  }
  return false;
}

async function serveStatic(request, response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    send(response, 400, "Bad path.");
    return;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) {
    send(response, 404, "Not found.");
    return;
  }
  let filePath = path.resolve(root, `.${decoded}`);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    send(response, 404, "Not found.");
    return;
  }
  try {
    const details = await stat(filePath);
    if (details.isDirectory()) filePath = path.join(filePath, "index.html");
    const fileDetails = await stat(filePath);
    if (!fileDetails.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(filePath)) || "application/octet-stream",
      "Content-Length": fileDetails.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  } catch {
    send(response, 404, "Not found.");
  }
}

const server = createServer(async (request, response) => {
  if (!isTrustedLocalRequest(request, port)) {
    sendJson(response, 403, { error: "Only same-origin localhost requests are accepted." });
    return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/api/versions/current") {
    try { sendJson(response, 200, versions.read()); } catch (error) { sendJson(response, 503, { error: error.message }); }
    return;
  }
  if (await localProject(request, response)) return;
  if (url.pathname.startsWith("/api/benchmark/v1/") &&
      await benchmarkApi(request, response, url)) return;
  const v1LevelMatch = url.pathname.match(/^\/api\/(?:v1\/)?levels\/([^/]+)$/);
  const v2LevelMatch = url.pathname.match(/^\/api\/v2\/levels\/([^/]+)$/);
  if (request.method === "PUT" && v2LevelMatch) {
    await saveV2Level(request, response, decodeURIComponent(v2LevelMatch[1]));
    return;
  }
  if (request.method === "PUT" && v1LevelMatch) {
    await saveV1Level(request, response, decodeURIComponent(v1LevelMatch[1]));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed.");
    return;
  }
  // The test lab's runtime stays canonical; don't copy its WASM or renderers.
  const labAsset = /^\/(?:physics\/|vendor\/|mazebench-runtime\/|utils\/|assets\/objects\/|search-worker\.js$)/.test(url.pathname);
  await serveStatic(request, response, labAsset ? `/apps/web/public${url.pathname}` : url.pathname);
});

server.on("close", () => versions.close());
server.listen(port, host, () => {
  versions.start();
  console.log(`MazeBenchBenchmarking running at http://localhost:${port}`);
});

// These ports serve APIs, not the app homepage. LocalhostRegistrar probes
// every listener owned by this process and must only select the main server.
function listenCompanion(companion, companionPort) {
  const handlers = companion.listeners("request");
  companion.removeAllListeners("request");
  companion.on("request", (request, response) => {
    if ((request.url || "/").split("?")[0] === "/") {
      response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Open MazeBench at http://localhost:" + port + "/");
      return;
    }
    for (const handle of handlers) handle.call(companion, request, response);
  });
  companion.listen(companionPort, "127.0.0.1");
}

// Start the image runner with the site, preserving a standalone owner that
// already has live vision runs. ASCII and image observations stay separate.
if (process.env.MAZEBENCH_DISABLE_VISION !== "1" && (Number(port) === 8080 || process.env.MAZEBENCH_VISION_PORT)) {
  const visionPort = Number(process.env.MAZEBENCH_VISION_PORT || 8082);
  const { server: visionServer } = createVisionServer(root, { port: visionPort, mainPort: Number(port) });
  visionServer.on("error", error => { if (error.code !== "EADDRINUSE") console.error("Vision server:", error.message); });
  listenCompanion(visionServer, visionPort);
  const playbackPort = Number(process.env.MAZEBENCH_PLAYBACK_PORT || 8085);
  void startReaderService(root, 'playback', playbackPort).catch(error => console.error('Run replay:', error.message));
  const reportPort = Number(process.env.MAZEBENCH_REPORT_PORT || 8091);
  void startReaderService(root, 'report', reportPort).catch(error => console.error('Run reports:', error.message));
  const providerVisionPort = Number(process.env.MAZEBENCH_PROVIDER_VISION_PORT || 8086);
  const { server: providerVisionServer } = createProviderVisionServer(root, { port: providerVisionPort, mainPort: Number(port), upstreamPort: Number(process.env.MAZEBENCH_CATALOG_PORT || 8084) });
  providerVisionServer.on("error", error => { if (error.code !== "EADDRINUSE") console.error("Subscription vision:", error.message); });
  listenCompanion(providerVisionServer, providerVisionPort);
  const recoveryPort = Number(process.env.MAZEBENCH_RECOVERY_PORT || 8087);
  const { server: recoveryServer } = createRecoveryServer(root, { port: recoveryPort, mainPort: Number(port), visionPort });
  recoveryServer.on("error", error => { if (error.code !== "EADDRINUSE") console.error("Vision recovery:", error.message); });
  listenCompanion(recoveryServer, recoveryPort);
}

// A previously started companion may own active Any-language runs. Never replace
// it merely because the static/main server restarted.
if (process.env.MAZEBENCH_DISABLE_CAPABILITIES !== "1" && (Number(port) === 8080 || process.env.MAZEBENCH_CAPABILITY_PORT)) {
  const capabilityPort = Number(process.env.MAZEBENCH_CAPABILITY_PORT || 8083);
  const { server: capabilityServer } = createCapabilityServer(root, { port: capabilityPort, mainPort: Number(port) });
  capabilityServer.on("error", error => {
    if (error.code !== "EADDRINUSE") console.error("Capability server:", error.message);
  });
  listenCompanion(capabilityServer, capabilityPort);
}

// Keep catalog upgrades independent of the processes owning existing runs.
if (process.env.MAZEBENCH_DISABLE_CAPABILITIES !== "1" && (Number(port) === 8080 || process.env.MAZEBENCH_CAPABILITY_PORT)) {
  const { server: catalogServer } = createCatalogServer(root, { port: Number(process.env.MAZEBENCH_CATALOG_PORT || 8084), mainPort: Number(port), upstreamPort: Number(process.env.MAZEBENCH_CAPABILITY_PORT || 8083) });
  catalogServer.on("error", error => { if (error.code !== "EADDRINUSE") console.error("Model catalog server:", error.message); });
  listenCompanion(catalogServer, Number(process.env.MAZEBENCH_CATALOG_PORT || 8084));
}

if (process.env.MAZEBENCH_DISABLE_CAPABILITIES !== "1" && Number(port) === 8080) {
  const releases = createRuntimeReleaseServer(root);
  releases.server.on('error', error => { if (error.code !== 'EADDRINUSE') console.error('Versioned benchmark runner:', error.message); });
  releases.ready.then(() => listenCompanion(releases.server, 8090));
  const autoResume = createAutoResumeServer();
  autoResume.server.on('error', error => { if (error.code !== 'EADDRINUSE') console.error('All-agent auto-resume:', error.message); });
  listenCompanion(autoResume.server, 8092);
}
