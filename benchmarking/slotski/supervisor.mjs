// World routing is outside the frozen v1/provider trees so existing runs keep
// their exact attested engine and CLI policies.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkSupervisor as WorldSupervisor } from "../worlds/supervisor.mjs";
import { BenchmarkSupervisor as ProviderSupervisor } from "../providers/supervisor.mjs";
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from "../v1/integrity.mjs";
import { writeDirectToolModelCatalog } from "../v1/supervisor.mjs";
import { claudeInstallationStatus, CLAUDE_POLICY, digest, providerRuntimeHashes } from "../providers/claude-policy.mjs";
import { atomicJson, readJson } from "../providers/claude-runner.mjs";
import { SlotskiBenchmarkRuntime } from "../../slotski/v1/benchmark-runtime.mjs";
import { worldRuntimeHashes, verifySlotskiIntegrity } from "./policy.mjs";
import { runClaudeTurn } from "./claude-runner.mjs";
import { runSlotskiCodexTurn } from "./codex-runner.mjs";
import { sequenceEnabled, slotskiPrompt } from "./action-policy.mjs";
const now = () => new Date().toISOString();
const done = status => ["won", "action-limit"].includes(status);
const continuation = (count, sequences = true) => `Continue the same Slotski benchmark at accepted action ${count}. Call maze_observe, review your own move records if useful, then keep playing. Move individual labelled blocks one cell at a time; the 2×2 target A must reach the bottom-center exit. ${sequences ? "" : "Only maze_action can change the board: submit one action, inspect its result, then choose the next. Repeats and multi-move requests are rejected. "}Stop only on won or action-limit.`;

