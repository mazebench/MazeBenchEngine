import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeDirectory, writeWorkspaceScript } from "./safe-files.mjs";

const MAX_CODE_BYTES = 256_000;
const MAX_OUTPUT_BYTES = 256_000;
const MAX_TIMEOUT_SECONDS = 60;
const PYTHON_BOOTSTRAP_PATH = path.join(import.meta.dirname, "python-bootstrap.py");


function resolvedExecutable(command, label) {
  const value = String(command || "").trim();
  if (!value) throw new Error(`${label} executable is required.`);
  if (value.includes(path.sep)) {
    const absolute = path.resolve(value);
    if (!existsSync(absolute)) throw new Error(`${label} executable does not exist.`);
    return absolute;
  }
  const probe = spawnSync("which", [value], { encoding: "utf8" });
  const found = String(probe.stdout || "").trim().split(/\r?\n/, 1)[0];
  if (probe.status !== 0 || !found) throw new Error(`${label} executable was not found on PATH.`);
  return path.resolve(found);
}

function findPython(requested = "") {
  for (const candidate of [requested, "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3", "python3"]) {
    if (!String(candidate || "").trim()) continue;
    try {
      return resolvedExecutable(candidate, "Python");
    } catch {
      // Try the next standalone interpreter.
    }
  }
  throw new Error("No standalone Python 3 interpreter is available.");
}

function canonical(candidate) {
  const absolute = path.resolve(String(candidate));
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(canonical(parent), path.basename(absolute));
  }
}

function bounded(value, maximum = Math.floor(MAX_OUTPUT_BYTES / 2)) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  if (bytes.length <= maximum) return { text: bytes.toString("utf8"), truncated: false };
  return { text: bytes.subarray(0, maximum).toString("utf8"), truncated: true };
}

function sandboxConfig(options = {}) {
  const projectRoot = canonical(options.projectRoot);
  const runDirectory = canonical(options.runDirectory);
  if (path.resolve(options.workspace) !== path.join(path.resolve(options.runDirectory), "workspace") ||
      path.resolve(options.stateDirectory) !== path.join(path.resolve(options.runDirectory), "sandbox-state")) {
    throw new Error("Python workspace and sandbox state must be separate run-scoped directories.");
  }
  const workspace = safeDirectory(runDirectory, "workspace", { create: true });
  const stateDirectory = safeDirectory(runDirectory, "sandbox-state", { create: true });
  safeDirectory(workspace, ".tmp", { create: true });
  const pythonBin = findPython(options.pythonBin);
  return { workspace, stateDirectory, projectRoot, runDirectory, pythonBin };
}

function sandboxCommand(options = {}) {
  const config = sandboxConfig(options);
  if (process.platform !== "darwin") throw new Error("Python isolation requires the verified macOS Seatbelt backend.");
  const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(options.timeoutSeconds) || 10));
  // The trusted bootstrap installs Seatbelt before reading the agent script.
  // Installing a second profile inside Codex's sandbox is denied by macOS.
  return {
    config,
    argv: ["-I", "-B", PYTHON_BOOTSTRAP_PATH, String(timeoutSeconds + 1), "1024", "32", options.scriptPath]
  };
}

export function normalizePythonScriptPath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || !normalized.endsWith(".py")) {
    throw new Error("script_path must be a relative .py file inside /workspace.");
  }
  if (!/^[A-Za-z0-9_./-]+$/.test(normalized)) {
    throw new Error("script_path contains unsupported characters.");
  }
  return normalized;
}

export function runSandboxedPython(code, options = {}) {
  const source = String(code || "");
  if (!source.trim()) throw new Error("Python code is required.");
  if (Buffer.byteLength(source, "utf8") > MAX_CODE_BYTES) {
    throw new Error(`Python code exceeds ${MAX_CODE_BYTES} bytes.`);
  }
  const scriptPath = normalizePythonScriptPath(options.scriptPath);
  const timeoutSeconds = Number(options.timeoutSeconds) || 10;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }
  const { config, argv } = sandboxCommand({ ...options, timeoutSeconds, scriptPath });
  writeWorkspaceScript(config.workspace, scriptPath, source);
  const started = process.hrtime.bigint();
  const result = spawnSync(config.pythonBin, argv, {
    cwd: config.workspace,
    env: {
      HOME: config.workspace,
      TMPDIR: path.join(config.workspace, ".tmp"),
      PATH: [...new Set([path.dirname(config.pythonBin), "/usr/bin", "/bin"])].join(path.delimiter),
      LANG: "C",
      LC_ALL: "C",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1"
    },
    encoding: "utf8",
    timeout: (timeoutSeconds + 5) * 1000,
    maxBuffer: MAX_OUTPUT_BYTES * 2,
    killSignal: "SIGKILL"
  });
  const stdout = bounded(result.stdout);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const stderr = bounded(result.stderr);
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    script_path: scriptPath,
    exit_code: Number.isInteger(result.status) ? result.status : null,
    stdout: stdout.text,
    stderr: stderr.text || (result.error && !timedOut ? String(result.error.message || result.error) : ""),
    cpu_time_ms: null, // never trust timing markers printed by agent code
    wall_time_ms: elapsedMs,
    timed_out: timedOut,
    output_truncated: stdout.truncated || stderr.truncated || result.error?.code === "ENOBUFS"
  };
}

