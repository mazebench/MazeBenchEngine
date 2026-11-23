import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor as PreviousSupervisor } from '../all-code/supervisor.mjs';
import { BenchmarkSupervisor as BaseSupervisor } from '../v1/supervisor.mjs';
import { BenchmarkGameRuntime } from '../v1/runtime.mjs';
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from '../v1/integrity.mjs';
import { LIVE_WORLD_POLICY } from '../storage/live-world.mjs';
import { atomicJson, readJson } from '../providers/claude-runner.mjs';
import { POLICY, TOOLS, digest, directPrompt, isDirect, isDirectSpec, runtimeHashes, verifyIntegrity } from './policy.mjs';
import { fetchCatalog, samplingFor } from './catalog.mjs';
import { runDirect } from './runner.mjs';

const now = () => new Date().toISOString();
export class BenchmarkSupervisor extends PreviousSupervisor {
  constructor(root, options = {}) {
    super(root, options);
    this.directStateRoot = options.directStateRoot || path.join(os.homedir(), '.mazebench/prime-direct/runs');
    this.directCatalog = options.directCatalog || fetchCatalog;
    this.directInventory = null;
  }
  async inspectDirect({ force = false } = {}) {
    if (force || !this.directInventory || Date.now() - this.directInventory.at > 60000) {
      this.directInventory = { at: Date.now(), value: this.directCatalog().then(models => ({
        available: true, authenticated: true, tested: true, launch_ready: true, version: POLICY, models
      })).catch(error => ({ available: false, authenticated: false, tested: true, launch_ready: false, error: error.message, models: [] })) };
    }
    return this.directInventory.value;
  }
  async validateSpec(spec = {}) {
    if (!isDirectSpec(spec)) return super.validateSpec(spec);
    if ((spec.coding_mode && spec.coding_mode !== 'off') || spec.tools_enabled === true) throw new Error('Prime direct requires Python off.');
    if ((spec.world && spec.world !== 'main-world') || (spec.observation_mode && spec.observation_mode !== 'ascii')) throw new Error('Prime direct supports Main World ASCII.');
    if (spec.pair_id) throw new Error('The direct and native Prime harnesses are separate benchmark conditions. Start a single run.');
    if (spec.service_tier && spec.service_tier !== 'standard') throw new Error('Prime direct does not support this service tier.');
    const status = await this.inspectDirect();
    if (!status.launch_ready) throw new Error(status.error || 'Prime Inference is unavailable.');
    const model = status.models.find(m => m.id === spec.model);
    if (!model) throw new Error('This model does not advertise direct tool support in the Prime catalog.');
    const effort = spec.effort || model.default_effort, sampling = samplingFor(model, effort);
    const startRoom = String(spec.start_room || 'HxI');
    if (!/^[A-P]x[A-P]$/.test(startRoom)) throw new Error('Invalid starting room.');
    const actionLimit = spec.action_limit === null || String(spec.action_limit).toLowerCase() === 'unlimited'
      ? null : Math.max(1, Math.min(1000000, Math.floor(Number(spec.action_limit) || 100)));
    return { model, effort, sampling, startRoom, actionLimit };
  }
  async launch(spec = {}) {
    if (!isDirectSpec(spec)) return super.launch(spec);
    const options = await this.validateSpec(spec);
    await this.initialize();
    const id = 'run-' + now().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
    const directory = this.runDirectory(id), home = path.join(this.directStateRoot, id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const base = await readFile(path.join(this.projectRoot, 'benchmarking/v1/EVAL-PROMPT.md'), 'utf8');
    const prompt = directPrompt(base, options), context = options.model.context_window || 131072;
    const configuration = { storage_format: 'incremental-v1', world_updates: LIVE_WORLD_POLICY,
      world: 'main-world', observation_mode: 'ascii', provider: 'prime-agent', harness: POLICY, coding_mode: 'off', tools_enabled: false,
      model: options.model.id, effort: options.effort, sampling: options.sampling, context_window: context,
      compaction_threshold: Math.floor(Math.min(context * 0.75, context - options.sampling.max_tokens - context * 0.1)),
      parallel_tool_calls: options.model.parameters.includes('parallel_tool_calls') ? false : null,
      prime_direct_runtime: await runtimeHashes(this.projectRoot), service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt) };
    const metadata = { ...configuration, schema_version: 1, id, pair_id: null, created_at: now(), updated_at: now(), status: 'preparing',
      prompt_sha256: digest(base), continuation_count: 0, error: null, stopped_at: null, completed_at: null,
      isolation: { mode: 'direct-game-tools', code_execution: false, host_files: false, model_network: false },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, tools: TOOLS } };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, 'prompt.md'), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, 'run.json'), metadata);
    try {
      await BenchmarkGameRuntime.create(this.projectRoot, directory, { startRoom: options.startRoom, incremental: true, actionLimit: options.actionLimit });
      await verifyIntegrity(this.projectRoot, directory, metadata);
      metadata.status = 'queued'; await atomicJson(path.join(directory, 'run.json'), metadata);
      this.startDirect(id, directory, home);
    } catch (error) {
      Object.assign(metadata, { status: 'failed', error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, 'run.json'), metadata); throw error;
    }
    return this.get(id);
  }
  startDirect(id, directory, home) {
    const control = { stopRequested: false, pauseRequested: false }, file = path.join(directory, 'run.json');
    this.active.set(id, control);
    let writing = Promise.resolve();
    const update = values => {
      writing = writing.then(async () => { const metadata = await readJson(file); Object.assign(metadata, values, { updated_at: now() }); await atomicJson(file, metadata); });
      return writing;
    };
    control.update = update;
    control.done = (async () => {
      await update({ status: 'running', error: null });
      const status = await runDirect({ root: this.projectRoot, directory, home, control,
        onUsage: usage => update({ usage }) });
      await update({ status, ...(status === 'completed' ? { completed_at: now() } : status === 'stopped' ? { stopped_at: now() } : {}) });
    })().catch(async error => {
      await update(control.stopRequested ? { status: 'stopped', stopped_at: now() } : { status: 'failed', error: error.message, completed_at: now() });
    }).finally(() => this.active.delete(id));
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    return isDirect(metadata) ? verifyIntegrity(this.projectRoot, directory, metadata) : super.verifyRunCapabilityBoundary(metadata, directory);
  }
  async get(id, options) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    if (!isDirect(metadata)) return super.get(id, options);
    const run = await BaseSupervisor.prototype.get.call(this, id, options);
    run.capability_boundary_verified = metadata.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), 'integrity-violation.json'));
    run.compaction_recoverable = false;
    return run;
  }
  async pause(id) {
    const file = path.join(this.runDirectory(id), 'run.json'), metadata = await readJson(file);
    if (!isDirect(metadata)) return super.pause(id);
    const control = this.active.get(id);
    if (!control || control.stopRequested) throw new Error('Only an active run can be paused.');
    control.pauseRequested = true;
    // Stop at the next response/tool boundary, preserving all billed responses.
    await control.update({ status: 'pausing' });
    return this.get(id);
  }
  async stop(id) {
    const file = path.join(this.runDirectory(id), 'run.json'), metadata = await readJson(file);
    if (!isDirect(metadata)) return super.stop(id);
    const control = this.active.get(id);
    if (control) { control.stopRequested = true; control.abort?.abort(); await control.done; }
    else { Object.assign(metadata, { status: 'stopped', stopped_at: now(), updated_at: now() }); await atomicJson(file, metadata); }
    return this.get(id);
  }
  async resume(id) {
    const directory = this.runDirectory(id), file = path.join(directory, 'run.json'), metadata = await readJson(file);
    if (!isDirect(metadata)) return super.resume(id);
    if (this.active.has(id)) throw new Error('This run is already active; wait for it to finish pausing.');
    await verifyIntegrity(this.projectRoot, directory, metadata);
    const summary = await readJson(path.join(directory, 'summary.json'));
    if (['won', 'action-limit'].includes(summary.game_status)) throw new Error('This game has finished.');
    const home = path.join(this.directStateRoot, id);
    const conversation = await readJson(path.join(home, 'conversation.json'));
    if (conversation.inflight_tool) throw new Error('An interrupted tool call needs reconciliation before resuming.');
    Object.assign(metadata, { status: 'queued', error: null, stopped_at: null, completed_at: null,
      continuation_count: (metadata.continuation_count || 0) + 1, updated_at: now() });
    await atomicJson(file, metadata); this.startDirect(id, directory, home);
    return this.get(id);
  }
  async delete(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    const result = await super.delete(id);
    if (isDirect(metadata)) await rm(path.join(this.directStateRoot, id), { recursive: true, force: true });
    return result;
  }
}
