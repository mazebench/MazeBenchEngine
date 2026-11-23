// New provider code lives outside the older providers' frozen asset trees.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor as GrokSupervisor } from "../grok/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { ANTIGRAVITY_PROVIDER, ANTIGRAVITY_MODELS, antigravityInstallationStatus } from "./status.mjs";
import { POLICY, TRANSPORT_TOOLS, agentDefinition, authHome, tokenPath, settings, digest, immutable, inspectInstallation, runtimeHashes, verifyIntegrity } from "./policy.mjs";
import { runAntigravityTurn } from "./runner.mjs";

const now = () => new Date().toISOString();
const terminal = summary => ["won", "action-limit"].includes(summary.game_status);
export function continuation(summary) {
  return "Continue the same MazeBench run at " + summary.action_count + " accepted actions. Call maze_observe to re-anchor, then make a gameplay action. Keep playing until won, action-limit, or the operator pauses/stops the run. Do not stop merely because a turn ended.";
}
export class BenchmarkSupervisor extends GrokSupervisor {
  constructor(projectRoot, options = {}) {
    super(projectRoot, options);
    this.antigravityBin = options.antigravityBin || process.env.MAZEBENCH_ANTIGRAVITY_BIN || "agy";
    this.antigravityAuthHome = options.antigravityAuthHome || authHome();
    this.antigravityStateRoot = path.resolve(options.antigravityStateRoot || path.join(os.homedir(), ".mazebench", "antigravity-runs"));
    this.antigravityStatus = options.antigravityStatus || antigravityInstallationStatus;
    this.antigravityInventory = null;
  }
  async inspectAntigravity({ force = false } = {}) {
    if (force || !this.antigravityInventory || Date.now() - this.antigravityInventory.at > 60000) {
      this.antigravityInventory = { at: Date.now(), value: this.antigravityStatus(this.antigravityBin) };
    }
    return this.antigravityInventory.value;
  }
  async providers(options = {}) {
    const [providers, status] = await Promise.all([super.providers(options), this.inspectAntigravity(options)]);
    return { ...providers, [ANTIGRAVITY_PROVIDER]: status };
  }
  async models() {
    const [catalog, status] = await Promise.all([super.models(), this.inspectAntigravity()]);
    return { ...catalog, models: [...catalog.models, ...status.models] };
  }
  async validateSpec(spec = {}) {
    if (spec.provider !== ANTIGRAVITY_PROVIDER) return super.validateSpec(spec);
    if (spec.world && spec.world !== "main-world") throw new Error("Antigravity currently supports Main World only.");
    if (spec.observation_mode && spec.observation_mode !== "ascii") throw new Error("Antigravity currently supports ASCII observations only.");
    if (spec.service_tier != null && spec.service_tier !== "standard") throw new Error("Antigravity uses subscription standard speed.");
    const selected = ANTIGRAVITY_MODELS.find(entry => entry.id === (spec.model || ANTIGRAVITY_MODELS[0].id));
    if (!selected) throw new Error("This model is not available through Antigravity.");
    if (spec.effort && !selected.efforts.includes(spec.effort)) throw new Error("Select the matching Gemini model/effort preset.");
    return { provider: ANTIGRAVITY_PROVIDER, world: "main-world", observationMode: "ascii", model: selected.id, effort: selected.default_effort,
      serviceTier: null, toolsEnabled: Boolean(spec.tools_enabled), startRoom: String(spec.start_room || "HxI"),
      actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited" ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null };
  }
  async createAntigravityHome(id, directory, toolsEnabled) {
    const home = path.join(this.antigravityStateRoot, id);
    const agent = path.join(directory, "agent-cwd/.agents/agents/mazebench/agent.md");
    const settingsFile = path.join(home, ".gemini/antigravity-cli/settings.json");
    await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(agent), { recursive: true, mode: 0o700 });
    await copyFile(tokenPath(this.antigravityAuthHome), tokenPath(home));
    await chmod(tokenPath(home), 0o600);
    const definition = agentDefinition({ command: process.execPath, args: [path.join(this.projectRoot, "benchmarking/antigravity/mcp.mjs")],
      env: { MAZEBENCH_PROJECT_ROOT: this.projectRoot, MAZEBENCH_RUN_DIRECTORY: directory }, toolsEnabled });
    const config = {};
    for (const [file, contents] of [[settingsFile, JSON.stringify(settings(toolsEnabled))], [agent, definition]]) {
      await writeFile(file, contents, { flag: "wx", mode: 0o400 });
      immutable(file);
      config[file] = digest(contents);
    }
    return { home, config };
  }
  async launch(spec = {}) {
    if (spec.provider !== ANTIGRAVITY_PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec);
    const installation = inspectInstallation(this.antigravityBin);
    const readiness = await this.inspectAntigravity({ force: true });
    if (!installation.tested || !readiness.launch_ready || !readiness.models.some(entry => entry.id === options.model)) throw new Error(readiness.error || "Antigravity has not passed certification.");
    await this.initialize();
    const id = "run-" + now().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
    const directory = this.runDirectory(id);
    await mkdir(this.antigravityStateRoot, { recursive: true, mode: 0o700 });
    await Promise.all(["agent-cwd", "sandbox-state"].map(name => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })));
    const isolated = await this.createAntigravityHome(id, directory, options.toolsEnabled);
    const base = await readFile(path.join(this.projectRoot, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(base, options), createdAt = now();
    const configuration = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, world: "main-world", observation_mode: "ascii",
      provider: ANTIGRAVITY_PROVIDER, antigravity_policy: POLICY, antigravity_executable: installation.executable,
      antigravity_version: installation.version, antigravity_sha256: digest(await readFile(installation.executable)),
      antigravity_home: isolated.home, antigravity_config: isolated.config, antigravity_runtime: await runtimeHashes(this.projectRoot),
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt)
    };
    const metadata = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, schema_version: 1, id, world: "main-world", observation_mode: "ascii",
      provider: ANTIGRAVITY_PROVIDER, pair_id: options.pairId, created_at: createdAt, updated_at: createdAt, status: "preparing",
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, action_limit: options.actionLimit,
      start_room: options.startRoom, service_tier: null, service_tier_history: [{ at: createdAt, service_tier: "standard", source: "Initial run configuration" }],
      prompt_sha256: digest(base), effective_prompt_sha256: digest(prompt), antigravity_session_id: null, continuation_count: 0,
      error: null, stopped_at: null, completed_at: null, isolation: { mode: "no-python" },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, antigravity_version: installation.version, transport_tools: TRANSPORT_TOOLS,
        tools: options.toolsEnabled ? "maze-and-isolated-python" : "maze-only" }
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
      metadata.status = "queued"; metadata.updated_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
      this.startAntigravity(id, directory, prompt);
    } catch (error) {
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
      throw error;
    }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.provider !== ANTIGRAVITY_PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }
  startAntigravity(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.antigravityLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }
  async antigravityLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.antigravity_session_id ? "continuing" : "running";
      metadata.updated_at = now(); await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await runAntigravityTurn({ directory, metadata, frozen, prompt, control,
        onSession: async session => {
          const current = await readJson(file);
          current.antigravity_session_id = session; current.updated_at = now();
          await atomicJson(file, current);
        }
      });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (control.pauseRequested || control.stopRequested) break;
      if (turn.usage) metadata.usage = turn.usage;
      if (turn.code !== 0 || turn.result?.status !== "SUCCESS") throw new Error(turn.error || "Antigravity exited unexpectedly.");
      if (terminal(summary)) {
        Object.assign(metadata, { status: "completed", completed_at: now(), updated_at: now() });
        await atomicJson(file, metadata); return;
      }
      if (!metadata.antigravity_session_id) throw new Error("Antigravity did not return a resumable conversation.");
      metadata.continuation_count += 1;
      metadata.last_turn_actions = summary.action_count - before;
      metadata.updated_at = now(); await atomicJson(file, metadata);
      prompt = continuation(summary);
    }
    const metadata = await readJson(file);
    Object.assign(metadata, { status: control.pauseRequested ? "paused" : "stopped", updated_at: now(), [control.pauseRequested ? "paused_at" : "stopped_at"]: now() });
    await atomicJson(file, metadata);
  }
  async resume(id) {
    const directory = this.runDirectory(id), file = path.join(directory, "run.json"), metadata = await readJson(file);
    if (metadata.provider !== ANTIGRAVITY_PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    if (!["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.antigravity_session_id) throw new Error("This benchmark has no resumable Antigravity conversation.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (terminal(summary)) throw new Error("This benchmark has reached its terminal game state.");
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata);
    this.startAntigravity(id, directory, continuation(summary));
    return this.get(id);
  }
  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === ANTIGRAVITY_PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), "integrity-violation.json"));
      run.compaction_recoverable = run.status === "failed" && run.capability_boundary_verified && Boolean(run.antigravity_session_id);
    }
    return run;
  }
  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== ANTIGRAVITY_PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: "Antigravity interviews are not implemented." };
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider === ANTIGRAVITY_PROVIDER) throw new Error("Antigravity interviews are not implemented.");
    return super.createInterview(id);
  }
  async delete(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== ANTIGRAVITY_PROVIDER) return super.delete(id);
    if (this.active.has(id)) throw new Error("Stop this benchmark before deleting it.");
    const agent = path.join(this.runDirectory(id), "agent-cwd/.agents/agents/mazebench/agent.md");
    if (existsSync(agent)) immutable(agent, false);
    let result;
    try { result = await super.delete(id); }
    catch (error) { if (existsSync(agent)) immutable(agent); throw error; }
    const home = path.join(this.antigravityStateRoot, id);
    const config = path.join(home, ".gemini/antigravity-cli/settings.json");
    if (existsSync(config)) immutable(config, false);
    await rm(home, { recursive: true, force: true });
    return result;
  }
}
