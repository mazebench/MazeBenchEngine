// Operator-only authentication. This never starts an evaluated model or enables
// Antigravity benchmark launches. Credentials stay in a private, separate home.
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Run this login helper in an interactive terminal and paste the Google code there.");
}
const profile = path.join(os.homedir(), ".mazebench", "antigravity-auth");
const appData = path.join(profile, ".gemini", "antigravity-cli");
const cwd = path.join(profile, "login-cwd");
for (const directory of [profile, appData, cwd]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
const deny = ["command(*)", "unsandboxed(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)"];
const settingsPath = path.join(appData, "settings.json");
try {
  await writeFile(settingsPath, JSON.stringify({ toolPermission: "strict", permissions: { allow: [], deny } }), { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  if (settings.modelProvider || settings.permissions?.allow?.length || !deny.every(rule => settings.permissions?.deny?.includes(rule))) {
    throw new Error("The private login profile settings changed; refusing to broaden permissions or switch billing providers.");
  }
}
console.log("Sign in to the isolated MazeBench profile as mazebench@gmail.com.");
console.log("Open the Google link below, then paste the NEW code into this terminal (input is hidden). Do not paste it in chat.");
console.log("This only checks account usage; benchmark launches remain disabled until isolation is validated.\n");
const terminal = spawnSync("/bin/stty", ["-g"], { stdio: [0, "pipe", 2], encoding: "utf8" });
if (terminal.status !== 0) throw new Error("Cannot protect terminal input from being echoed.");
spawnSync("/bin/stty", ["-echo"], { stdio: "inherit" });
const restore = () => spawnSync("/bin/stty", [terminal.stdout.trim()], { stdio: "inherit" });
process.once("exit", restore);
const child = spawn(process.env.MAZEBENCH_ANTIGRAVITY_BIN || path.join(os.homedir(), ".local", "bin", "agy"),
  ["-p", "/usage", "--print-timeout", "0", "--log-file", path.join(appData, "login.log")], {
    cwd, stdio: "inherit",
    env: {
      HOME: profile, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
      PATH: process.env.PATH || "/usr/bin:/bin", TMPDIR: os.tmpdir(),
      // Use the documented manual/remote flow: no browser takeover or writes to
      // the normal interactive account's Keychain. CLI storage is profile-local.
      SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 2", AGY_CLI_DISABLE_AUTO_UPDATE: "1"
    }
  });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