export class BenchmarkSupervisor extends WorldSupervisor {
  async validateSpec(spec = {}) {
    if (spec.world !== "slotski") return super.validateSpec(spec);
    if (spec.start_level !== undefined && spec.start_level !== 1) throw new Error("Slotski has only level 1.");
    if (spec.service_tier != null && spec.service_tier !== "standard") throw new Error("Slotski launches use standard speed.");
    return { ...await ProviderSupervisor.prototype.validateSpec.call(this, { ...spec, start_room: "Level 1" }), world: "slotski", sequenceEnabled: sequenceEnabled(spec.sequence_enabled) };
  }
  async launch(spec = {}) {
    if (spec.world !== "slotski") return super.launch(spec);
    const options = await this.validateSpec(spec);
    let capability, installation;
    if (options.provider === "codex") capability = this.codexCapabilityPolicy();
    else {
      installation = claudeInstallationStatus(this.claudeBin);
      if (!installation.available || !installation.tested || !installation.authenticated) throw new Error(installation.error || "Claude Code is unavailable.");
    }
    await this.initialize();
    const id = `run-${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`, directory = this.runDirectory(id);
    for (const name of ["agent-cwd", "sandbox-state"]) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    if (capability) capability.model_catalog = await writeDirectToolModelCatalog(directory, options.model);
    const base = await readFile(path.join(this.projectRoot, "benchmarking/slotski/EVAL-PROMPT.md"), "utf8");
    const prompt = slotskiPrompt(base, options);
    const metadata = { storage_format: "incremental-v1", schema_version: 1, id, world: "slotski", provider: options.provider, pair_id: options.pairId, created_at: now(), updated_at: now(), status: "preparing",
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, action_limit: options.actionLimit, start_room: "Level 1",
      sequence_enabled: options.sequenceEnabled, service_tier: null,
      prompt_sha256: digest(base), effective_prompt_sha256: digest(prompt), codex_thread_id: null, claude_session_id: null,
      continuation_count: 0, error: null, completed_at: null, stopped_at: null,
      capability_policy: capability || { version: CAPABILITY_POLICY_VERSION, name: CLAUDE_POLICY, claude_version: installation.version, tools: options.toolsEnabled ? "maze-and-isolated-python" : "maze-only" },
      isolation: { mode: "no-python" } };
    const configuration = { storage_format: "incremental-v1", world: metadata.world, provider: metadata.provider, model: metadata.model, effort: metadata.effort, tools_enabled: metadata.tools_enabled,
      sequence_enabled: metadata.sequence_enabled, service_tier: metadata.service_tier,
      action_limit: metadata.action_limit, start_room: metadata.start_room, effective_prompt_sha256: metadata.effective_prompt_sha256,
      world_runtime: await worldRuntimeHashes(this.projectRoot),
      ...(capability ? { codex_policy: capability } : { claude_policy: CLAUDE_POLICY, claude_executable: installation.executable, claude_version: installation.version,
        claude_sha256: digest(await readFile(installation.executable)), provider_runtime: await providerRuntimeHashes(this.projectRoot) }) };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, "prompt.md"), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, "run.json"), metadata);
    try {
      await SlotskiBenchmarkRuntime.create(this.projectRoot, directory, { incremental: true, actionLimit: options.actionLimit });
      if (options.toolsEnabled) { metadata.isolation = this.pythonPreflight(directory); await atomicJson(path.join(directory, "sandbox-preflight.json"), metadata.isolation); }
      metadata.status = "queued"; await atomicJson(path.join(directory, "run.json"), metadata); this.startSlotski(id, directory, prompt);
    } catch (error) { metadata.status = "failed"; metadata.error = error.message; metadata.completed_at = now(); await atomicJson(path.join(directory, "run.json"), metadata); throw error; }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.world !== "slotski") return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifySlotskiIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    if (metadata.provider === "codex") {
      const current = this.codexCapabilityPolicy();
      if (current.codex_sha256 !== frozen.codex_policy.codex_sha256) throw new Error("Codex executable changed.");
      return { capabilityPolicy: frozen.codex_policy, modelCatalog: { path: path.join(directory, frozen.codex_policy.model_catalog.file) } };
    }
    return frozen;
  }
  startSlotski(id, directory, prompt) {
    const control = { child: null, stopRequested: false, pauseRequested: false, threadId: null };
    this.active.set(id, control);
    this.slotskiLoop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, "run.json"));
      metadata.status = "failed"; metadata.error = error.message; metadata.updated_at = now(); metadata.completed_at = now();
      await atomicJson(path.join(directory, "run.json"), metadata);
    }).finally(() => this.active.delete(id));
  }
  async slotskiLoop(directory, prompt, control) {
    const file = path.join(directory, "run.json");
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = metadata.codex_thread_id || metadata.claude_session_id ? "continuing" : "running"; metadata.updated_at = now(); await atomicJson(file, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      const before = (await readJson(path.join(directory, "summary.json"))).action_count;
      const claude = metadata.provider === "claude-code";
      const turn = claude ? await runClaudeTurn({ projectRoot: this.projectRoot, directory, metadata, frozen, prompt, control,
        onSession: async session => { const current = await readJson(file); current.claude_session_id = session; current.updated_at = now(); await atomicJson(file, current); } })
        : await runSlotskiCodexTurn.call(this, { metadata, directory, agentDirectory: path.join(directory, "agent-cwd"), prompt, resumeThreadId: metadata.codex_thread_id, control });
      metadata = await readJson(file);
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      await verifySlotskiIntegrity(this.projectRoot, directory, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      if (turn.code !== 0 || (claude && (!turn.result || turn.result.is_error)) || (!claude && turn.reportedError)) throw new Error(turn.error || turn.reportedError || turn.stderrTail || `Agent exited with status ${turn.code}.`);
      const summary = await readJson(path.join(directory, "summary.json"));
      if (turn.usage) metadata.usage = turn.usage;
      if (done(summary.game_status)) { metadata.status = "completed"; metadata.completed_at = now(); metadata.updated_at = now(); await atomicJson(file, metadata); return; }
      if (!(claude ? metadata.claude_session_id : metadata.codex_thread_id)) throw new Error("Agent did not report a resumable session.");
      metadata.continuation_count++; metadata.last_turn_actions = summary.action_count - before; metadata.updated_at = now(); await atomicJson(file, metadata);
      prompt = continuation(summary.action_count, metadata.sequence_enabled);
    }
    const metadata = await readJson(file); metadata.status = control.pauseRequested ? "paused" : "stopped"; metadata.updated_at = now(); metadata[control.pauseRequested ? "paused_at" : "stopped_at"] = now(); await atomicJson(file, metadata);
  }
  async resume(id) {
    const directory = this.runDirectory(id), file = path.join(directory, "run.json"), metadata = await readJson(file);
    if (metadata.world !== "slotski") return super.resume(id);
    if (this.active.has(id) || !["paused", "stopped", "failed"].includes(metadata.status)) throw new Error("This benchmark cannot be resumed.");
    await this.verifyRunCapabilityBoundary(metadata, directory);
    const summary = await readJson(path.join(directory, "summary.json"));
    if (done(summary.game_status)) throw new Error("This benchmark has reached its terminal state.");
    if (!(metadata.provider === "claude-code" ? metadata.claude_session_id : metadata.codex_thread_id)) throw new Error("This benchmark has no resumable session.");
    Object.assign(metadata, { status: "queued", error: null, completed_at: null, stopped_at: null, paused_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata); this.startSlotski(id, directory, continuation(summary.action_count, metadata.sequence_enabled)); return this.get(id);
  }
  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    return metadata.world === "slotski" ? { schema_version: 2, run_id: id, available: false, chats: [], reason: "Slotski interviews are not implemented." } : super.listInterviews(id);
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), "run.json"));
    if (metadata.world === "slotski") throw new Error("Slotski interviews are not implemented.");
    return super.createInterview(id);
  }
  async backfillDisplayHistory(id, directory) {
    const metadata = await readJson(path.join(directory, "run.json"));
    if (metadata.world === "slotski") throw new Error("This Slotski frame is missing from the recorded history.");
    return super.backfillDisplayHistory(id, directory);
  }
}
