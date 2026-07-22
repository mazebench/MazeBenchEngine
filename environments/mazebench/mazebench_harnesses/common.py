from __future__ import annotations

import json


CLI_SOURCE = r'''#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MCP_URL = __MAZEBENCH_MCP_URL__;
let sessionId = "";

function parseEventStream(text) {
  const payloads = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (!payloads.length) return null;
  return JSON.parse(payloads[payloads.length - 1]);
}

async function rpc(method, params, id = 1) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const text = await response.text();
  sessionId = response.headers.get("mcp-session-id") || sessionId;
  if (!response.ok) throw new Error(`MazeBench gateway returned HTTP ${response.status}: ${text}`);
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? parseEventStream(text)
    : JSON.parse(text || "null");
  if (!payload) throw new Error("MazeBench gateway returned an empty response");
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
  return payload.result;
}

async function notify(method, params) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params })
  });
  if (!response.ok) throw new Error(`MazeBench gateway returned HTTP ${response.status}`);
}

function toolValue(result) {
  if (result?.structuredContent && Object.keys(result.structuredContent).length) {
    return result.structuredContent;
  }
  const text = (result?.content || []).find((part) => part?.type === "text")?.text;
  if (!text) return result;
  try { return JSON.parse(text); } catch { return text; }
}

function observationRecords(value) {
  if (value?.observation?.observation_mode === "json") {
    return [{ observation: value.observation, revision: Number(value.actions_used) || 0 }];
  }
  if (value?.final_observation?.observation_mode !== "json") return [];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const records = (value.intermediate_observations || []).map((entry) => {
    const step = steps.find((candidate) => Number(candidate.index) === Number(entry.index));
    return {
      observation: entry.observation,
      revision: Number(step?.action_count_after) || Number(entry.index) || 0
    };
  });
  records.push({
    observation: value.final_observation,
    revision: Number(steps.at(-1)?.action_count_after) || Number(value.actions_used) || 0
  });
  return records;
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function syncObservationWorkspace(value) {
  const records = observationRecords(value);
  if (!records.length) return;
  const directory = path.resolve(process.cwd(), "observations");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const record of records) {
    const snapshot = { ...record.observation, observation_revision: record.revision };
    writeJson(path.join(directory, `${String(record.revision).padStart(6, "0")}.json`), snapshot);
    fs.appendFileSync(path.join(directory, "history.jsonl"), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    writeJson(path.join(directory, "current.json"), snapshot);
  }
}

function routeArguments(args) {
  const routeFile = String(args[0] || "").trim();
  if (!routeFile) throw new Error("action-sequence requires a route JSON file");
  const parsed = JSON.parse(fs.readFileSync(routeFile, "utf8"));
  const actions = Array.isArray(parsed) ? parsed : parsed?.actions;
  if (!Array.isArray(actions) || !actions.length) {
    throw new Error("route JSON must contain a non-empty actions array");
  }
  actions.forEach((action, index) => {
    if (typeof action !== "string" || !action.trim()) {
      throw new Error(`route actions[${index}] must be a non-empty string`);
    }
  });
  const plannedRevision = Array.isArray(parsed) ? null : parsed?.observation_revision;
  if (plannedRevision !== undefined && plannedRevision !== null) {
    let current;
    try {
      current = JSON.parse(fs.readFileSync(path.join("observations", "current.json"), "utf8"));
    } catch (_error) {
      throw new Error("cannot validate route revision before a JSON observation has been saved");
    }
    if (Number(plannedRevision) !== Number(current.observation_revision)) {
      throw new Error(
        `route is stale: planned from revision ${plannedRevision}, current revision is ${current.observation_revision}`
      );
    }
  }
  return {
    actions: actions.map((action) => action.trim()),
    include_intermediate_observations: args.includes("--all-frames")
  };
}

async function main() {
  const command = String(process.argv[2] || "").toLowerCase();
  if (!["start", "observe", "action", "action-sequence"].includes(command)) {
    throw new Error("Usage: mazebench-game <start|observe|action|action-sequence> [action words|route.json [--all-frames]]");
  }
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mazebench-game", version: "1" }
  }, 1);
  await notify("notifications/initialized", {});
  const args = command === "action"
    ? { action: process.argv.slice(3).join(" ").trim() }
    : command === "action-sequence"
      ? routeArguments(process.argv.slice(3))
      : {};
  if (command === "action" && !args.action) throw new Error("action words are required");
  const toolName = command === "action-sequence" ? "action_sequence" : command;
  const result = toolValue(await rpc("tools/call", { name: toolName, arguments: args }, 2));
  syncObservationWorkspace(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
'''


def cli_source(mcp_url: str) -> bytes:
    return CLI_SOURCE.replace(
        "__MAZEBENCH_MCP_URL__", json.dumps(str(mcp_url))
    ).encode()


def cli_instructions(path: str) -> str:
    return f"""

MazeBench is external to this sandbox. Do not search the filesystem for the game,
level, checkpoint, score, or source code. The only permitted game interface is:

```bash
node {path} start
node {path} observe
node {path} action up
node {path} action down
node {path} action left
node {path} action right
node {path} action rotate camera left
node {path} action undo
node {path} action reset
node {path} action-sequence route.json
node {path} action-sequence route.json --all-frames
```

Run `start` exactly once. When the task prompt mentions `game_start`, `game_observe`,
`game_action`, or `game_action_sequence`, use the corresponding CLI command above.
In JSON mode, every delivered sanitized observation is automatically saved to
`observations/current.json`, with append-only copies in `observations/history.jsonl`.
Programs should read that file directly rather than copying tool output. A saved solver can
write `route.json` as either an action array or
`{{"observation_revision": observation["observation_revision"], "actions": [...]}}`, then
submit the full route with `action-sequence`; there is no route-length cap. Add
`--all-frames` to receive and save every intermediate JSON observation. Without it, the
result and workspace contain only the final observation. Treat every returned observation
as authoritative.
""".strip()
