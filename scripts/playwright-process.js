const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const PLAYWRIGHT_PROFILE_PREFIX = "playwright_chromiumdev_profile-";

function processTable() {
  if (process.platform === "win32") return [];

  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 3000
    })
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      }));
  } catch (_error) {
    return [];
  }
}

function profileFromCommand(command) {
  const match = String(command || "").match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return String(match?.[1] || match?.[2] || match?.[3] || "");
}

function isPlaywrightBrowserCommand(command) {
  const text = String(command || "");
  return text.includes("--remote-debugging-pipe") && text.includes(PLAYWRIGHT_PROFILE_PREFIX);
}

function playwrightBrowserProcess(pid) {
  const wanted = Math.floor(Number(pid) || 0);
  if (wanted <= 1) return null;
  const entry = processTable().find((processInfo) => processInfo.pid === wanted);
  if (!entry || !isPlaywrightBrowserCommand(entry.command)) return null;
  return { ...entry, profile: profileFromCommand(entry.command) };
}

function findPlaywrightBrowserChildren(parentPid = process.pid) {
  const wanted = Math.floor(Number(parentPid) || 0);
  return processTable()
    .filter((entry) => entry.ppid === wanted && isPlaywrightBrowserCommand(entry.command))
    .map((entry) => ({ ...entry, profile: profileFromCommand(entry.command) }));
}

function cleanupPlaywrightProfile(processInfo) {
  const profile = String(processInfo?.profile || "");
  if (!profile) return false;

  const resolved = path.resolve(profile);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolved).startsWith(PLAYWRIGHT_PROFILE_PREFIX)
  ) {
    return false;
  }

  try {
    fs.rmSync(resolved, { force: true, recursive: true, maxRetries: 3 });
    return true;
  } catch (_error) {
    return false;
  }
}

function signalProcessGroup(pid, signal = "SIGTERM") {
  const wanted = Math.floor(Number(pid) || 0);
  if (wanted <= 1) return false;

  try {
    if (process.platform === "win32") {
      if (signal !== "SIGKILL") {
        process.kill(wanted, signal);
      } else {
        spawnSync("taskkill", ["/pid", String(wanted), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5000
        });
      }
    } else {
      process.kill(-wanted, signal);
    }
    return true;
  } catch (_error) {
    try {
      process.kill(wanted, signal);
      return true;
    } catch (_innerError) {
      return false;
    }
  }
}

function killPlaywrightBrowserProcess(processInfoOrPid) {
  const pid = Math.floor(Number(processInfoOrPid?.pid || processInfoOrPid) || 0);
  const current = playwrightBrowserProcess(pid);
  const known = typeof processInfoOrPid === "object" ? processInfoOrPid : null;

  if (current) signalProcessGroup(current.pid, "SIGKILL");
  cleanupPlaywrightProfile(current || known);
  return Boolean(current);
}

module.exports = {
  cleanupPlaywrightProfile,
  findPlaywrightBrowserChildren,
  isPlaywrightBrowserCommand,
  killPlaywrightBrowserProcess,
  playwrightBrowserProcess,
  processTable,
  signalProcessGroup
};
