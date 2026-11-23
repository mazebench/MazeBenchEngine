import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkSupervisor as PreviousSupervisor } from "../prime/supervisor.mjs";
import { writeDirectToolModelCatalog } from "../v1/supervisor.mjs";
import { BenchmarkGameRuntime } from "../v1/runtime.mjs";
import { IceBenchmarkRuntime } from "../../ice-maze/v1/benchmark-runtime.mjs";
import { SlotskiBenchmarkRuntime } from "../../slotski/v1/benchmark-runtime.mjs";
import { createRunIntegrity } from "../v1/integrity.mjs";
import { LIVE_WORLD_POLICY } from "../storage/live-world.mjs";
import { safeReadFile } from "../v1/safe-files.mjs";
import { claudeInstallationStatus, CLAUDE_POLICY, digest, providerRuntimeHashes } from "../providers/claude-policy.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { worldRuntimeHashes as iceHashes } from "../worlds/policy.mjs";
import { worldRuntimeHashes as slotskiHashes } from "../slotski/policy.mjs";
import { codingMode, supportsAnyLanguage } from "../coding-mode.mjs";
import { CODE_POLICY, codeRuntimeHashes, verifyCodeIntegrity } from "./policy.mjs";
import { codePrompt } from "./prompt.mjs";
import { inspectCodeSandbox, preflightCodeSandbox } from "./sandbox.mjs";
import { runCodeCodexTurn } from "./codex-runner.mjs";
import { runCodeClaudeTurn } from "./claude-runner.mjs";

