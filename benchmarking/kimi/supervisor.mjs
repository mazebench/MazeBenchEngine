// New provider code lives outside the older providers' frozen asset trees.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor as PreviousSupervisor } from "../code/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { KIMI_PROVIDER, kimiInstallationStatus } from "./status.mjs";
import { POLICY, toolNames, defaultBinary, authHome, credential, configFiles, digest, immutable, inspectInstallation, runtimeHashes, verifyIntegrity } from "./policy.mjs";
import { codingMode } from "../coding-mode.mjs";
import { runKimiTurn } from "./runner.mjs";

const now = () => new Date().toISOString();
const terminal = summary => ["won", "action-limit"].includes(summary.game_status);
export function continuation(summary) {
  return "Continue the same MazeBench run at " + summary.action_count + " accepted actions. Call maze_observe to re-anchor, then make a gameplay action. Keep playing until won, action-limit, or the operator pauses/stops the run. Do not stop merely because a turn ended.";
}
export class BenchmarkSupervisor extends PreviousSupervisor {
  constructor(projectRoot, options = {}) {
    super(projectRoot, options);
    this.kimiBin = options.kimiBin || defaultBinary();
    this.kimiAuthHome = options.kimiAuthHome || authHome();
    this.kimiStateRoot = path.resolve(options.kimiStateRoot || path.join(os.homedir(), ".mazebench", "kimi-runs"));
    this.kimiStatus = options.kimiStatus || kimiInstallationStatus;
    this.kimiInventory = null;
  }
  async inspectKimi({ force = false } = {}) {
    if (force || !this.kimiInventory || Date.now() - this.kimiInventory.at > 60000) {
      this.kimiInventory = { at: Date.now(), value: this.kimiStatus(this.kimiBin, this.kimiAuthHome) };
    }
    return this.kimiInventory.value;
  }
  async providers(options = {}) {
    const [providers, status] = await Promise.all([super.providers(options), this.inspectKimi(options)]);
    return { ...providers, [KIMI_PROVIDER]: status };
  }
  async models() {
    const [catalog, status] = await Promise.all([super.models(), this.inspectKimi()]);
    return { ...catalog, models: [...catalog.models, ...status.models] };
  }
  async validateSpec(spec = {}) {
    if (spec.provider !== KIMI_PROVIDER) return super.validateSpec(spec);
    if (spec.world && spec.world !== "main-world") throw new Error("Kimi currently supports Main World only.");
    if (spec.observation_mode && spec.observation_mode !== "ascii") throw new Error("Kimi currently supports ASCII observations only.");
    if (codingMode(spec) === "any") throw new Error("Kimi supports coding Off or Python only.");
    if (spec.service_tier != null && spec.service_tier !== "standard") throw new Error("Kimi uses its existing Kimi account login.");
    const status = await this.inspectKimi();
    const selected = status.models.find(entry => entry.id === (spec.model || status.models[0]?.id));
    if (!selected) throw new Error("This model is not available through Kimi.");
    if (spec.effort && !selected.efforts.includes(spec.effort)) throw new Error("Unsupported Kimi reasoning effort.");
    return { provider: KIMI_PROVIDER, world: "main-world", observationMode: "ascii", model: selected.id, contextLimit: selected.context_limit, effort: spec.effort || selected.default_effort,
      serviceTier: null, toolsEnabled: codingMode(spec) === "python", startRoom: String(spec.start_room || "HxI"),
      actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited" ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null };
  }
  async createKimiHome(id, directory, options) {
    const home = path.join(this.kimiStateRoot, id);
    await mkdir(home, {recursive:true, mode:0o700});
    await mkdir(path.join(home, "skills"), {recursive:true, mode:0o700});
    const files = configFiles({root:this.projectRoot, directory, ...options});
    const config = {};
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(home, name);
      await writeFile(file, contents, {flag:"wx", mode:0o400});
      immutable(file);
      config[name] = digest(contents);
    }
    return {home, config};
  }
  async launch(spec = {}) {
    if (spec.provider !== KIMI_PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec);
    const installation = inspectInstallation(this.kimiBin);
    const readiness = await this.inspectKimi({ force: true });
    if (!installation.tested || !readiness.launch_ready || !readiness.models.some(entry => entry.id === options.model)) throw new Error(readiness.error || "Kimi is not ready. Check installation and sign-in.");
    options.contextLimit = readiness.models.find(entry => entry.id === options.model).context_limit;
    options.baseUrl = credential(this.kimiAuthHome).base_url;
    await this.initialize();
    const id = "run-" + now().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
    const directory = this.runDirectory(id);
    await mkdir(this.kimiStateRoot, { recursive: true, mode: 0o700 });
    await Promise.all(["agent-cwd", "sandbox-state"].map(name => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })));
    const isolated = await this.createKimiHome(id, directory, options);
    const base = await readFile(path.join(this.projectRoot, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(base, options), createdAt = now();
    const configuration = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, world: "main-world", observation_mode: "ascii",
      provider: KIMI_PROVIDER, kimi_policy: POLICY, kimi_executable: installation.executable,
      kimi_version: installation.version, kimi_sha256: digest(await readFile(installation.executable)),
      kimi_home: isolated.home, kimi_context_limit: options.contextLimit, kimi_base_url: options.baseUrl, kimi_config: isolated.config, kimi_runtime: await runtimeHashes(this.projectRoot),
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt)
    };
    const metadata = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, schema_version: 1, id, world: "main-world", observation_mode: "ascii",
      provider: KIMI_PROVIDER, pair_id: options.pairId, created_at: createdAt, updated_at: createdAt, status: "preparing",
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, action_limit: options.actionLimit,
      start_room: options.startRoom, service_tier: null, service_tier_history: [{ at: createdAt, service_tier: "standard", source: "Initial run configuration" }],
      prompt_sha256: digest(base), effective_prompt_sha256: digest(prompt), kimi_session_id: null, continuation_count: 0,
      error: null, stopped_at: null, completed_at: null, isolation: { mode: "no-python" },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, kimi_version: installation.version, transport_tools: toolNames(options.toolsEnabled),
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
      this.startKimi(id, directory, prompt);
    } catch (error) {
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
      throw error;
    }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.provider !== KIMI_PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }
  startKimi(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.kimiLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }
  async kimiLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.kimi_session_id ? "continuing" : "running";
      metadata.updated_at = now(); await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await runKimiTurn({ directory, metadata, frozen, prompt, control,
        credentialHome: this.kimiAuthHome,
        onSession: async session => {
          const current = await readJson(file);
          current.kimi_session_id = session; current.updated_at = now();
          await atomicJson(file, current);
        }
      });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (turn.usage) {
        metadata.usage = turn.usage;
        await atomicJson(file, metadata);
      }
      if (control.pauseRequested || control.stopRequested) break;
      if (turn.code !== 0 || turn.result?.status !== "SUCCESS") throw new Error(turn.error || "Kimi exited unexpectedly.");
      if (terminal(summary)) {
        Object.assign(metadata, { status: "completed", completed_at: now(), updated_at: now() });
        await atomicJson(file, metadata); return;
      }
      if (!metadata.kimi_session_id) throw new Error("Kimi did not return a resumable conversation.");
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
    if (metadata.provider !== KIMI_PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    if (!["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.kimi_session_id) throw new Error("This benchmark has no resumable Kimi conversation.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (terminal(summary)) throw new Error("This benchmark has reached its terminal game state.");
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata);
    this.startKimi(id, directory, continuation(summary));
    return this.get(id);
  }
  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === KIMI_PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), "integrity-violation.json"));
      run.compaction_recoverable = run.status === "failed" && run.capability_boundary_verified && Boolean(run.kimi_session_id);
    }
    return run;
  }
  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== KIMI_PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: "Kimi interviews are not implemented." };
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider === KIMI_PROVIDER) throw new Error("Kimi interviews are not implemented.");
    return super.createInterview(id);
  }
  async delete(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== KIMI_PROVIDER) return super.delete(id);
    if (this.active.has(id)) throw new Error("Stop this benchmark before deleting it.");
    
    let result;
    try { result = await super.delete(id); }
    catch (error) { throw error; }
    const home = path.join(this.kimiStateRoot, id);
    for (const name of ["config.toml", "mcp.json"]) {
      const config = path.join(home, name);
      if (existsSync(config)) immutable(config, false);
    }
    await rm(home, { recursive: true, force: true });
    return result;
  }
}
