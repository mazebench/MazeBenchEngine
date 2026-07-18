from __future__ import annotations

import json


CLI_SOURCE = r'''#!/usr/bin/env node
"use strict";

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

async function main() {
  const command = String(process.argv[2] || "").toLowerCase();
  if (!["start", "observe", "action"].includes(command)) {
    throw new Error("Usage: mazebench-game <start|observe|action> [action words]");
  }
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mazebench-game", version: "1" }
  }, 1);
  await notify("notifications/initialized", {});
  const args = command === "action"
    ? { action: process.argv.slice(3).join(" ").trim() }
    : {};
  if (command === "action" && !args.action) throw new Error("action words are required");
  const result = await rpc("tools/call", { name: command, arguments: args }, 2);
  process.stdout.write(`${JSON.stringify(toolValue(result), null, 2)}\n`);
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
```

Run `start` exactly once, then one `action` command at a time. When the task prompt
mentions `game_start`, `game_observe`, or `game_action`, use the corresponding CLI
command above. Treat every returned observation as authoritative.
""".strip()
