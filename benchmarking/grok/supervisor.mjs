// Grok routing is layered outside the frozen v1/provider/world trees so the
// runtime inventories of existing Codex and Claude records remain unchanged.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor as WorldSupervisor } from "../slotski/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import {
  GROK_MODELS,
  GROK_POLICY,
  GROK_PROVIDER,
  digest,
  grokInstallationStatus,
  grokModelsPolicyDigest,
  grokRuntimeHashes,
  grokSettingsPolicyDigest,
  setGrokConfigImmutable,
  verifyGrokIntegrity
} from "./policy.mjs";
import { runGrokTurn } from "./runner.mjs";

const now = () => new Date().toISOString();
const done = status => ["won", "action-limit"].includes(status);
const makeId = () => `run-${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;

export function grokContinuationPrompt(summary, { resume = false, stalledTurns = 0 } = {}) {
  return `${resume ? "Resume" : "Continue"} the same MazeBench benchmark at ${summary.action_count} accepted actions. ` +
    "Call maze_observe through the MazeBench MCP gateway to re-anchor, then execute at least one gameplay action this turn. " +
    (resume ? "After that single live observation, your very next tool call must be maze_action or maze_sequence; do not read record files or call python_exec before making the first gameplay action. " : "") +
    "Do not stop because the maze seems impossible, exhausted, or solved. Keep playing until the game reports won or action-limit, or the operator pauses or stops the run. " +
    (stalledTurns > 0 ? `Your last ${stalledTurns} completed turn(s) contained no gameplay actions. Execute a gameplay action now.` : "");
}

function toml(value) {
  return JSON.stringify(String(value));
}

export function grokConfig({ projectRoot, runDirectory, grokHome = path.join(os.homedir(), ".grok") }) {
  const mcp = path.join(projectRoot, "benchmarking/grok/mcp.mjs");
  return `allow_managed_mcp_servers_only = true
enable_all_project_mcp_servers = false
plugin_auto_update = false

[[allowed_mcp_servers]]
server_name = "mazebench"

[cli]
auto_update = false
use_leader = false

[features]
backend_tools = false
campaigns = false
codebase_indexing = false
feedback = false
image_gen = false
lsp_tools = false
managed_config = false
# Grok 4.7 routing requires signed service refresh. The full signed settings
# and model policy (excluding refresh timestamps) are frozen in the manifest.
# Web and agent capabilities remain disabled by config, argv, and event checks.
remote_fetch = true
session_recap = false
session_search = false
telemetry = "off"
title_refresh = false
video_gen = false
voice_mode = false
write_file = false

[memory]
enabled = false

[memory_v2]
enabled = false
capture_enabled = false
file_writes_enabled = false

[subagents]
enabled = false

[session]
load_envrc = false

[relay]
enabled = false

[compat.claude]
agents = false
hooks = false
mcps = false
rules = false
skills = false

[compat.codex]
hooks = false
skills = false

[compat.cursor]
agents = false
hooks = false
mcps = false
rules = false
skills = false

[plugins]
enabled = []
paths = []

[skills]
paths = []
ignore = [${toml(path.join(grokHome, "bundled", "skills"))}]

[marketplace]
default_skills_installs_purged = true
official_marketplace_auto_installed = false

[telemetry]
otel_enabled = false
trace_upload = false

[mcp]
max_output_bytes = 524288

[mcp_servers.mazebench]
command = ${toml(process.execPath)}
args = [${toml(mcp)}]
env = { MAZEBENCH_PROJECT_ROOT = ${toml(projectRoot)}, MAZEBENCH_RUN_DIRECTORY = ${toml(runDirectory)} }
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 300

