#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { CAPABILITY_POLICY_NAME, verifyRunIntegrity, verifyCheckpoint, assertRunConfiguration } from "../v1/integrity.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";

import {
  expandBenchmarkSequence
} from "../v1/runtime.mjs";
import { VisionRuntime as BenchmarkGameRuntime } from "./runtime.mjs";
import { verifyVisionIntegrity } from "./policy.mjs";
import { VisionRenderer } from "./renderer.mjs";
import {
  normalizePythonScriptPath,
  runSandboxedPython,
  workspaceInventory
} from "../v1/python-sandbox.mjs";

const projectRoot = path.resolve(process.env.MAZEBENCH_PROJECT_ROOT || path.join(import.meta.dirname, "..", ".."));
const runDirectory = path.resolve(process.env.MAZEBENCH_RUN_DIRECTORY || "");
const toolsEnabled = process.env.MAZEBENCH_PYTHON_ENABLED === "1";
const capabilityPolicy = process.env.MAZEBENCH_CAPABILITY_POLICY;
const maximumSequenceLength = 1_000;

if (!process.env.MAZEBENCH_RUN_DIRECTORY) {
  process.stderr.write("MAZEBENCH_RUN_DIRECTORY is required.\n");
  process.exit(1);
}
if (capabilityPolicy !== CAPABILITY_POLICY_NAME) {
  process.stderr.write("MazeBench MCP refused to start without the Python-only capability policy.\n");
  process.exit(1);
}

const metadata = JSON.parse(safeReadFile(runDirectory, "run.json"));
const manifest = await verifyVisionIntegrity(projectRoot, runDirectory, metadata);
assertRunConfiguration(metadata, manifest);
if (toolsEnabled !== manifest.configuration.tools_enabled) throw new Error("MCP tool condition differs from the frozen run configuration.");
verifyCheckpoint(runDirectory);
const runtime = await BenchmarkGameRuntime.open(projectRoot, runDirectory);
const activityFile = path.join(runDirectory, "tool-activity.jsonl");
const renderer = new VisionRenderer(projectRoot);
const workspace = path.join(runDirectory, "workspace");
const stateDirectory = path.join(runDirectory, "sandbox-state");

