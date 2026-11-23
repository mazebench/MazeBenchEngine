import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ProviderVisionSupervisor } from './vision-providers/supervisor.mjs';
import { POLICY, providerVisionHashes, verifyProviderVisionIntegrity } from './vision-providers/policy.mjs';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from './v1/integrity.mjs';
import { readCheckpointJson } from './v1/checkpoint-json.mjs';
import { atomicJson } from './providers/claude-runner.mjs';
import { readJsonLinesTail } from './storage/tail-jsonl.mjs';
import { digest, grokConfigIsImmutable, grokModelsPolicyDigest, grokSettingsPolicyDigest, VERIFIED_GROK_VERSIONS, verifyStoredGrokToolCatalog } from './grok/policy.mjs';
import { createGrokBoundaryValidator } from './grok-vision-resume-policy.mjs';
import { runGrokTurn } from './grok-vision-resume-runner.mjs';

export const GROK_RESUME_POLICY = 'grok-vision-resume-catalog-v1';
export const GROK_CATALOG_ERROR = 'Unexpected Grok tool catalog: mazebench__maze_action, mazebench__maze_observe, mazebench__maze_sequence, search_tool, use_tool.';
const files = ['benchmarking/grok-vision-resume-policy.mjs', 'benchmarking/grok-vision-resume-runner.mjs', 'benchmarking/grok-vision-resume.mjs'];
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hashes = async root => Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(root, file)))])));

// Validate the full original contract even while the known init-only marker is
// present. No frozen source, prompt, conversation or game journal is edited.
async function verifyPreserved(root, directory, metadata) {
  const manifest = await verifyRunIntegrity(root, directory, metadata.integrity), f = manifest.configuration;
  assertRunConfiguration(metadata, manifest);
  assert.equal(metadata.provider, 'grok-build'); assert.equal(f.provider, 'grok-build');
  for (const [key, value] of Object.entries({ observation_mode: 'vision', world: 'main-world', tools_enabled: false, coding_mode: 'off' })) {
    assert.equal(metadata[key], value); assert.equal(f[key], value);
  }
  assert.equal(f.vision_provider_policy, POLICY); assert.deepEqual(metadata.capability_policy, f.capability_policy);
  assert.deepEqual(await providerVisionHashes(root), f.vision_provider_runtime);
  assert(VERIFIED_GROK_VERSIONS.has(f.grok_version));
  assert.equal(digest(await readFile(f.grok_executable)), f.grok_sha256);
  for (const [file, hash] of Object.entries(f.immutable_config)) { assert(grokConfigIsImmutable(file)); assert.equal(digest(await readFile(file)), hash); }
  assert.equal(grokModelsPolicyDigest(await readFile(path.join(f.grok_home, 'models_cache.json'))), f.grok_models_policy_sha256);
  assert.equal(grokSettingsPolicyDigest(await readFile(path.join(f.grok_home, 'settings_cache.json'))), f.grok_settings_policy_sha256);
  assert.equal(digest(await readFile(path.join(directory, 'prompt.md'))), f.effective_prompt_sha256);
  verifyStoredGrokToolCatalog(f.grok_home, path.join(directory, 'agent-cwd'), metadata.grok_session_id);
  verifyCheckpoint(directory); return manifest;
}