[permission]
allow = ["MCPTool(mazebench__*)"]
deny = ["Bash", "Edit", "Write", "Grep", "WebFetch", "WebSearch"]
`;
}

export class BenchmarkSupervisor extends WorldSupervisor {
  constructor(projectRoot, options = {}) {
    super(projectRoot, options);
    this.grokBin = options.grokBin || process.env.MAZEBENCH_GROK_BIN || "grok";
    this.grokStateRoot = path.resolve(options.grokStateRoot || process.env.MAZEBENCH_GROK_STATE_ROOT || path.join(os.homedir(), ".mazebench", "grok-build"));
    this.grokAuthHome = path.resolve(options.grokAuthHome || process.env.MAZEBENCH_GROK_AUTH_HOME || path.join(os.homedir(), ".grok"));
  }

  async providers(options = {}) {
    const [providers, grok] = await Promise.all([super.providers(options), Promise.resolve().then(() => grokInstallationStatus(this.grokBin))]);
    return { ...providers, [GROK_PROVIDER]: grok };
  }

  async models() {
    const catalog = await super.models();
    return { ...catalog, models: [...catalog.models, ...GROK_MODELS] };
  }

  async validateSpec(spec = {}) {
    if ((spec.provider || "codex") !== GROK_PROVIDER) return super.validateSpec(spec);
    const world = spec.world || "main-world";
    if (world !== "main-world") throw new Error("Grok Build currently supports the Main World benchmark only.");
    if (spec.observation_mode && spec.observation_mode !== "ascii") throw new Error("Grok Build currently supports ASCII observations only.");
    if (spec.service_tier != null && spec.service_tier !== "standard") throw new Error("Grok Build launches use subscription standard speed.");
    const selected = GROK_MODELS.find(entry => entry.id === String(spec.model || GROK_MODELS[0].id));
    if (!selected) throw new Error(`Model ${spec.model} is not available through Grok Build.`);
    const effort = String(spec.effort || selected.default_effort);
    if (!selected.efforts.includes(effort)) throw new Error(`${selected.id} does not support reasoning effort ${effort}.`);
    const actionLimit = spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited"
      ? null
      : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100)));
    return {
      provider: GROK_PROVIDER,
      world,
      observationMode: "ascii",
      model: selected.id,
      effort,
      serviceTier: null,
      toolsEnabled: Boolean(spec.tools_enabled),
      actionLimit,
      startRoom: String(spec.start_room || "HxI"),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null
    };
  }

  async createGrokHome(id, directory) {
    const home = path.join(this.grokStateRoot, id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    const config = grokConfig({ projectRoot: this.projectRoot, runDirectory: directory, grokHome: home });
    await Promise.all([
      writeFile(path.join(home, "config.toml"), config, { flag: "wx", mode: 0o600 }),
      copyFile(path.join(this.grokAuthHome, "auth.json"), path.join(home, "auth.json")),
      copyFile(path.join(this.grokAuthHome, "models_cache.json"), path.join(home, "models_cache.json")),
      copyFile(path.join(this.grokAuthHome, "settings_cache.json"), path.join(home, "settings_cache.json"))
    ]);
    await Promise.all(["auth.json", "models_cache.json", "settings_cache.json"].map(name => chmod(path.join(home, name), 0o600)));
    await chmod(path.join(home, "config.toml"), 0o400);
    setGrokConfigImmutable(path.join(home, "config.toml"));
    return {
      home,
      config,
      models: await readFile(path.join(home, "models_cache.json")),
      settings: await readFile(path.join(home, "settings_cache.json"))
    };
  }

  async launch(spec = {}) {
    if ((spec.provider || "codex") !== GROK_PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec);
    const installation = grokInstallationStatus(this.grokBin);
    if (!installation.available || !installation.tested || !installation.authenticated || !installation.model_available) throw new Error(installation.error || "Grok Build is unavailable.");
    await this.initialize();
    await mkdir(this.grokStateRoot, { recursive: true, mode: 0o700 });
    const id = makeId();
    const directory = this.runDirectory(id);
    await Promise.all(["agent-cwd", "sandbox-state"].map(name => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })));
    const isolated = await this.createGrokHome(id, directory);
    const base = await readFile(path.join(this.projectRoot, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(base, options);
    const createdAt = now();
    const configuration = {
      storage_format: "incremental-v1",
      world_updates: LIVE_WORLD_POLICY,
      world: "main-world",
      observation_mode: "ascii",
      provider: GROK_PROVIDER,
      grok_policy: GROK_POLICY,
      grok_executable: installation.executable,
      grok_version: installation.version,
      grok_sha256: digest(await readFile(installation.executable)),
      grok_home: isolated.home,
      grok_config: path.join(isolated.home, "config.toml"),
      grok_config_sha256: digest(isolated.config),
      grok_models_sha256: digest(isolated.models),
      grok_models_policy_sha256: grokModelsPolicyDigest(isolated.models),
      grok_settings_sha256: digest(isolated.settings),
      grok_settings_policy_sha256: grokSettingsPolicyDigest(isolated.settings),
      grok_runtime: await grokRuntimeHashes(this.projectRoot),
      model: options.model,
      effort: options.effort,
      tools_enabled: options.toolsEnabled,
      service_tier: null,
      action_limit: options.actionLimit,
      start_room: options.startRoom,
      effective_prompt_sha256: digest(prompt)
    };
    const metadata = {
      storage_format: "incremental-v1",
      world_updates: LIVE_WORLD_POLICY,
      schema_version: 1,
      id,
      world: "main-world",
      observation_mode: "ascii",
      provider: GROK_PROVIDER,
      pair_id: options.pairId,
      created_at: createdAt,
      updated_at: createdAt,
      status: "preparing",
      model: options.model,
      effort: options.effort,
      tools_enabled: options.toolsEnabled,
      action_limit: options.actionLimit,
      start_room: options.startRoom,
      service_tier: null,
      service_tier_history: [{ at: createdAt, service_tier: "standard", source: "Initial run configuration" }],
      prompt_sha256: digest(base),
      effective_prompt_sha256: digest(prompt),
      grok_session_id: null,
      continuation_count: 0,
      error: null,
      stopped_at: null,
      completed_at: null,
      capability_policy: {
        version: CAPABILITY_POLICY_VERSION,
        name: GROK_POLICY,
        grok_version: installation.version,
        transport_tools: ["search_tool", "use_tool"],
        tools: options.toolsEnabled ? "maze-and-isolated-python" : "maze-only"
      },
      isolation: { mode: "no-python" }
    };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, "prompt.md"), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, "run.json"), metadata);
    try {
      await BenchmarkGameRuntime.create(this.projectRoot, directory, { startRoom: options.startRoom, incremental: true, actionLimit: options.actionLimit });
      if (options.toolsEnabled) {
        metadata.isolation = this.pythonPreflight(directory);
        await atomicJson(path.join(directory, "sandbox-preflight.json"), metadata.isolation);
      }
      await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = "queued";
      metadata.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
      this.startGrok(id, directory, prompt);
    } catch (error) {
      metadata.status = "failed";
      metadata.error = error.message;
      metadata.completed_at = now();
      metadata.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
      throw error;
    }
    return this.get(id);
  }

  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.provider !== GROK_PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyGrokIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }

  startGrok(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.grokLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      metadata.status = "failed";
      metadata.error = error.message;
      metadata.updated_at = now();
      metadata.completed_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }

  runGrokTurn(options) {
    return runGrokTurn(options);
  }

  async grokLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.grok_session_id ? "continuing" : "running";
      metadata.updated_at = now();
      await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await this.runGrokTurn({
        directory, metadata, frozen, prompt, control,
        onSession: async session => {
          const current = await readJson(file);
          if (current.grok_session_id === session) return;
          current.grok_session_id = session;
          current.updated_at = now();
          await atomicJson(file, current);
        }
      });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyGrokIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (turn.usage) metadata.usage = turn.usage;
      if (control.pauseRequested || control.stopRequested) break;
      if (turn.code !== 0 || !turn.result || turn.result.is_error) throw new Error(turn.error || `Grok Build exited with status ${turn.code}.`);
      if (done(summary.game_status)) {
        metadata.status = "completed";
        metadata.completed_at = now();
        metadata.updated_at = now();
        await atomicJson(file, metadata);
        return;
      }
      if (!metadata.grok_session_id) throw new Error("Grok Build did not report a resumable session.");
      metadata.continuation_count += 1;
      metadata.last_turn_actions = summary.action_count - before;
      metadata.last_turn_gameplay_actions = summary.actions.filter(action => action.index > before && !action.action.startsWith("camera ")).length;
      metadata.consecutive_no_gameplay_turns = metadata.last_turn_gameplay_actions > 0 ? 0 : (metadata.consecutive_no_gameplay_turns || 0) + 1;
      metadata.updated_at = now();
      await atomicJson(file, metadata);
      prompt = grokContinuationPrompt(summary, { stalledTurns: metadata.consecutive_no_gameplay_turns });
    }
    const metadata = await readJson(file);
    metadata.status = control.pauseRequested ? "paused" : "stopped";
    metadata.updated_at = now();
    metadata[control.pauseRequested ? "paused_at" : "stopped_at"] = now();
    await atomicJson(file, metadata);
  }

  async resume(id) {
    const directory = this.runDirectory(id);
    const file = path.join(directory, "run.json");
    const metadata = await readJson(file);
    if (metadata.provider !== GROK_PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    if (!["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    const freshRecovery = metadata.grok_session_recovery === "fresh";
    if (!metadata.grok_session_id && !freshRecovery) throw new Error("This benchmark has no resumable Grok Build session.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (done(summary.game_status)) throw new Error("This benchmark has reached its terminal game state.");
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    delete metadata.grok_session_recovery;
    await atomicJson(file, metadata);
    this.startGrok(id, directory, grokContinuationPrompt(summary, { resume: true, stalledTurns: metadata.consecutive_no_gameplay_turns || (metadata.last_turn_actions === 0 ? 1 : 0) }));
    return this.get(id);
  }

  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === GROK_PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === GROK_POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), "integrity-violation.json"));
      run.compaction_recoverable = run.status === "failed" && run.capability_boundary_verified && Boolean(run.grok_session_id);
    }
    return run;
  }

  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== GROK_PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: "Grok Build interviews are not implemented." };
  }

  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider === GROK_PROVIDER) throw new Error("Grok Build interviews are not implemented.");
    return super.createInterview(id);
  }

  async delete(id) {
    const directory = this.runDirectory(id);
    const metadata = await readJson(path.join(directory, "run.json"));
    const result = await super.delete(id);
    if (metadata?.provider === GROK_PROVIDER) {
      const home = path.join(this.grokStateRoot, metadata.id);
      const config = path.join(home, "config.toml");
      if (existsSync(config)) setGrokConfigImmutable(config, false);
      await rm(home, { recursive: true, force: true });
    }
    return result;
  }
}
