import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { authHome, environment, inspectInstallation, tokenPath, VERIFIED_VERSIONS } from "./policy.mjs";

const execute = promisify(execFile);
export const ANTIGRAVITY_PROVIDER = "antigravity";
export const ANTIGRAVITY_BLOCKER = "Antigravity requires a validated CLI version, an isolated subscription login, and an available Gemini model.";
export const ANTIGRAVITY_MODELS = ["medium", "high", "low"].map(effort => ({
  id: "gemini-3.8-flash-" + effort,
  name: "Gemini 3.8 Flash (" + (effort === "high" ? "High · maximum" : effort) + ")",
  provider: ANTIGRAVITY_PROVIDER, default_effort: effort, efforts: [effort]
})).concat(["high", "medium"].map(effort => ({
  id: "gemini-4-argon-" + effort,
  name: "Gemini 4 Argon (" + effort + ")",
  provider: ANTIGRAVITY_PROVIDER, default_effort: effort, efforts: [effort],
  description: "Requires Google AI Ultra or an eligible Gemini Enterprise plan."
})));

export async function antigravityInstallationStatus(command = "agy", run = execute, inspect = inspectInstallation, hasToken = existsSync) {
  const home = authHome();
  const options = { env: environment(home), cwd: existsSync(path.join(home, "login-cwd")) ? path.join(home, "login-cwd") : home,
    timeout: 25000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8" };
  try {
    const installation = inspect(command);
    const inventory = await run(installation.executable, ["models"], options).catch(() => null);
    const ids = new Set((inventory?.stdout || "").split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]));
    const models = ANTIGRAVITY_MODELS.filter(model => ids.has(model.id));
    // /usage is a local CLI command, not a model prompt. Authentication must
    // actually succeed; token-file existence alone never establishes readiness.
    const usage = hasToken(tokenPath(home)) ? await run(installation.executable,
      ["-p", "/usage", "--print-timeout", "20s", "--log-file", path.join(home, "status.log")], options).catch(() => null) : null;
    const authenticated = Boolean(usage && /Gemini Models\s+Weekly Limit Remaining/.test(usage.stdout));
    const tested = VERIFIED_VERSIONS.has(installation.version);
    const ready = tested && authenticated && models.length > 0 && process.platform === "darwin";
    return { ...installation, available: true, tested, authenticated, launch_ready: ready, models,
      inventory_available: Boolean(inventory), model_available: models.length > 0,
      auth_method: authenticated ? "Google subscription · isolated profile" : null,
      error: ready ? null : !tested ? "This Antigravity CLI version needs capability validation." :
        !authenticated ? "Complete the isolated MazeBench Google login." : ANTIGRAVITY_BLOCKER };
  } catch (error) {
    return { available: false, tested: false, authenticated: false, launch_ready: false, models: [],
      inventory_available: false, model_available: false, error: "Antigravity CLI unavailable: " + error.message };
  }
}
