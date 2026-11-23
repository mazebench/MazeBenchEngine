// Operator-only migration for Grok 1.0.40 runs created without their signed
// account settings. It refreshes only Grok's signed model catalog, then freezes
// the resulting config, catalog, settings, and reviewed provider source hashes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  grokEnvironment,
  grokModelsPolicyDigest,
  grokRuntimeHashes,
  grokSettingsPolicyDigest,
  setGrokConfigImmutable,
  verifyGrokIntegrity
} from "../benchmarking/grok/policy.mjs";
import {
  assertRunConfiguration,
  verifyCheckpoint,
  verifyRunIntegrity
} from "../benchmarking/v1/integrity.mjs";
import { readJournal } from "../benchmarking/storage/journal.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value)}\n`;

async function atomic(file, value) {
  const temporary = `${file}.${process.pid}.grok-model-refresh-tmp`;
  await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}

export async function enableGrokModelRefresh({ projectRoot, directory, authHome = path.join(os.homedir(), ".grok") }) {
  const runFile = path.join(directory, "run.json");
  const manifestFile = path.join(directory, "integrity.json");
  const violationFile = path.join(directory, "integrity-violation.json");
  const originalRun = await readFile(runFile);
  const originalManifest = await readFile(manifestFile);
  const metadata = JSON.parse(originalRun);
  const manifest = JSON.parse(originalManifest);
  const frozen = manifest.configuration;

  assert.equal(metadata.provider, "grok-build");
  assert(["failed", "paused", "stopped"].includes(metadata.status), "The run must be inactive.");
  assert.equal(digest(originalManifest), metadata.integrity?.manifest_sha256);
  await verifyRunIntegrity(projectRoot, directory, metadata.integrity);
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(directory);

  const home = path.resolve(frozen.grok_home);
  const configFile = path.resolve(frozen.grok_config);
  const modelsFile = path.join(home, "models_cache.json");
  const settingsFile = path.join(home, "settings_cache.json");
  const originalConfig = await readFile(configFile);
  const originalModels = await readFile(modelsFile);
  const hadSettings = existsSync(settingsFile);
  const originalSettings = hadSettings ? await readFile(settingsFile) : null;
  assert.equal(configFile, path.join(home, "config.toml"));
  assert.equal(digest(originalConfig), frozen.grok_config_sha256);
  assert.equal(digest(originalModels), frozen.grok_models_sha256);

  const configText = originalConfig.toString("utf8");
  assert.equal((configText.match(/^remote_fetch = false$/gm) || []).length, 1, "The isolated config is not the expected pre-refresh policy.");
  const refreshedConfig = configText
    .replace(/^remote_fetch = false$/m, "remote_fetch = true")
    .replace("[skills]\npaths = []", `[skills]\npaths = []\nignore = [${JSON.stringify(path.join(home, "bundled", "skills"))}]`);
  const currentRuntime = await grokRuntimeHashes(projectRoot);
  const priorRuntime = frozen.grok_runtime || {};
  assert.deepEqual(Object.keys(currentRuntime), Object.keys(priorRuntime));
  const changed = Object.keys(currentRuntime).filter(file => currentRuntime[file] !== priorRuntime[file]).sort();
  assert(changed.length > 0 && changed.every(file => [
    "benchmarking/grok/policy.mjs",
    "benchmarking/grok/runner.mjs",
    "benchmarking/grok/supervisor.mjs"
  ].includes(file)), "Refusing to authorize unrelated Grok provider changes.");

  const at = new Date().toISOString();
  const backupDirectory = path.join(
    os.homedir(), ".mazebench", "operator-backups",
    `${metadata.id}-grok-model-refresh-${at.replace(/[:.]/g, "-")}`
  );
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    copyFile(runFile, path.join(backupDirectory, "run.json")),
    copyFile(manifestFile, path.join(backupDirectory, "integrity.json")),
    copyFile(configFile, path.join(backupDirectory, "config.toml")),
    copyFile(modelsFile, path.join(backupDirectory, "models_cache.json")),
    ...(hadSettings ? [copyFile(settingsFile, path.join(backupDirectory, "settings_cache.json"))] : []),
    ...(existsSync(violationFile) ? [copyFile(violationFile, path.join(backupDirectory, "integrity-violation.json"))] : [])
  ]);

  try {
    await atomic(configFile, refreshedConfig);
    await copyFile(path.join(authHome, "settings_cache.json"), settingsFile);
    await chmod(settingsFile, 0o600);
    const refresh = spawnSync(frozen.grok_executable, ["models"], {
      env: grokEnvironment(home), encoding: "utf8", timeout: 30_000
    });
    const output = `${refresh.stdout || ""}\n${refresh.stderr || ""}`;
    assert.equal(refresh.status, 0, `Grok model refresh failed: ${output.trim()}`);
    assert(/logged in with grok\.com/i.test(output), "The isolated Grok profile is not authenticated.");
    assert(/\bgrok-4\.7\b/.test(output), "Grok 4.7 is absent from the refreshed isolated model catalog.");
    // Grok auto-registers its marketplace during model discovery even when the
    // frozen config explicitly disables it. Restore the exact hardened config
    // and apply the macOS immutable flag before any agent process can start.
    await atomic(configFile, refreshedConfig);
    await chmod(configFile, 0o400);
    setGrokConfigImmutable(configFile);
    await Promise.all([modelsFile, settingsFile].map(file => chmod(file, 0o600)));

    const [models, settings, summary] = await Promise.all([
      readFile(modelsFile),
      readFile(settingsFile),
      readJournal(directory, "summary")
    ]);
    frozen.grok_config_sha256 = digest(refreshedConfig);
    frozen.grok_models_sha256 = digest(models);
    frozen.grok_models_policy_sha256 = grokModelsPolicyDigest(models);
    frozen.grok_settings_sha256 = digest(settings);
    frozen.grok_settings_policy_sha256 = grokSettingsPolicyDigest(settings);
    frozen.grok_runtime = currentRuntime;
    const encodedManifest = encode(manifest);
    metadata.integrity = {
      ...metadata.integrity,
      manifest_sha256: digest(encodedManifest),
      asset_count: Object.keys(manifest.files).length
    };
    metadata.runtime_repairs = [...(metadata.runtime_repairs || []), {
      kind: "grok-signed-model-refresh",
      at,
      action_count: summary.action_count,
      reason: "Copy and freeze the signed account settings and permit signed model-catalog refresh so the isolated Grok Build profile can resolve Grok 4.7. All agent tools remain restricted to the MazeBench MCP gateway."
    }];
    metadata.updated_at = at;

    await atomic(manifestFile, encodedManifest);
    await atomic(runFile, encode(metadata));
    await verifyGrokIntegrity(projectRoot, directory, metadata);
    return {
      id: metadata.id,
      action_count: summary.action_count,
      model: metadata.model,
      updated_files: changed,
      config_sha256: frozen.grok_config_sha256,
      models_sha256: frozen.grok_models_sha256,
      settings_sha256: frozen.grok_settings_sha256,
      backup: backupDirectory
    };
  } catch (error) {
    try { setGrokConfigImmutable(configFile, false); } catch {}
    await chmod(configFile, 0o600).catch(() => {});
    await atomic(configFile, originalConfig);
    await atomic(modelsFile, originalModels);
    if (hadSettings) await atomic(settingsFile, originalSettings);
    else await rm(settingsFile, { force: true });
    await atomic(manifestFile, originalManifest);
    await atomic(runFile, originalRun);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2];
  assert(/^run-[A-Za-z0-9-]+$/.test(id || ""), "Pass a valid run ID.");
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const directory = path.join(os.homedir(), "records", "mazebench-benchmark", id);
  console.log(JSON.stringify(await enableGrokModelRefresh({ projectRoot, directory }), null, 2));
}