const tools = [
  {
    name: "maze_observe",
    description: "See a PNG image of the current room and brief game status, or inspect one path from your image records index. Historical move indexes list image frames of the actual animation. No ASCII board, raw object data, hidden rooms, or arbitrary files are available. Reads cost no actions. Call this tool directly.",
    inputSchema: {
      type: "object",
      properties: {
        record: {
          type: "string",
          description: "Optional relative path copied exactly from the records index or a move animation index."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "maze_action",
    description: "Direct-only tool. Apply exactly one accepted MazeBench action. Valid actions are up, down, left, right, undo, reset, camera up/down/left/right, or room HxI to start a previously visited room at its authored player start with a fresh board (also works for the current room). Every accepted action counts toward the run limit, including blocked movement and camera actions. Never call or orchestrate it from a code executor.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", minLength: 1, maxLength: 128 }
      },
      required: ["action"],
      additionalProperties: false
    }
  },
  {
    name: "maze_sequence",
    description: "Direct-only tool. Apply one model-chosen ordered sequence of MazeBench actions. Supply a compact UDRL string or an actions array. Each accepted step is independently validated, recorded, and counted. Execution stops on death, victory, or the action limit. Never call or orchestrate it from a code executor.",
    inputSchema: {
      type: "object",
      properties: {
        sequence: {
          type: "string",
          minLength: 1,
          description: "Compact movement sequence such as UURDDL."
        },
        actions: {
          type: "array",
          minItems: 1,
          maxItems: maximumSequenceLength,
          items: { type: "string", minLength: 1, maxLength: 128 }
        }
      },
      oneOf: [{ required: ["sequence"] }, { required: ["actions"] }],
      additionalProperties: false
    }
  },
  ...(toolsEnabled ? [{
    name: "python_exec",
    description: "Direct-only tool and the only available code executor. Save the supplied program as a relative .py file, then execute that saved file in this run's persistent isolated /workspace. Python can read and write only /workspace; it cannot read MazeBench records, benchmark results, repositories, host files, credentials, or prior runs, cannot access the network, and cannot launch subprocesses.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", minLength: 1, maxLength: 256_000 },
        script_path: { type: "string", minLength: 1, maxLength: 240 },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 60, default: 10 }
      },
      required: ["code", "script_path"],
      additionalProperties: false
    }
  }] : [])
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function success(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function safeError(error) {
  return String(error?.message || error || "Benchmark tool failed.")
    .split(/\r?\n/, 1)[0]
    .replaceAll(projectRoot, "[benchmark runtime]")
    .replaceAll(runDirectory, "[run]");
}

async function toolResult(value, isError = false) {
  const record = value.image_record || value.observation?.image_record || value.final_observation?.image_record;
  const content = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  if (record && !isError) {
    const { frame } = await runtime.readRecord(record);
    const png = await renderer.render(frame);
    content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  }
  return {
    content,
    // Codex prefers structuredContent over content when both are supplied.
    // Image observations must keep their text and PNG in the same content list.
    ...(record && !isError ? {} : { structuredContent: value }),
    isError
  };
}

function appendActivity(entry) {
  appendFileSync(activityFile, `${JSON.stringify(entry)}\n`, "utf8");
}

function validateArguments(name, input) {
  const keys = Object.keys(input || {});
  const allowed = {
    maze_observe: ["record"],
    maze_action: ["action"],
    maze_sequence: ["sequence", "actions"],
    python_exec: ["code", "script_path", "timeout_seconds"]
  }[name] || [];
  const unexpected = keys.find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unsupported argument "${unexpected}" for ${name}.`);
}

async function callTool(name, input = {}) {
  try {
    await verifyRunIntegrity(projectRoot, runDirectory, metadata.integrity);
    verifyCheckpoint(runDirectory);
  } catch (error) {
    writeFileSync(path.join(runDirectory, "integrity-violation.json"), JSON.stringify({ error: safeError(error) }), { mode: 0o600 });
    throw error;
  }
  validateArguments(name, input);
  if (name === "maze_observe") {
    if (input.record === undefined || String(input.record).trim() === "") {
      return runtime.renderObservation();
    }
    const value = await runtime.readRecord(input.record);
    return {
      observation_revision: runtime.internal.actionCount,
      read_only: true,
      ...(value.frame ? { record: value.record, image_record: value.record } : value),
      records: runtime.recordIndex()
    };
  }
  if (name === "maze_action") {
    if (typeof input.action !== "string" || !input.action.trim() || input.action.length > 128) {
      throw new Error("action must contain between 1 and 128 characters.");
    }
    return runtime.apply(input.action);
  }
  if (name === "maze_sequence") {
    const hasSequence = typeof input.sequence === "string" && input.sequence.trim() !== "";
    const hasActions = Array.isArray(input.actions);
    if (hasSequence === hasActions) throw new Error("Supply exactly one of sequence or actions.");
    const actions = expandBenchmarkSequence(hasActions ? input.actions : input.sequence);
    if (actions.length < 1 || actions.length > maximumSequenceLength) {
      throw new Error(`A sequence must contain between 1 and ${maximumSequenceLength} actions.`);
    }
    return runtime.applySequence(actions);
  }
  if (name === "python_exec" && toolsEnabled) {
    const scriptPath = normalizePythonScriptPath(input.script_path);
    const timeoutSeconds = input.timeout_seconds === undefined ? 10 : Number(input.timeout_seconds);
    return {
      ...runSandboxedPython(input.code, {
        workspace,
        stateDirectory,
        projectRoot,
        runDirectory,
        scriptPath,
        timeoutSeconds
      }),
      workspace_files: workspaceInventory(workspace)
    };
  }
  throw new Error(`Unknown tool "${name}".`);
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0") return;
  if (["notifications/initialized", "notifications/cancelled"].includes(request.method)) return;
  if (request.method === "initialize") {
    success(request.id, {
      protocolVersion: request.params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "mazebench-benchmark", version: "1.0.0" }
    });
    return;
  }
  if (request.method === "ping") {
    success(request.id, {});
    return;
  }
  // Codex advertises generic resource helpers whenever any MCP is configured.
  // This server publishes no resources/templates and never resolves file URIs.
  if (request.method === "resources/list") { success(request.id, { resources: [] }); return; }
  if (request.method === "resources/templates/list") { success(request.id, { resourceTemplates: [] }); return; }
  if (request.method === "resources/read") {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "This server exposes no resources. Use maze_observe for allowlisted records." } });
    return;
  }
  if (request.method === "tools/list") {
    success(request.id, { tools: metadata.provider === "claude-code" ? tools.map(tool => { const copy = structuredClone(tool); delete copy.inputSchema.oneOf; return copy; }) : tools });
    return;
  }
  if (request.method === "tools/call") {
    const name = String(request.params?.name || "");
    const input = request.params?.arguments || {};
    const activity = {
      id: randomUUID(),
      at: new Date().toISOString(),
      tool: name,
      status: "running",
      action_count_before: runtime.internal.actionCount,
      ...(name === "maze_action" ? { action: String(input.action || "") } : {}),
      ...(name === "maze_sequence" ? { sequence: input.sequence, actions: input.actions } : {}),
      ...(name === "maze_observe" ? { record: String(input.record || "") } : {}),
      ...(name === "python_exec" ? {
        script_path: String(input.script_path || ""),
        code_sha256: createHash("sha256").update(String(input.code || "")).digest("hex")
      } : {})
    };
    appendActivity(activity);
    try {
      const value = await callTool(name, input);
      const result = await toolResult(value);
      appendActivity({
        ...activity,
        completed_at: new Date().toISOString(),
        status: "completed",
        action_count_after: runtime.internal.actionCount,
        ...(name === "python_exec" ? {
          result: {
            exit_code: value.exit_code,
            stdout: value.stdout,
            stderr: value.stderr,
            timed_out: value.timed_out
          },
          workspace_files: value.workspace_files
        } : {})
      });
      success(request.id, result);
    } catch (error) {
      const message = safeError(error);
      appendActivity({
        ...activity,
        completed_at: new Date().toISOString(),
        status: "failed",
        action_count_after: runtime.internal.actionCount,
        error: message
      });
      success(request.id, await toolResult({ error: message }, true));
    }
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found." } });
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();
lines.on("line", (line) => {
  const source = line.trim();
  if (!source) return;
  let request;
  try {
    request = JSON.parse(source);
  } catch {
    return;
  }
  // Process calls in arrival order. This prevents parallel tool requests from
  // racing the authoritative action counter or Python workspace.
  requestQueue = requestQueue.then(() => handle(request)).catch((error) => {
    if (request?.id !== undefined) {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: safeError(error) } });
    }
  });
});

lines.on("close", () => { void requestQueue.finally(() => renderer.close()); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void renderer.close().finally(() => process.exit()); });
