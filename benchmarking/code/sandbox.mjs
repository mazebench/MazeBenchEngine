import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { safeDirectory, safeReadFile, writeWorkspaceScript } from "../v1/safe-files.mjs";
import { workspaceInventory } from "../v1/python-sandbox.mjs";

const execute = promisify(execFile);
export const DEFAULT_IMAGE = "mazebench-code:v1";
export const LIMITS = Object.freeze({ timeout_seconds: 60, output_bytes: 256_000, source_bytes: 256_000,
  memory_bytes: 1073741824, cpus: 2, pids: 64, file_bytes: 33554432 });
const environment = () => ({ HOME: os.homedir(), PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", LANG: "C" });
const active = new Set();

async function docker(config, args, options = {}) {
  return execute(config.executable, ["--host", config.host, ...args], {
    env: environment(), timeout: 20_000, maxBuffer: 1024 * 1024, ...options
  });
}
export function normalizeCodePath(value) {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9_.\/-]+$/.test(value) ||
      value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..") ||
      value === ".commands" || value.startsWith(".commands/")) throw new Error("File paths must be relative files inside /workspace (outside .commands).");
  return value;
}
export function validateCodeInput(input) {
  if (!input || Array.isArray(input) || typeof input !== "object" ||
      Object.keys(input).some(key => !["command", "files", "timeout_seconds"].includes(key))) throw new Error("Invalid code_exec arguments.");
  if (typeof input.command !== "string" || !input.command.trim()) throw new Error("command must be a nonempty shell program.");
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > 50) throw new Error("files must contain at most 50 source files.");
  const seen = new Set();
  let size = Buffer.byteLength(input.command);
  for (const file of files) {
    if (!file || Object.keys(file).some(key => !["path", "content"].includes(key)) || typeof file.content !== "string") throw new Error("Each source file needs path and content.");
    normalizeCodePath(file.path);
    if (seen.has(file.path)) throw new Error("Duplicate source file path.");
    seen.add(file.path); size += Buffer.byteLength(file.content);
  }
  if (size > LIMITS.source_bytes) throw new Error("Code exceeds the 256 KB source limit.");
  const timeout = input.timeout_seconds ?? 10;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > LIMITS.timeout_seconds) throw new Error("timeout_seconds must be between 1 and 60.");
  return { command: input.command, files, timeout_seconds: timeout };
}
export async function inspectCodeSandbox({ image = process.env.MAZEBENCH_CODE_IMAGE || DEFAULT_IMAGE } = {}) {
  try {
    const { stdout: found } = await execute("/usr/bin/which", ["docker"], { env: environment(), timeout: 5000 });
    const executable = realpathSync(found.trim());
    const { stdout: endpoint } = await execute(executable, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { env: environment(), timeout: 5000 });
    const host = endpoint.trim();
    if (!host.startsWith("unix:///")) throw new Error("Any-language runs require a local Docker Unix socket.");
    const config = { executable, host };
    const { stdout: version } = await docker(config, ["version", "--format", "{{.Server.Version}}"]);
    const { stdout } = await docker(config, ["image", "inspect", image]);
    const [info] = JSON.parse(stdout);
    if (!/^sha256:[a-f0-9]{64}$/.test(info?.Id) || info.Os !== "linux" || Object.keys(info.Config?.Volumes || {}).length) throw new Error("Expected a local Linux toolchain image without automatic volumes.");
    return { available: true, ...config, image: info.Id, image_name: image, docker_version: version.trim(), architecture: info.Architecture, limits: LIMITS };
  } catch (error) {
    return { available: false, error: `Any-language sandbox unavailable. Start Docker and run npm run setup:code-sandbox. ${String(error.message).split("\n")[0]}` };
  }
}
export function containerArguments({ workspace, name, image, script, timeout = 60, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000 }) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("An immutable toolchain image ID is required.");
  if (workspace.includes(",") || workspace.includes("\n")) throw new Error("Unsupported workspace path.");
  return ["create", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true", "--pids-limit", String(LIMITS.pids),
    "--memory", String(LIMITS.memory_bytes), "--memory-swap", String(LIMITS.memory_bytes), "--cpus", String(LIMITS.cpus),
    "--ulimit", `fsize=${LIMITS.file_bytes}:${LIMITS.file_bytes}`, "--ulimit", "nofile=256:256", "--init",
    "--user", `${uid}:${gid}`, "--workdir", "/workspace", "--hostname", "mazebench-code", "--no-healthcheck",
    "--mount", `type=bind,source=${workspace},target=/workspace`, "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=67108864,mode=1777",
    "--entrypoint", "/usr/bin/env", image, "-i", "HOME=/workspace", "TMPDIR=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8",
    "GOCACHE=/workspace/.cache/go", "GOMAXPROCS=2", "CARGO_HOME=/workspace/.cache/cargo",
    // The in-container deadline remains effective if the trusted MCP dies.
    "/usr/bin/timeout", "--signal=KILL", "--kill-after=1s", `${timeout}s`, "/bin/sh", `/workspace/${script}`];
}
async function removeContainer(config, name) {
  if (!/^mazebench-code-[a-f0-9-]{36}$/.test(name)) throw new Error("Invalid recorded sandbox container.");
  try { await docker(config, ["rm", "--force", name]); }
  catch {
    // A failed removal is safe only if the daemon confirms it no longer exists.
    const { stdout } = await docker(config, ["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]);
    if (stdout.trim()) throw new Error("Cannot stop the code container; refusing another execution.");
  }
}
export async function runSandboxedCode(input, { runDirectory, sandbox }) {
  input = validateCodeInput(input);
  if (!sandbox?.available || !sandbox.host?.startsWith("unix:///")) throw new Error("The code sandbox is not configured.");
  const directory = realpathSync(runDirectory);
  if (active.has(directory)) throw new Error("Another code execution is still running.");
  active.add(directory);
  let state, name, created = false;
  try {
    const workspace = safeDirectory(directory, "workspace", { create: true });
    state = safeDirectory(directory, "sandbox-state", { create: true });
    const marker = path.join(state, "code-container.json");
    if (existsSync(marker)) {
      await removeContainer(sandbox, JSON.parse(safeReadFile(state, "code-container.json")).name);
      rmSync(marker);
    }
    for (const file of input.files) writeWorkspaceScript(workspace, file.path, file.content);
    const script = `.commands/${randomUUID()}.sh`;
    writeWorkspaceScript(workspace, script, input.command);
    name = `mazebench-code-${randomUUID()}`;
    // Record before create, so an interrupted supervisor can clean up on resume.
    writeFileSync(marker, JSON.stringify({ name }), { mode: 0o600, flag: "wx" });
    created = true;
    await docker(sandbox, containerArguments({ workspace, name, image: sandbox.image, script, timeout: input.timeout_seconds }));
    const started = performance.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(sandbox.executable, ["--host", sandbox.host, "start", "--attach", name], { env: environment(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), bytes = 0, truncated = false, timedOut = false, cleanup;
      const stop = () => { cleanup ||= removeContainer(sandbox, name).finally(() => child.kill("SIGKILL")); cleanup.catch(() => {}); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeout_seconds * 1000);
      for (const [stream, key] of [[child.stdout, "out"], [child.stderr, "err"]]) stream.on("data", chunk => {
        const retained = chunk.subarray(0, Math.max(0, LIMITS.output_bytes - bytes));
        bytes += chunk.length;
        if (key === "out") stdout = Buffer.concat([stdout, retained]); else stderr = Buffer.concat([stderr, retained]);
        if (bytes > LIMITS.output_bytes) { truncated = true; stop(); }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", async code => {
        clearTimeout(timer);
        try { if (cleanup) await cleanup; resolve({ exit_code: code, stdout: stdout.toString(), stderr: stderr.toString(),
          timed_out: timedOut || code === 124 || code === 137, output_truncated: truncated, wall_time_ms: performance.now() - started, cpu_time_ms: null, script_path: script }); }
        catch (error) { reject(error); }
      });
    });
    // Removing the container also kills detached/grandchild processes.
    await removeContainer(sandbox, name); created = false; rmSync(marker);
    return { ...result, workspace_files: workspaceInventory(workspace) };
  } finally {
    try { if (created) { await removeContainer(sandbox, name); rmSync(path.join(state, "code-container.json"), { force: true }); } }
    finally { active.delete(directory); }
  }
}
export async function preflightCodeSandbox(options) {
  const result = await runSandboxedCode({ command: `set -eu
python3 - <<'PY'
import os, pathlib, socket, subprocess, json, shutil
assert os.getuid() != 0
assert all(shutil.which(tool) for tool in ['python3','node','gcc','g++','rustc','cargo','go','java','javac','ruby','perl','lua','make'])
assert not pathlib.Path('/var/run/docker.sock').exists()
assert len(pathlib.Path('/proc/net/route').read_text().splitlines()) == 1
try: socket.create_connection(('192.0.2.1', 9), timeout=.2); raise AssertionError('network available')
except OSError as e: assert e.errno in (1, 13, 101, 113)
assert not pathlib.Path(${JSON.stringify(options.runDirectory)}).exists()
try: pathlib.Path('/etc/mazebench-write-test').write_text('bad'); raise AssertionError('root writable')
except PermissionError: pass
except OSError as e: assert e.errno == 30
p = pathlib.Path('.code-preflight'); p.write_text('ok'); assert p.read_text() == 'ok'; p.unlink()
assert subprocess.check_output(['node', '-e', 'console.log(7)']).strip() == b'7'
status = pathlib.Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in status
assert 'CapEff:\\t0000000000000000' in status
print('MAZEBENCH_CODE_PREFLIGHT_OK')
PY
`, timeout_seconds: 15 }, options);
  if (result.exit_code !== 0 || !result.stdout.includes("MAZEBENCH_CODE_PREFLIGHT_OK")) throw new Error(`Any-language isolation preflight failed: ${result.stderr}`);
  return { verified: true, backend: "docker", image: options.sandbox.image, limits: LIMITS, verified_at: new Date().toISOString() };
}