export async function adoptGrokVisionResume({ root, directory, assertInactive }) {
  const repairs = path.join(directory, 'repairs'); await mkdir(repairs, { recursive: true });
  const lockPath = path.join(repairs, '.grok-resume.lock'), lock = await open(lockPath, 'wx', 0o600);
  try {
    const originalRun = await readFile(path.join(directory, 'run.json')), metadata = JSON.parse(originalRun);
    assert(['failed', 'paused', 'stopped'].includes(metadata.status)); await assertInactive(metadata);
    const originalManifest = await readFile(path.join(directory, 'integrity.json'));
    const checkpoint = await readFile(path.join(directory, 'checkpoint.json'));
    const marker = await readFile(path.join(directory, 'integrity-violation.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const manifest = await verifyPreserved(root, directory, metadata);
    if (marker) {
      const violation = JSON.parse(marker); assert.equal(violation.error, GROK_CATALOG_ERROR); assert.equal(metadata.error, GROK_CATALOG_ERROR);
      const event = (await readJsonLinesTail(path.join(directory, 'grok-events.jsonl'), 1))[0];
      assert.equal(event?.type, 'system'); assert.equal(event.subtype, 'init'); assert.equal(event._received_at, violation.at);
      const validate = createGrokBoundaryValidator({ model: metadata.model, toolsEnabled: false, cwd: path.join(directory, 'agent-cwd'), resuming: true });
      assert.equal(validate(event), null, 'The blocked init changed more than the allowed maze catalog.');
    }
    const currentHashes = await hashes(root);
    if (manifest.configuration.grok_resume_compatibility) {
      assert.deepEqual(manifest.configuration.grok_resume_compatibility, { policy: GROK_RESUME_POLICY, files: currentHashes });
      if (!marker) return;
    }
    const summary = await readCheckpointJson(directory, 'summary.json'); assert(!['won', 'action-limit'].includes(summary.game_status));
    const unchanged = async () => {
      await assertInactive(metadata);
      const processes = execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' });
      assert(!processes.split('\n').some(line => line.includes(path.join(directory, 'agent-cwd'))), 'A previous agent is still alive.');
      assert((await readFile(path.join(directory, 'run.json'))).equals(originalRun));
      assert((await readFile(path.join(directory, 'integrity.json'))).equals(originalManifest));
      assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint));
    };
    await unchanged();
    const at = new Date().toISOString(), backup = path.join(repairs, 'grok-resume-' + at.replace(/[:.]/g, '-'));
    await mkdir(backup, { mode: 0o700 });
    await writeFile(path.join(backup, 'run.before.json'), originalRun, { mode: 0o600 });
    await writeFile(path.join(backup, 'integrity.before.json'), originalManifest, { mode: 0o600 });
    if (marker) await writeFile(path.join(backup, 'invalidation.before.json'), marker, { mode: 0o600 });
    manifest.configuration.grok_resume_compatibility = { policy: GROK_RESUME_POLICY, files: currentHashes };
    const encoded = JSON.stringify(manifest, null, 2) + '\n';
    const audit = { policy: GROK_RESUME_POLICY, at, action_count: summary.action_count, session_id: metadata.grok_session_id,
      checkpoint_sha256: digest(checkpoint), original_manifest_sha256: digest(originalManifest), updated_manifest_sha256: digest(encoded),
      added_files: currentHashes, cleared_error: marker ? GROK_CATALOG_ERROR : null, backup,
      reason: 'Operator-requested automatic resume: accept only the existing three maze MCP catalog keys in Grok init; retain gateway-only invocation checks and all original runtime hashes.' };
    const updated = { ...metadata, status: 'paused', error: null, paused_at: at, integrity: { ...metadata.integrity, manifest_sha256: digest(encoded), asset_count: Object.keys(manifest.files).length },
      grok_resume_owner: GROK_RESUME_POLICY, runtime_repairs: [...(metadata.runtime_repairs || []), audit] };
    await unchanged();
    try {
      await atomicJson(path.join(directory, 'integrity.json'), manifest);
      await atomicJson(path.join(directory, 'run.json'), updated);
      await verifyPreserved(root, directory, updated);
      assert((await readFile(path.join(directory, 'checkpoint.json'))).equals(checkpoint));
      await atomicJson(path.join(backup, 'audit.json'), { ...audit, phase: 'applied' });
      if (marker) await rename(path.join(directory, 'integrity-violation.json'), path.join(backup, 'cleared-invalidation.json'));
      await verifyProviderVisionIntegrity(root, directory, updated);
    } catch (error) {
      await writeFile(path.join(directory, 'integrity.json'), originalManifest);
      await writeFile(path.join(directory, 'run.json'), originalRun);
      if (marker) await writeFile(path.join(directory, 'integrity-violation.json'), marker, { mode: 0o600 });
      await atomicJson(path.join(backup, 'audit.json'), { ...audit, phase: 'rolled-back', error: error.message }); throw error;
    }
  } finally { await lock.close(); await rm(lockPath); }
}

export class GrokVisionResumeSupervisor extends ProviderVisionSupervisor {
  async verifyRunCapabilityBoundary(metadata, directory) {
    const frozen = await super.verifyRunCapabilityBoundary(metadata, directory);
    assert.equal(metadata.provider, 'grok-build'); assert.equal(metadata.grok_resume_owner, GROK_RESUME_POLICY);
    assert.deepEqual(frozen.grok_resume_compatibility, { policy: GROK_RESUME_POLICY, files: await hashes(this.projectRoot) });
    return frozen;
  }
  async loop(directory, prompt, control) {
    const file = path.join(directory, 'run.json');
    while (!control.stopRequested && !control.pauseRequested) {
      let m = await json(file); const frozen = await this.verifyRunCapabilityBoundary(m, directory);
      m.status = 'continuing'; m.updated_at = new Date().toISOString(); await atomicJson(file, m);
      const before = (await readCheckpointJson(directory, 'summary.json')).action_count;
      const turn = await runGrokTurn({ directory, metadata: m, frozen, prompt, control, onSession: async session => {
        const latest = await json(file);
        latest.grok_session_lineage = [...(latest.grok_session_lineage || []), { parent: latest.grok_session_id, session, at: new Date().toISOString(), action_count: before }];
        latest.grok_session_id = session; await atomicJson(file, latest);
      } });
      m = await json(file); if (turn.boundaryError) throw new Error(turn.boundaryError);
      await this.verifyRunCapabilityBoundary(m, directory);
      if (control.stopRequested || control.pauseRequested) break;
      if (turn.code !== 0 || !turn.result || turn.result.is_error) throw new Error(turn.error || 'Vision agent turn failed.');
      const summary = await readCheckpointJson(directory, 'summary.json'); if (turn.usage) m.usage = turn.usage;
      if (['won', 'action-limit'].includes(summary.game_status)) { m.status = 'completed'; m.completed_at = new Date().toISOString(); await atomicJson(file, m); return; }
      m.continuation_count++; m.last_turn_actions = summary.action_count - before; await atomicJson(file, m);
      prompt = `Continue the same vision run at action ${summary.action_count}. Call maze_observe and inspect its image, then keep playing until won or action-limit. Coding tools remain off. Do not stop merely because a turn ended.`;
    }
    const m = await json(file), at = new Date().toISOString();
    Object.assign(m, { status: control.pauseRequested ? 'paused' : 'stopped', updated_at: at, [control.pauseRequested ? 'paused_at' : 'stopped_at']: at }); await atomicJson(file, m);
  }
}
