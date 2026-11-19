// New runs follow the stable release channel. Versioned private installations
// are retained so an update can never replace an existing run's executable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import './codex-releases.mjs';
import { inspectCodex, codexBinaryDigest, VERIFIED_CODEX_VERSIONS, CODEX_RELEASE_URL } from './v1/codex-installation.mjs';
const execute = promisify(execFile);
export const codexInstallations = path.join(os.homedir(), '.mazebench/codex-releases');
const validations = ['scripts/check-benchmark-capabilities-v1.mjs', 'tests/benchmark-security.test.mjs', 'tests/benchmark-fast-launch.test.mjs', 'tests/vision-wire.test.mjs'];
let pending;
const admissions = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function currentCodexCommand() {
  try {
    const latest = JSON.parse(readFileSync(path.join(codexInstallations, 'latest.json'), 'utf8'));
    if (existsSync(latest.executable)) return latest.executable;
  } catch { /* Existing installations remain discoverable before first update. */ }
  return process.env.MAZEBENCH_CODEX_BIN || 'codex';
}

export function codexReleaseAsset(release, platform = process.platform, arch = process.arch) {
  const version = String(release.tag_name || '').replace(/^rust-v/, '');
  assert(/^\d+\.\d+\.\d+$/.test(version), 'Invalid stable Codex release.');
  const target = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl' }[`${platform}-${arch}`];
  assert(target, 'Unsupported Codex package platform.');
  const asset = release.assets?.find(item => item.name === `codex-package-${target}.tar.gz`);
  assert(asset && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'Missing authenticated Codex package.');
  assert.equal(asset.browser_download_url, `https://releases.openai.com/codex/releases/${version}/${asset.name}`);
  return { ...asset, version, target };
}

export function admitCodexInstallation(command) {
  const identity = file => { const s = statSync(file); return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':'); };
  const cached = admissions.get(command);
  if (cached && cached.identity === identity(command)) return cached.installed;
  const installed = inspectCodex(command), hash = codexBinaryDigest(installed.executable);
  if (!installed.tested) {
    const proof = JSON.parse(readFileSync(path.join(codexInstallations, hash + '.validated.json'), 'utf8'));
    assert.equal(proof.version, installed.version); assert.equal(proof.sha256, hash);
    assert.deepEqual(proof.checks, validations); assert.equal(proof.passed, true);
    VERIFIED_CODEX_VERSIONS.add(installed.version);
  }
  const result = { ...installed, tested: true, sha256: hash };
  admissions.set(installed.executable, { identity: identity(installed.executable), installed: result });
  return result;
}

export async function validateCodexInstallation(root, executable) {
  // A private runtime's node_modules link identifies the canonical test suite.
  const source = existsSync(path.join(root, validations[0])) ? root : path.dirname(realpathSync(path.join(root, 'node_modules')));
  const installed = inspectCodex(executable), hash = codexBinaryDigest(installed.executable);
  const files = await Promise.all(validations.map(async file => [file, sha(await readFile(path.join(source, file)))]));
  const proofFile = path.join(codexInstallations, hash + '.validated.json');
  try {
    const proof = JSON.parse(await readFile(proofFile, 'utf8'));
    if (proof.passed && proof.version === installed.version && proof.sha256 === hash && JSON.stringify(proof.sources) === JSON.stringify(files)) return admitCodexInstallation(executable);
  } catch { /* A new binary must pass the real offline suites. */ }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'maze-codex-admission-'));
  try {
    const preload = path.join(temporary, 'candidate.mjs');
    await writeFile(preload, `import { inspectCodex, codexBinaryDigest, VERIFIED_CODEX_VERSIONS } from ${JSON.stringify(pathToFileURL(path.join(source, 'benchmarking/v1/codex-installation.mjs')).href)};\nconst candidate=inspectCodex(process.env.MAZEBENCH_CODEX_BIN);\nif(candidate.version!==${JSON.stringify(installed.version)}||codexBinaryDigest(candidate.executable)!==${JSON.stringify(hash)})throw Error('Candidate changed');\nVERIFIED_CODEX_VERSIONS.add(candidate.version);\n`, { mode: 0o600 });
    const options = { cwd: source, env: { ...process.env, MAZEBENCH_CODEX_BIN: installed.executable }, timeout: 240000, maxBuffer: 4 * 1024 * 1024 };
    const wire = await execute(process.execPath, ['--import', preload, validations[0]], options);
    const tests = await execute(process.execPath, ['--import', preload, '--test', '--test-name-pattern', '^(?!real Claude Code)', ...validations.slice(1)], options);
    assert.equal(codexBinaryDigest(installed.executable), hash, 'Candidate changed during validation.');
    await mkdir(codexInstallations, { recursive: true, mode: 0o700 });
    await writeFile(path.join(codexInstallations, hash + '.validation.log'), wire.stdout + wire.stderr + tests.stdout + tests.stderr, { mode: 0o600 });
    await writeFile(proofFile, JSON.stringify({ passed: true, version: installed.version, sha256: hash, checks: validations, sources: files, at: new Date().toISOString() }), { mode: 0o600 });
    return admitCodexInstallation(executable);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function ensureLatestCodex(root) {
  if (pending) return pending;
  pending = (async () => {
    const response = await fetch(CODEX_RELEASE_URL, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error(`Cannot check the latest Codex release (HTTP ${response.status}).`);
    const asset = codexReleaseAsset(await response.json());
    const directory = path.join(codexInstallations, `${asset.version}-${asset.target}`), executable = path.join(directory, 'bin/codex');
    if (!existsSync(executable)) {
      await mkdir(codexInstallations, { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(path.join(codexInstallations, '.install-'));
      try {
        const archive = path.join(temporary, 'package.tar.gz'), unpacked = path.join(temporary, 'package');
        const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(600000), redirect: 'error' });
        if (!download.ok) throw new Error(`Codex download failed (HTTP ${download.status}).`);
        await pipeline(download.body, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        const hash = createHash('sha256'); for await (const bytes of createReadStream(archive)) hash.update(bytes);
        assert.equal('sha256:' + hash.digest('hex'), asset.digest, 'Codex package checksum mismatch.');
        await mkdir(unpacked);
        await execute('tar', ['-xzf', archive, '-C', unpacked], { timeout: 60000 });
        assert.equal(inspectCodex(path.join(unpacked, 'bin/codex')).version, 'codex-cli ' + asset.version);
        await rename(unpacked, directory);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    assert.equal(inspectCodex(executable).version, 'codex-cli ' + asset.version);
    const installed = await validateCodexInstallation(root, executable);
    const pointer = path.join(codexInstallations, `latest.${process.pid}.json`);
    await writeFile(pointer, JSON.stringify(installed), { mode: 0o600 });
    await rename(pointer, path.join(codexInstallations, 'latest.json'));
    return installed;
  })();
  try { return await pending; } finally { pending = null; }
}

// Keep a slow package download from outliving the HTTP launch request and
// unexpectedly starting a paid run after the browser has reported a timeout.
export async function latestCodexForLaunch(root) {
  let timer;
  try {
    return await Promise.race([ensureLatestCodex(root), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The latest Codex is still being installed and verified. No run was started; try Launch run again shortly.')), 20000);
    })]);
  } finally { clearTimeout(timer); }
}
