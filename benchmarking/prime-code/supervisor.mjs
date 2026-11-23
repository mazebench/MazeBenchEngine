import { prepareCode, codePreflight, primePrompt } from "../all-code/policy.mjs";
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { BenchmarkSupervisor as PreviousSupervisor } from '../muse-code/supervisor.mjs';
import { BenchmarkGameRuntime } from '../v1/runtime.mjs';
import { createRunIntegrity, CAPABILITY_POLICY_VERSION } from '../v1/integrity.mjs';
import { LIVE_WORLD_POLICY } from '../storage/live-world.mjs';
import { atomicJson, readJson } from '../providers/claude-runner.mjs';
import { PROVIDER, POLICY, VERSION, TOOLS, digest, pythonPath, stateRoot, runtimeHashes, verifyIntegrity } from './policy.mjs';
import { primeInstallationStatus } from './status.mjs';
import { runPrime } from './runner.mjs';

const now = () => new Date().toISOString();
const terminal = summary => ['won', 'action-limit'].includes(summary.game_status);

export class BenchmarkSupervisor extends PreviousSupervisor {
  constructor(root, options = {}) {
    super(root, options);
    this.primePython = options.primePython || pythonPath();
    this.primeStateRoot = options.primeStateRoot || stateRoot();
    this.primeStatus = options.primeStatus || (() => primeInstallationStatus(this.projectRoot, this.primePython));
    this.primeInventory = null;
  }
  async inspectPrime({ force = false } = {}) {
    if (force || !this.primeInventory || Date.now() - this.primeInventory.at > 60000)
      this.primeInventory = { at: Date.now(), value: this.primeStatus() };
    return this.primeInventory.value;
  }
  async providers(options = {}) {
    const [providers, prime] = await Promise.all([super.providers(options), this.inspectPrime(options)]);
    return { ...providers, [PROVIDER]: prime };
  }
  async models() {
    const [catalog, prime] = await Promise.all([super.models(), this.inspectPrime()]);
    return { ...catalog, models: [...catalog.models, ...prime.models] };
  }
  async validateSpec(spec = {}) {
    if (spec.provider !== PROVIDER) return super.validateSpec(spec);
    if (spec.coding_mode !== "any") throw new Error("This runner requires Any language.");
    if (spec.world && spec.world !== 'main-world') throw new Error('Prime Agent currently supports Main World only.');
    if (spec.observation_mode && spec.observation_mode !== 'ascii') throw new Error('Prime Agent currently supports ASCII observations only.');
    if (spec.tools_enabled === false || spec.pair_id) throw new Error('Prime Agent uses its native Python workspace. Tools-off and matched pairs are unavailable.');
    if (spec.effort && spec.effort !== 'default') throw new Error('Prime uses the model’s default reasoning configuration.');
    if (spec.service_tier && spec.service_tier !== 'standard') throw new Error('Prime does not support this service tier.');
    const status = await this.inspectPrime();
    const model = spec.model || 'openai/gpt-4.1-mini';
    if (!status.models.some(entry => entry.id === model)) throw new Error('This model is not in the Prime Inference catalog.');
    const startRoom = String(spec.start_room || 'HxI');
    if (!/^[A-P]x[A-P]$/.test(startRoom)) throw new Error('Invalid starting room.');
    return { model, startRoom, actionLimit: spec.action_limit === null || String(spec.action_limit).toLowerCase() === 'unlimited'
      ? null : Math.max(1, Math.min(1_000_000, Math.floor(Number(spec.action_limit) || 100))) };
  }
  async launchPair(spec = {}) {
    if (spec.provider === PROVIDER) throw new Error('Prime Agent has no tools-off condition; start a single run.');
    return super.launchPair(spec);
  }
  async launch(spec = {}) {
    if (spec.provider !== PROVIDER) return super.launch(spec);
    const options = await this.validateSpec(spec), status = await this.inspectPrime({ force: true });
    if (!status.launch_ready || !status.models.some(entry => entry.id === options.model)) throw new Error(status.error || 'Prime is not ready.');
    await this.initialize();
    const id = 'run-' + now().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
    const directory = this.runDirectory(id), home = path.join(this.primeStateRoot, id);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const code = await prepareCode(this.projectRoot, directory);
    const base = await readFile(path.join(this.projectRoot, 'benchmarking/v1/EVAL-PROMPT.md'), 'utf8');
    const prompt = primePrompt(base, options);
    const createdAt = now();
    const configuration = { ...code, storage_format: 'incremental-v1', world_updates: LIVE_WORLD_POLICY,
      world: 'main-world', observation_mode: 'ascii', provider: PROVIDER, prime_policy: POLICY, prime_version: VERSION,
      prime_runtime: await runtimeHashes(this.projectRoot), prime_fingerprint: status.fingerprint,
      model: options.model, effort: 'default', tools_enabled: true, service_tier: null,
      action_limit: options.actionLimit, start_room: options.startRoom, effective_prompt_sha256: digest(prompt) };
    const metadata = { ...code, ...Object.fromEntries(['storage_format', 'world_updates', 'world', 'observation_mode', 'provider', 'model', 'effort', 'tools_enabled', 'service_tier', 'action_limit', 'start_room', 'effective_prompt_sha256'].map(k => [k, configuration[k]])),
      schema_version: 1, id, pair_id: null, created_at: createdAt, updated_at: createdAt, status: 'preparing',
      prompt_sha256: digest(base), prime_trace_id: null, continuation_count: 0, error: null, stopped_at: null, completed_at: null,
      isolation: { mode: 'prime-remote-vm', native_python: true, network: 'framework-only', host_mounts: false },
      capability_policy: { version: CAPABILITY_POLICY_VERSION, name: POLICY, prime_version: VERSION,
        transport_tools: TOOLS, tools: 'maze-and-prime-native-python' } };
    metadata.integrity = await createRunIntegrity(this.projectRoot, directory, configuration);
    await writeFile(path.join(directory, 'prompt.md'), prompt, { mode: 0o600 });
    await atomicJson(path.join(directory, 'run.json'), metadata);
    try {
      await BenchmarkGameRuntime.create(this.projectRoot, directory, { startRoom: options.startRoom, incremental: true, actionLimit: options.actionLimit });
      await atomicJson(path.join(home, 'control.json'), { paused: false });
      await atomicJson(path.join(home, 'runner.json'), { model: options.model, prompt, fingerprint: status.fingerprint,
        trace_file: path.join(home, 'trace.json'), game: { root: this.projectRoot, directory, node: process.execPath, control_file: path.join(home, 'control.json') } });
      metadata.isolation = { ...metadata.isolation, code: await codePreflight(directory, metadata.code_sandbox) };
      await atomicJson(path.join(directory, "run.json"), metadata);
      await this.verifyRunCapabilityBoundary(metadata, directory);
      metadata.status = 'queued'; await atomicJson(path.join(directory, 'run.json'), metadata);
      this.startPrime(id, directory, home);
    } catch (error) {
      Object.assign(metadata, { status: 'failed', error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(path.join(directory, 'run.json'), metadata); throw error;
    }
    return this.get(id);
  }
  async verifyRunCapabilityBoundary(metadata, directory) {
    return metadata.provider === PROVIDER ? verifyIntegrity(this.projectRoot, directory, metadata) : super.verifyRunCapabilityBoundary(metadata, directory);
  }
  startPrime(id, directory, home) {
    const control = { child: null, stopRequested: false, pauseRequested: false };
    this.active.set(id, control);
    const file = path.join(directory, 'run.json');
    control.done = (async () => {
      const result = await runPrime({ root: this.projectRoot, directory, home, python: this.primePython, control,
        onEvent: async event => {
          if (!['session', 'status', 'usage', 'continuation'].includes(event.type)) return;
          const metadata = await readJson(file);
          if (event.type === 'session') { metadata.prime_trace_id = event.id; metadata.status = control.pauseRequested ? 'pausing' : 'running'; }
          if (event.type === 'status') metadata.status = event.status === 'paused' && control.pauseRequested ? 'paused' : 'running';
          if (event.type === 'usage') metadata.usage = event.usage;
          if (event.type === 'continuation') metadata.continuation_count++;
          metadata.updated_at = now(); await atomicJson(file, metadata);
        } });
      const metadata = await readJson(file);
      await verifyIntegrity(this.projectRoot, directory, metadata);
      const summary = await readJson(path.join(directory, 'summary.json'));
      if (!control.stopRequested && (!result.complete || result.code !== 0 || !terminal(summary)))
        throw new Error(result.error || 'Prime Agent stopped before the game finished. Its native session is no longer available.');
      Object.assign(metadata, { status: control.stopRequested ? 'stopped' : 'completed', updated_at: now(),
        [control.stopRequested ? 'stopped_at' : 'completed_at']: now() });
      await atomicJson(file, metadata);
    })().catch(async error => {
      const metadata = await readJson(file);
      Object.assign(metadata, { status: 'failed', error: error.message, completed_at: now(), updated_at: now() });
      await atomicJson(file, metadata);
    }).finally(() => this.active.delete(id));
  }
  async pause(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    if (metadata.provider !== PROVIDER) return super.pause(id);
    const control = this.active.get(id);
    if (!control || control.stopRequested) throw new Error('Only a live Prime Agent session can be paused.');
    control.pauseRequested = true;
    const home = path.join(this.primeStateRoot, id);
    await rm(path.join(home, 'control.ack'), { force: true });
    await atomicJson(path.join(home, 'control.json'), { paused: true });
    metadata.status = 'pausing'; metadata.updated_at = now();
    await atomicJson(path.join(this.runDirectory(id), 'run.json'), metadata);
    return this.get(id);
  }
  async resume(id) {
    const directory = this.runDirectory(id), metadata = await readJson(path.join(directory, 'run.json'));
    if (metadata.provider !== PROVIDER) return super.resume(id);
    const control = this.active.get(id);
    if (!control?.pauseRequested || control.stopRequested) throw new Error('Prime can resume only a live paused session. Stopping or restarting the server ends its remote session.');
    await verifyIntegrity(this.projectRoot, directory, metadata);
    control.pauseRequested = false;
    await atomicJson(path.join(this.primeStateRoot, id, 'control.json'), { paused: false });
    metadata.status = 'running'; metadata.updated_at = now();
    await atomicJson(path.join(directory, 'run.json'), metadata);
    return this.get(id);
  }
  async get(id, options) {
    const run = await super.get(id, options);
    if (run.provider === PROVIDER) {
      run.capability_boundary_verified = run.capability_policy?.name === POLICY && run.capability_policy?.version === CAPABILITY_POLICY_VERSION &&
        run.integrity?.version === CAPABILITY_POLICY_VERSION && !existsSync(path.join(this.runDirectory(id), 'integrity-violation.json'));
      run.compaction_recoverable = false;
    }
    return run;
  }
  async listInterviews(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    if (metadata.provider !== PROVIDER) return super.listInterviews(id);
    return { schema_version: 2, run_id: id, available: false, chats: [], reason: 'Prime Agent interviews are unavailable.' };
  }
  async createInterview(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    if (metadata.provider === PROVIDER) throw new Error('Prime Agent interviews are unavailable.');
    return super.createInterview(id);
  }
  async delete(id) {
    const metadata = await readJson(path.join(this.runDirectory(id), 'run.json'));
    const result = await super.delete(id);
    if (metadata.provider === PROVIDER) await rm(path.join(this.primeStateRoot, id), { recursive: true, force: true });
    return result;
  }
}
