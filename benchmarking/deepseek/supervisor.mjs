import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BenchmarkSupervisor as PreviousSupervisor, buildBenchmarkPrompt } from '../v1/supervisor.mjs';
import { BenchmarkGameRuntime } from '../v1/runtime.mjs';
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from '../v1/integrity.mjs';
import { LIVE_WORLD_POLICY } from '../storage/live-world.mjs';
import { atomicJson, readJson } from '../providers/claude-runner.mjs';
import { codingMode } from '../coding-mode.mjs';
import { PROVIDER, POLICY, VERSION, runtimeHome, authHome, profileFiles, installationInfo, runtimeHashes, verifyIntegrity, digest } from './policy.mjs';
import { installationStatus, modelCatalog } from './status.mjs';
import { runDeepSeekTurn } from './runner.mjs';

const now = () => new Date().toISOString();
const terminal = summary => ['won', 'action-limit'].includes(summary.game_status);
const continuation = summary => `Continue the same MazeBench run at ${summary.action_count} accepted actions. Call maze_observe, then continue playing until won, action-limit, or the operator pauses/stops the run.`;

export class DeepSeekSupervisor extends PreviousSupervisor {
  constructor(root, options = {}) {
    super(root, options);
    this.installation = options.deepseekInstallation || runtimeHome();
    this.credentialHome = options.deepseekAuthHome || authHome();
    this.stateRoot = options.deepseekStateRoot || path.join(os.homedir(), '.mazebench/deepseek-runs');
    this.catalog = options.catalog;
    this.runTurn = options.deepseekRunTurn || runDeepSeekTurn;
    this.statusCache = null;
  }
  async inspectDeepSeek({ force = false } = {}) {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 60000) return this.statusCache.value;
    const value = await installationStatus({ installation: this.installation, credentialHome: this.credentialHome });
    this.statusCache = { at: Date.now(), value }; return value;
  }
  async validateSpec(spec = {}) {
    if (spec.provider !== PROVIDER) return super.validateSpec(spec);
    if ((spec.world || 'main-world') !== 'main-world' || (spec.observation_mode || 'ascii') !== 'ascii') throw new Error('DeepSeek Harness supports Main World ASCII.');
    const mode = codingMode(spec);
    if (!['off', 'python'].includes(mode)) throw new Error('DeepSeek Harness supports Coding off or Python only.');
    if (spec.service_tier && spec.service_tier !== 'standard') throw new Error('DeepSeek Harness supports Standard speed.');
    const selected = this.catalog ? await this.catalog.selection(spec, { force: true })
      : (await modelCatalog({ root: this.projectRoot, installation: this.installation, credentialHome: this.credentialHome })).find(model => model.id === spec.model);
    if (!selected || !selected.efforts.includes(spec.effort || selected.default_effort)) throw new Error('DeepSeek model or reasoning effort is unavailable.');
    return { provider: PROVIDER, world: 'main-world', observationMode: 'ascii', model: selected.id,
      effort: spec.effort || selected.default_effort, route: selected.deepseek_route,
      connection: selected.connection, modelProfile: selected.model_profile, connectionId: selected.connection_id,
      toolsEnabled: mode === 'python', serviceTier: null, startRoom: String(spec.start_room || 'HxI'),
      actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === 'unlimited' ? null
        : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))),
      pairId: spec.pair_id ? String(spec.pair_id).slice(0, 100) : null };
  }
  async launch(spec) {
    if (spec.provider !== PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec);
    const readiness = await this.inspectDeepSeek({ force: true });
    if (!readiness.launch_ready) throw new Error(readiness.error);
    if (['anthropic', 'openai'].includes(options.route) && !readiness.verified_routes?.includes(options.route)) throw new Error('Run npm run check:deepseek to verify the new provider transport before launching.');
    if (options.connection && !readiness.verified_protocols?.includes(options.connection.api)) throw new Error('Run npm run check:deepseek to verify connected provider protocols.');
    const installation = installationInfo(this.installation);
    await this.initialize();
    const id = 'run-' + now().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
    const directory = this.runDirectory(id), home = path.join(this.stateRoot, id);
    await mkdir(path.join(directory, 'agent-cwd'), { recursive: true, mode: 0o700 });
    const files = profileFiles({ root: this.projectRoot, directory, home, installation: this.installation,
      credentialHome: this.credentialHome, ...options });
    const config = {};
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, name)), { recursive: true, mode: 0o700 });
      await writeFile(path.join(home, name), contents, { mode: name.endsWith('/cordis.yml') ? 0o600 : 0o400, flag: 'wx' }); config[name] = digest(contents);
    }
    const base = await readFile(path.join(this.projectRoot, 'benchmarking/v1/EVAL-PROMPT.md'), 'utf8');
    const prompt = buildBenchmarkPrompt(base, options), createdAt = now();
    const configuration = { storage_format: 'incremental-v1', world_updates: LIVE_WORLD_POLICY, world: 'main-world', observation_mode: 'ascii',
      provider: PROVIDER, deepseek_policy: POLICY, deepseek_version: VERSION, deepseek_installation: this.installation,
      deepseek_executable: installation.executable, deepseek_sha256: installation.sha256, deepseek_runtime: await runtimeHashes(this.projectRoot),
      deepseek_home: home, deepseek_auth_home: this.credentialHome, deepseek_config: config, deepseek_route: options.route,
      model_connection: options.connection, model_profile: options.modelProfile, connection_id: options.connectionId,
      billing_source: options.connection?.auth === 'chatgpt' ? 'chatgpt-plan' : options.connectionId || 'deepseek',
      model: options.model, effort: options.effort, tools_enabled: options.toolsEnabled, service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt) };
    const metadata = { schema_version: 1, id, storage_format: 'incremental-v1', world_updates: LIVE_WORLD_POLICY,
      world: 'main-world', observation_mode: 'ascii', provider: PROVIDER, model: options.model, effort: options.effort,
      pair_id: options.pairId, tools_enabled: options.toolsEnabled, coding_mode: options.toolsEnabled ? 'python' : 'off', service_tier: null,
      deepseek_route: options.route, billing_source: configuration.billing_source, connection_id: options.connectionId,
      action_limit: options.actionLimit, start_room: options.startRoom, created_at: createdAt, updated_at: createdAt, status: 'preparing',
      prompt_sha256: digest(base), effective_prompt_sha256: digest(prompt), deepseek_session_id: null, continuation_count: 0,
      error: null, completed_at: null, stopped_at: null, isolation: { mode: 'maze-tools-only' },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, deepseek_version: VERSION,
        tools: options.toolsEnabled ? 'maze-and-isolated-python' : 'maze-only' } };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, 'prompt.md'), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, 'run.json'), metadata);
    try {
      await BenchmarkGameRuntime.create(this.projectRoot, directory, { startRoom: options.startRoom, incremental: true, actionLimit: options.actionLimit });
      if (options.toolsEnabled) metadata.isolation = this.pythonPreflight(directory);
      await this.verifyRunCapabilityBoundary(metadata, directory);
      Object.assign(metadata, { status: 'queued', updated_at: now() });
      await atomicJson(path.join(directory, 'run.json'), metadata);
      this.startDeepSeek(id, directory, prompt);
    } catch (error) {
      Object.assign(metadata, { status: 'failed', error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, 'run.json'), metadata); throw error;
    }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    if (metadata.provider !== PROVIDER) return super.verifyRunCapabilityBoundary(metadata, directory);
    const frozen = await verifyIntegrity(this.projectRoot, directory, metadata);
    if (metadata.tools_enabled) this.pythonPreflight(directory);
    return frozen;
  }
  startDeepSeek(id, directory, prompt) {
    const control = { child: null, pauseRequested: false, stopRequested: false };
    this.active.set(id, control);
    this.loop(directory, prompt, control).catch(async error => {
      const metadata = await readJson(path.join(directory, 'run.json'));
      Object.assign(metadata, { status: 'failed', error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, 'run.json'), metadata);
    }).finally(() => this.active.delete(id));
  }
  async loop(directory, prompt, control) {
    const file = path.join(directory, 'run.json');
    while (!control.stopRequested && !control.pauseRequested) {
      let metadata = await readJson(file);
      const frozen = await this.verifyRunCapabilityBoundary(metadata, directory);
      if (control.stopRequested || control.pauseRequested) break;
      Object.assign(metadata, { status: metadata.deepseek_session_id ? 'continuing' : 'running', updated_at: now() });
      await atomicJson(file, metadata);
      const before = await readJson(path.join(directory, 'summary.json'));
      if (control.stopRequested || control.pauseRequested) break;
      const turn = await this.runTurn({ directory, metadata, frozen, prompt, control, onSession: async session => {
        const current = await readJson(file); current.deepseek_session_id = session; current.updated_at = now(); await atomicJson(file, current);
      } });
      if (turn.boundaryError) throw new Error(turn.boundaryError);
      metadata = await readJson(file);
      await verifyIntegrity(this.projectRoot, directory, metadata);
      if (control.stopRequested || control.pauseRequested) break;
      if (!turn.success) throw new Error(turn.error);
      const summary = await readJson(path.join(directory, 'summary.json'));
      if (terminal(summary)) {
        Object.assign(metadata, { status: 'completed', completed_at: now(), updated_at: now() }); await atomicJson(file, metadata); return;
      }
      if (!metadata.deepseek_session_id) throw new Error('DeepSeek Harness has no resumable session.');
      metadata.continuation_count++; metadata.last_turn_actions = summary.action_count - before.action_count;
      await atomicJson(file, metadata); prompt = continuation(summary);
    }
    const metadata = await readJson(file), status = control.pauseRequested ? 'paused' : 'stopped';
    Object.assign(metadata, { status, [status === 'paused' ? 'paused_at' : 'stopped_at']: now(), updated_at: now() });
    await atomicJson(file, metadata);
  }
  async resume(id) {
    const directory = this.runDirectory(id), file = path.join(directory, 'run.json'), metadata = await readJson(file);
    if (metadata.provider !== PROVIDER) return super.resume(id);
    if (this.active.has(id)) throw new Error('This benchmark is already running.');
    if (!['paused', 'stopped', 'failed'].includes(metadata.status)) throw new Error('This benchmark cannot be resumed.');
    await this.verifyRunCapabilityBoundary(metadata, directory);
    if (!metadata.deepseek_session_id) throw new Error('DeepSeek Harness has no resumable session.');
    const summary = await readJson(path.join(directory, 'summary.json'));
    if (terminal(summary)) throw new Error('The benchmark has reached its terminal game state.');
    Object.assign(metadata, { status: 'queued', error: null, paused_at: null, stopped_at: null, completed_at: null, resumed_at: now(), updated_at: now() });
    await atomicJson(file, metadata); this.startDeepSeek(id, directory, continuation(summary)); return this.get(id);
  }
  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === POLICY && run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), 'integrity-violation.json'));
      run.compaction_recoverable = run.status === 'failed' && run.capability_boundary_verified && Boolean(run.deepseek_session_id);
    }
    return run;
  }
  async listInterviews(id) {
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: 'DeepSeek Harness interviews are unavailable.' };
  }
  async createInterview() { throw new Error('DeepSeek Harness interviews are unavailable.'); }
  async delete(id) {
    const result = await super.delete(id);
    await rm(path.join(this.stateRoot, id), { recursive: true, force: true }); return result;
  }
}
