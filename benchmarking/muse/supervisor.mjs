// New provider code lives outside the older providers' frozen asset trees.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor as PreviousSupervisor } from "../antigravity/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { buildBenchmarkPrompt } from "../v1/supervisor.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { MUSE_PROVIDER, museInstallationStatus } from "./status.mjs";
import { POLICY, toolNames, defaultBinary, authHome, tokenPath, settings, digest, immutable, inspectInstallation, runtimeHashes, verifyIntegrity } from "./policy.mjs";
import { runMuseTurn } from "./runner.mjs";

const now = () => new Date().toISOString();
const terminal = summary => ["won", "action-limit"].includes(summary.game_status);
export function continuation(summary) {
  return "Continue the same MazeBench run at " + summary.action_count + " accepted actions. Call maze_observe to re-anchor, then make a gameplay action. Keep playing until won, action-limit, or the operator pauses/stops the run. Do not stop merely because a turn ended.";
}
export class BenchmarkSupervisor extends PreviousSupervisor {
  constructor(projectRoot, options = {}) {
    super(projectRoot, options);
    this.museBin = options.museBin || defaultBinary();
    this.museAuthHome = options.museAuthHome || authHome();
    this.museStateRoot = path.resolve(options.museStateRoot || path.join(os.homedir(), ".mazebench", "muse-runs"));
    this.museStatus = options.museStatus || museInstallationStatus;
    this.museInventory = null;
  }
  async inspectMuse({ force = false } = {}) {
    if (force || !this.museInventory || Date.now() - this.museInventory.at > 60000) {
      this.museInventory = { at: Date.now(), value: this.museStatus(this.museBin) };
    }
    return this.museInventory.value;
  }
  async providers(options = {}) {
    const [providers, status] = await Promise.all([super.providers(options), this.inspectMuse(options)]);
    return { ...providers, [MUSE_PROVIDER]: status };
  }
  async models() {
    const [catalog, status] = await Promise.all([super.models(), this.inspectMuse()]);
    return { ...catalog, models: [...catalog.models, ...status.models] };
  }
  async validateSpec(spec = {}) {
    if (spec.provider !== MUSE_PROVIDER) return super.validateSpec(spec);
    if (spec.world && spec.world !== "main-world") throw new Error("Muse currently supports Main World only.");
    if (spec.observation_mode && spec.observation_mode !== "ascii") throw new Error("Muse currently supports ASCII observations only.");
    if (spec.service_tier != null && spec.service_tier !== "standard") throw new Error("Muse uses its existing Meta account login.");
    const status = await this.inspectMuse();
    const selected = status.models.find(entry => entry.id === (spec.model || status.models[0]?.id));
    if (!selected) throw new Error("This model is not available through Muse.");
    if (spec.effort && !selected.efforts.includes(spec.effort)) throw new Error("Unsupported Muse reasoning effort.");
    return { provider: MUSE_PROVIDER, world: "main-world", observationMode: "ascii", model: selected.id, effort: spec.effort || selected.default_effort,
      serviceTier: null, toolsEnabled: Boolean(spec.tools_enabled), startRoom: String(spec.start_room || "HxI"),
      actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === "unlimited" ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null };
  }
  async createMuseHome(id, directory, toolsEnabled) {
    const home = path.join(this.museStateRoot, id);
    const settingsFile = path.join(home, ".config/muse/settings.json");
    await mkdir(path.dirname(settingsFile), {recursive:true,mode:0o700});
    await mkdir(path.join(home,".local/share"), {recursive:true,mode:0o700});
    await copyFile(tokenPath(this.museAuthHome), tokenPath(home));
    await chmod(tokenPath(home),0o600);
    const value=settings({command:process.execPath,args:[path.join(this.projectRoot,"benchmarking/muse/mcp.mjs")],
      env:{MAZEBENCH_PROJECT_ROOT:this.projectRoot,MAZEBENCH_RUN_DIRECTORY:directory},toolsEnabled});
    const contents=JSON.stringify(value);
    await writeFile(settingsFile,contents,{flag:"wx",mode:0o400});
    immutable(settingsFile);
    return {home,config:{[settingsFile]:digest(contents)}};
  }
  async launch(spec = {}) {
    if (spec.provider !== MUSE_PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec);
    const installation = inspectInstallation(this.museBin);
    const readiness = await this.inspectMuse({ force: true });
    if (!installation.tested || !readiness.launch_ready || !readiness.models.some(entry => entry.id === options.model)) throw new Error(readiness.error || "Muse is not ready. Check installation and sign-in.");
    await this.initialize();
    const id = "run-" + now().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
    const directory = this.runDirectory(id);
    await mkdir(this.museStateRoot, { recursive: true, mode: 0o700 });
    await Promise.all(["agent-cwd", "sandbox-state"].map(name => mkdir(path.join(directory, name), { recursive: true, mode: 0o700 })));
    const isolated = await this.createMuseHome(id, directory, options.toolsEnabled);
    const base = await readFile(path.join(this.projectRoot, "benchmarking/v1/EVAL-PROMPT.md"), "utf8");
    const prompt = buildBenchmarkPrompt(base, options), createdAt = now();
    const configuration = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, world: "main-world", observation_mode: "ascii",
      provider: MUSE_PROVIDER, muse_policy: POLICY, muse_executable: installation.executable,
      muse_version: installation.version, muse_sha256: digest(await readFile(installation.executable)),
      muse_home: isolated.home, muse_config: isolated.config, muse_runtime: await runtimeHashes(this.projectRoot),
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt)
    };
    const metadata = {
      storage_format: "incremental-v1", world_updates: LIVE_WORLD_POLICY, schema_version: 1, id, world: "main-world", observation_mode: "ascii",
      provider: MUSE_PROVIDER, pair_id: options.pairId, created_at: createdAt, updated_at: createdAt, status: "preparing",
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, action_limit: options.actionLimit,
      start_room: options.startRoom, service_tier: null, service_tier_history: [{ at: createdAt, service_tier: "standard", source: "Initial run configuration" }],
      prompt_sha256: digest(base), effective_prompt_sha256: digest(prompt), muse_session_id: null, continuation_count: 0,
      error: null, stopped_at: null, completed_at: null, isolation: { mode: "no-python" },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, muse_version: installation.version, transport_tools: toolNames(options.toolsEnabled),
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
      this.startMuse(id, directory, prompt);
    } catch (error) {
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
      throw error;
    }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.provider !== MUSE_PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }
  startMuse(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.museLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }
  async museLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.muse_session_id ? "continuing" : "running";
      metadata.updated_at = now(); await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await runMuseTurn({ directory, metadata, frozen, prompt, control,
        onSession: async session => {
          const current = await readJson(file);
          current.muse_session_id = session; current.updated_at = now();
          await atomicJson(file, current);
        }
      });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (control.pauseRequested || control.stopRequested) break;
      if (turn.usage) metadata.usage = turn.usage;
      if (turn.code !== 0 || turn.result?.status !== "SUCCESS") throw new Error(turn.error || "Muse exited unexpectedly.");
      if (terminal(summary)) {
        Object.assign(metadata, { status: "completed", completed_at: now(), updated_at: now() });
        await atomicJson(file, metadata); return;
      }
      if (!metadata.muse_session_id) throw new Error("Muse did not return a resumable conversation.");
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
    if (metadata.provider !== MUSE_PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error("This benchmark is already running.");
    if (!["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.muse_session_id) throw new Error("This benchmark has no resumable Muse conversation.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (terminal(summary)) throw new Error("This benchmark has reached its terminal game state.");
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata);
    this.startMuse(id, directory, continuation(summary));
    return this.get(id);
  }
  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === MUSE_PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), "integrity-violation.json"));
      run.compaction_recoverable = run.status === "failed" && run.capability_boundary_verified && Boolean(run.muse_session_id);
    }
    return run;
  }
  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== MUSE_PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: "Muse interviews are not implemented." };
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider === MUSE_PROVIDER) throw new Error("Muse interviews are not implemented.");
    return super.createInterview(id);
  }
  async delete(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.provider !== MUSE_PROVIDER) return super.delete(id);
    if (this.active.has(id)) throw new Error("Stop this benchmark before deleting it.");
    
    let result;
    try { result = await super.delete(id); }
    catch (error) { throw error; }
    const home = path.join(this.museStateRoot, id);
    const config = path.join(home, ".config/muse/settings.json");
    if (existsSync(config)) immutable(config, false);
    await rm(home, { recursive: true, force: true });
    return result;
  }
}