const now = () => new Date().toISOString();
const terminal = summary => ["won", "action-limit"].includes(summary.game_status);
const continuation = (summary, metadata) => `Continue the same ${metadata.world} benchmark at action ${summary.action_count}. Call maze_observe, then keep playing until won or action-limit. The any-language code_exec workspace is still available. ${metadata.world === "ice-maze" ? "Use next after completing a level. " : ""}${metadata.sequence_enabled === false ? "Use one maze_action at a time; sequences are disabled. " : ""}Only an operator pause/stop or the game's terminal status ends gameplay.`;
function isCodeRun(metadata, directory) {
  // Consult the frozen condition too, so changing just run.json cannot route a
  // third-tier run back through a legacy runner or resume policy.
  return metadata.coding_mode === "any" || metadata.code_policy ||
    (existsSync(path.join(directory, "integrity.json")) && JSON.parse(safeReadFile(directory, "integrity.json")).configuration?.coding_mode === "any");
}
export class BenchmarkSupervisor extends PreviousSupervisor {
  async providers(options = {}) {
    const [providers, sandbox] = await Promise.all([super.providers(options), inspectCodeSandbox()]);
    return Object.fromEntries(Object.entries(providers).map(([name, status]) => [name, { ...status,
      coding_modes: name === "prime-agent" ? ["python"] : ["off", "python", ...(["codex", "claude-code"].includes(name) ? ["any"] : [])],
      ...(["codex", "claude-code"].includes(name) ? { code_sandbox: { available: sandbox.available, error: sandbox.error, image: sandbox.image } } : {})
    }]));
  }
  async validateSpec(spec = {}) {
    const mode = codingMode(spec);
    if (mode === "any" && !supportsAnyLanguage(spec)) throw new Error("Any language currently supports Codex and Claude Code in Main World, Ice Maze and Slotski with ASCII observations.");
    if (mode === "any" && spec.provider === "claude-code" && spec.service_tier === "fast") throw new Error("Fast service is available for Codex only.");
    return { ...await super.validateSpec({ ...spec, tools_enabled: mode !== "off" }), codingMode: mode };
  }
  async launch(spec = {}) {
    const mode = codingMode(spec);
    if (mode !== "any") return super.launch({ ...spec, tools_enabled: mode === "python" });
    const options = await this.validateSpec(spec);
    const sandbox = await inspectCodeSandbox();
    if (!sandbox.available) throw new Error(sandbox.error);
    let capability, installation;
    if (options.provider === "codex") capability = { ...this.codexCapabilityPolicy(), code_execution: "code_exec-only" };
    else {
      installation = claudeInstallationStatus(this.claudeBin);
      if (!installation.available || !installation.tested || !installation.authenticated) throw new Error(installation.error || "Claude Code is unavailable.");
    }
    await this.initialize();
    const createdAt = now(), id = `run-${createdAt.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`, directory = this.runDirectory(id);
    for (const name of ["agent-cwd", "sandbox-state", "workspace"]) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    if (capability) capability.model_catalog = await writeDirectToolModelCatalog(directory, options.model);
    const world = spec.world || "main-world";
    const { base, prompt } = await codePrompt(this.projectRoot, spec, options);
    const configuration = {
      storage_format: "incremental-v1", ...(world === "main-world" ? { world_updates: LIVE_WORLD_POLICY } : {}),
      world, observation_mode: "ascii", provider: options.provider, coding_mode: "any", code_policy: CODE_POLICY,
      code_sandbox: sandbox, code_runtime: await codeRuntimeHashes(this.projectRoot),
      model: options.model, effort: options.effort, tools_enabled: true,
      action_limit: options.actionLimit, start_room: options.startRoom,
      sequence_enabled: world !== "slotski" || options.sequenceEnabled !== false, service_tier: options.serviceTier ?? null,
      effective_prompt_sha256: digest(prompt),
      ...(world !== "main-world" ? { world_runtime: await (world === "slotski" ? slotskiHashes : iceHashes)(this.projectRoot) } : {}),
      ...(capability ? { codex_policy: capability } : { claude_policy: CLAUDE_POLICY, claude_executable: installation.executable,
        claude_version: installation.version, claude_sha256: digest(await readFile(installation.executable)), provider_runtime: await providerRuntimeHashes(this.projectRoot) })
    };
    const metadata = { ...Object.fromEntries(["storage_format", "world_updates", "world", "observation_mode", "provider", "coding_mode", "code_policy", "code_sandbox", "model", "effort", "tools_enabled", "action_limit", "start_room", "sequence_enabled", "service_tier", "effective_prompt_sha256"].filter(key => key in configuration).map(key => [key, configuration[key]])),
      schema_version: 1, id, pair_id: options.pairId, created_at: createdAt, updated_at: createdAt, status: "preparing",
      prompt_sha256: digest(base), codex_thread_id: null, claude_session_id: null, continuation_count: 0,
      error: null, completed_at: null, stopped_at: null,
      capability_policy: capability || { version: 4, name: CLAUDE_POLICY, claude_version: installation.version, tools: "maze-and-isolated-code" },
      isolation: { verified: false } };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, "prompt.md"), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, "run.json"), metadata);
    try {
      const Runtime = world === "slotski" ? SlotskiBenchmarkRuntime : world === "ice-maze" ? IceBenchmarkRuntime : BenchmarkGameRuntime;
      await Runtime.create(this.projectRoot, directory, { startRoom: options.startRoom, incremental: true, actionLimit: options.actionLimit });
      metadata.isolation = await preflightCodeSandbox({ runDirectory: directory, sandbox });
      await atomicJson(path.join(directory, "sandbox-preflight.json"), metadata.isolation);
      await verifyCodeIntegrity(this.projectRoot, directory, metadata);
      metadata.status = "queued";
      await atomicJson(path.join(directory, "run.json"), metadata);
      this.startCode(id, directory, prompt);
    } catch (error) {
      Object.assign(metadata, { status: "failed", error: error.message, completed_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata); throw error;
    }
    return this.get(id);
  }
  async launchPair(spec = {}) {
    if (codingMode(spec) !== "any") {
      const { coding_mode, ...legacy } = spec;
      return super.launchPair(legacy);
    }
    await this.validateSpec(spec);
    const sandbox = await inspectCodeSandbox();
    if (!sandbox.available) throw new Error(sandbox.error);
    const pair_id = `pair-${randomBytes(8).toString("hex")}`;
    const off = await this.launch({ ...spec, pair_id, coding_mode: "off", tools_enabled: false });
    try { return { pair_id, runs: [off, await this.launch({ ...spec, pair_id, coding_mode: "any", tools_enabled: true })] }; }
    catch (error) { await this.stop(off.id); throw error; }
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (!isCodeRun(metadata, directory)) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyCodeIntegrity(this.projectRoot, directory, metadata);
    if (metadata.provider !== "codex") return frozen;
    const current = this.codexCapabilityPolicy();
    if (current.codex_sha256 !== frozen.codex_policy.codex_sha256) throw new Error("Codex executable changed.");
    return { capabilityPolicy: frozen.codex_policy, modelCatalog: { path: path.join(directory, frozen.codex_policy.model_catalog.file) } };
  }
  startCode(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    control.done = this.codeLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      Object.assign(metadata, { status: control.pauseRequested ? "paused" : control.stopRequested ? "stopped" : "failed", error: error.message, updated_at: now(), completed_at: now() });
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }
  async runCodeTurn(options) {
    return options.metadata.provider === "claude-code" ? runCodeClaudeTurn(options) : runCodeCodexTurn.call(this, {
      ...options, agentDirectory: path.join(options.directory, "agent-cwd"), resumeThreadId: options.metadata.codex_thread_id
    });
  }
  async codeLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.codex_thread_id || metadata.claude_session_id ? "continuing" : "running";
      metadata.updated_at = now(); await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const turn = await this.runCodeTurn({ projectRoot: this.projectRoot, directory, metadata, frozen, prompt, control,
        onSession: async session => { const current = await readJson(file); current.claude_session_id = session; current.updated_at = now(); await atomicJson(file, current); } });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifyCodeIntegrity(this.projectRoot, directory, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      if (turn.code !== 0 || turn.reportedError || (metadata.provider === "claude-code" && (!turn.result || turn.result.is_error))) throw new Error(turn.error || turn.reportedError || turn.stderrTail || "Agent turn failed.");
      const summary = await readJson(path.join(directory, "summary.json"));
      if (turn.usage) metadata.usage = turn.usage;
      if (terminal(summary)) { metadata.status = "completed"; metadata.completed_at = now(); metadata.updated_at = now(); await atomicJson(file, metadata); return; }
      if (!(metadata.codex_thread_id || metadata.claude_session_id)) throw new Error("No resumable agent session was recorded.");
      metadata.continuation_count++; metadata.last_turn_actions = summary.action_count - before;
      await atomicJson(file, metadata); prompt = continuation(summary, metadata);
    }
    const metadata = await readJson(file);
    metadata.status = control.pauseRequested ? "paused" : "stopped"; metadata.updated_at = now();
    metadata[control.pauseRequested ? "paused_at" : "stopped_at"] = now();
    await atomicJson(file, metadata);
  }
  async resume(id) {
    const directory = this.runDirectory(id), file = path.join(directory, "run.json"), metadata = await readJson(file);
    if (!isCodeRun(metadata, directory)) return super.resume(id);
    if (this.active.has(id) || !["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!(metadata.codex_thread_id || metadata.claude_session_id)) throw new Error("No resumable agent session.");
    const summary = await readJson(path.join(directory, "summary.json"));
    if (terminal(summary)) throw new Error("Run has reached its terminal state.");
    await preflightCodeSandbox({ runDirectory: directory, sandbox: metadata.code_sandbox });
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata);
    this.startCode(id, directory, continuation(summary, metadata));
    return this.get(id);
  }
  async listInterviews(id) {
    const directory = this.runDirectory(id), metadata = await readJson(path.join(directory, "run.json"));
    if (!isCodeRun(metadata, directory)) return super.listInterviews(id);
    return { run_id: id, available: false, chats: [], reason: "Interviews are unavailable for any-language runs." };
  }
  async createInterview(id, ...args) {
    const directory = this.runDirectory(id), metadata = await readJson(path.join(directory, "run.json"));
    if (isCodeRun(metadata, directory)) throw new Error("Interviews are unavailable for any-language runs.");
    return super.createInterview(id, ...args);
  }
}
