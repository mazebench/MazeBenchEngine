import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// A newer release is displayed immediately, but must pass the capability and
// adversarial suites before it is admitted here. Never auto-approve a version.
export const VERIFIED_CODEX_VERSIONS = new Set(["codex-cli 0.153.3", "codex-cli 0.155.0", "codex-cli 0.158.0"]);
export const CODEX_RELEASE_URL = "https://releases.openai.com/codex/channels/latest";
const CACHE_MS = 15 * 60_000;
let releaseCache = null;
let releaseRequest = null;

export function inspectCodex(command = "codex") {
  let executable = command;
  if (!command.includes(path.sep)) {
    const found = spawnSync("which", [command], { encoding: "utf8", timeout: 5000 });
    if (found.status !== 0) throw new Error("Codex CLI is not installed or is missing from PATH.");
    executable = found.stdout.trim().split(/\r?\n/)[0];
  }
  const resolved = realpathSync(executable);
  const result = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000 });
  const version = String(result.stdout || "").trim();
  if (result.status !== 0 || !/^codex-cli \d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new Error("Cannot determine the installed Codex CLI version.");
  }
  return { executable: resolved, version, tested: VERIFIED_CODEX_VERSIONS.has(version) };
}

export function codexBinaryDigest(executable) {
  return createHash("sha256").update(readFileSync(executable)).digest("hex");
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export async function checkLatestCodex({ force = false, fetchRelease = fetch } = {}) {
  if (!force && releaseCache && Date.now() - releaseCache.cached_at < CACHE_MS) return releaseCache;
  if (releaseRequest) return releaseRequest;
  releaseRequest = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetchRelease(CODEX_RELEASE_URL, { signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error(`Release service returned HTTP ${response.status}.`);
      const release = await response.json();
      const version = String(release.tag_name || "").replace(/^rust-v/, "");
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release service returned an invalid stable version.");
      return { latest_version: version, checked_at: checkedAt, error: null, source: CODEX_RELEASE_URL };
    } catch (error) {
      // An offline check must never be presented as 'up to date'.
      return { latest_version: null, checked_at: checkedAt, error: String(error.message), source: CODEX_RELEASE_URL };
    }
  })();
  try {
    releaseCache = { ...await releaseRequest, cached_at: Date.now() };
    return releaseCache;
  } finally { releaseRequest = null; }
}

export async function codexInstallationStatus(command = "codex", options = {}) {
  let installed;
  try { installed = inspectCodex(command); }
  catch (error) { return { available: false, tested: false, update_status: "unknown", error: error.message }; }
  const release = await checkLatestCodex(options);
  const current = installed.version.replace(/^codex-cli /, "");
  const comparison = release.latest_version ? compareVersions(current, release.latest_version) : null;
  return {
    available: true, ...installed, ...release,
    update_status: comparison === null ? "unknown" : comparison < 0 ? "update-available" : comparison === 0 ? "up-to-date" : "newer-than-release",
    update_command: "codex update"
  };
}