export function preflightPythonSandbox(options = {}) {
  const config = sandboxConfig(options);
  const probeId = randomUUID();
  const scriptName = `.preflight-${probeId}.py`;
  const writeName = `.preflight-${probeId}.txt`;
  const privateCanary = path.join(config.runDirectory, `private-canary-${probeId}.txt`);
  const hostCanary = path.join(os.tmpdir(), `mazebench-host-canary-${process.pid}-${Date.now()}.txt`);
  const symlink = path.join(config.workspace, `.escape-${probeId}`);
  const token = `${process.pid}:${Date.now()}`;
  writeFileSync(privateCanary, token, { mode: 0o600 });
  writeFileSync(hostCanary, token, { mode: 0o600 });
  try {
    rmSync(symlink, { force: true });
    symlinkSync(privateCanary, symlink);
    const source = `
import json, socket, subprocess, __main__
from pathlib import Path
__main__._deny_escape.__code__ = (lambda event, args: None).__code__
r = {}
for name, target in [("private", Path(${JSON.stringify(privateCanary)})), ("host", Path(${JSON.stringify(hostCanary)})), ("symlink", Path(${JSON.stringify(symlink)}))]:
    try: target.read_text(); r[name] = False
    except PermissionError: r[name] = True
    except Exception: r[name] = False
try: socket.create_connection(("127.0.0.1", 9), timeout=.2); r["network"] = False
except PermissionError: r["network"] = True
except Exception: r["network"] = False
try: subprocess.run(["/bin/sh", "-c", "echo escaped"]); r["subprocess"] = False
except PermissionError: r["subprocess"] = True
except Exception: r["subprocess"] = False
p=Path(${JSON.stringify(writeName)}); p.write_text("ok"); r["write"] = p.read_text() == "ok"
print("MAZEBENCH_PREFLIGHT=" + json.dumps(r, sort_keys=True))
`;
    const result = runSandboxedPython(source, {
      ...options,
      workspace: config.workspace,
      stateDirectory: config.stateDirectory,
      projectRoot: config.projectRoot,
      runDirectory: config.runDirectory,
      scriptPath: scriptName,
      timeoutSeconds: 5
    });
    const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("MAZEBENCH_PREFLIGHT="));
    const checks = marker ? JSON.parse(marker.slice("MAZEBENCH_PREFLIGHT=".length)) : null;
    const verified = result.exit_code === 0 && checks &&
      checks.private && checks.host && checks.symlink && checks.network && checks.subprocess && checks.write;
    if (!verified) {
      throw new Error(`Python isolation preflight failed: ${JSON.stringify(checks)} ${result.stderr}`.trim());
    }
    return { verified: true, backend: "macos-seatbelt", audit_hook_bypass_tested: true, verified_at: new Date().toISOString(), checks };
  } finally {
    rmSync(symlink, { force: true });
    rmSync(path.join(config.workspace, writeName), { force: true });
    rmSync(path.join(config.workspace, scriptName), { force: true });
    rmSync(privateCanary, { force: true });
    rmSync(hostCanary, { force: true });
  }
}

export function workspaceInventory(workspace) {
  const root = safeDirectory(path.dirname(workspace), path.basename(workspace));
  const results = [];
  const walk = (directory, prefix = "") => {
    if (results.length >= 500 || prefix.split("/").length > 32) return;
    let names = [];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".tmp" || name.startsWith(".escape")) continue;
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      let details;
      try {
        details = lstatSync(absolute);
      } catch {
        continue;
      }
      if (!details || details.isSymbolicLink() || (details.isFile() && details.nlink !== 1)) continue;
      if (details.isDirectory()) walk(absolute, relative);
      else if (details.isFile()) results.push({ path: relative, bytes: details.size });
      if (results.length >= 500) return;
    }
  };
  walk(root);
  return results;
}
