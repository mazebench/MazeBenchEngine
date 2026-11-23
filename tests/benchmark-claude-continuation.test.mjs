import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BenchmarkSupervisor, claudeContinuationPrompt } from "../benchmarking/providers/supervisor.mjs";
import { createRunIntegrity, signCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { CLAUDE_POLICY, digest, providerRuntimeHashes } from "../benchmarking/providers/claude-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-continuation-test-"));
  const binary = path.join(directory, "fixture-binary");
  await writeFile(binary, "fixture"); await writeFile(path.join(directory, "prompt.md"), "play");
  const configuration = { provider: "claude-code", model: "claude-fable-5-1", effort: "low", tools_enabled: false,
    action_limit: null, start_room: "HxI", effective_prompt_sha256: digest("play"), claude_policy: CLAUDE_POLICY,
    claude_executable: binary, claude_sha256: digest("fixture"), claude_version: "2.1.258", provider_runtime: await providerRuntimeHashes(root) };
  const integrity = await createRunIntegrity(root, directory, configuration);
  await BenchmarkGameRuntime.create(root, directory, { actionLimit: null });
  const metadata = { ...configuration, integrity, id: "fixture", status: "paused",
    claude_session_id: "same-session", continuation_count: 0, last_turn_actions: 0 };
  const summary = { action_count: 7, game_status: "playing", actions: [] };
  const save = async (file, value) => {
    await writeFile(path.join(directory, file), JSON.stringify(value));
    if (file === "summary.json") await signCheckpoint(directory);
  };
  await save("run.json", metadata); await save("summary.json", summary);
  const supervisor = new BenchmarkSupervisor(root);
  return { directory, metadata, summary, supervisor, save };
}

test("Claude refusal and camera-only turns keep running with escalating gameplay instructions", async () => {
  const f = await fixture(), prompts = [], control = { pauseRequested: false, stopRequested: false };
  try {
    f.supervisor.runClaudeTurn = async options => {
      assert.equal(options.metadata.claude_session_id, "same-session"); prompts.push(options.prompt);
      if (prompts.length === 2) { f.summary.action_count++; f.summary.actions.push({ index: f.summary.action_count, action: "camera up" }); }
      if (prompts.length === 3) { f.summary.action_count++; f.summary.actions.push({ index: f.summary.action_count, action: "left" }); }
      if (prompts.length === 4) control.pauseRequested = true;
      await f.save("summary.json", f.summary);
      return { code: 0, result: { is_error: false, result: "The puzzle is impossible. I quit." } };
    };
    await f.supervisor.claudeLoop("fixture", f.directory, claudeContinuationPrompt(f.summary), control);
    assert.equal(prompts.length, 4);
    assert.match(prompts[1], /last 1 consecutive/); assert.match(prompts[2], /last 2 consecutive/);
    assert.doesNotMatch(prompts[3], /consecutive completed/);
    for (const prompt of prompts) assert.match(prompt, /at least one gameplay action this turn/);
    const metadata = JSON.parse(await readFile(path.join(f.directory, "run.json")));
    assert.equal(metadata.status, "paused"); assert.equal(metadata.last_turn_gameplay_actions, 1);
    assert.equal(metadata.consecutive_no_gameplay_turns, 0); assert.equal(metadata.continuation_count, 3);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("only an engine terminal status completes a Claude run; transport and boundary failures still stop it", async () => {
  for (const mode of ["won", "action-limit", "service-error", "integrity-error", "operator-stop"]) {
    const f = await fixture(), control = { pauseRequested: false, stopRequested: false }; let turns = 0;
    try {
      f.supervisor.runClaudeTurn = async () => {
        turns++;
        if (mode === "service-error") return { code: 1, error: "service failed" };
        if (mode === "integrity-error") return { boundaryError: "forbidden tool" };
        if (mode === "operator-stop") control.stopRequested = true;
        if (turns === 2) { f.summary.game_status = mode; await f.save("summary.json", f.summary); }
        return { code: 0, result: { is_error: false, result: "All done" } };
      };
      const run = () => f.supervisor.claudeLoop("fixture", f.directory, "continue", control);
      if (mode.endsWith("error")) await assert.rejects(run, /service failed|forbidden tool/);
      else {
        await run();
        const metadata = JSON.parse(await readFile(path.join(f.directory, "run.json")));
        assert.equal(metadata.status, mode === "operator-stop" ? "stopped" : "completed");
        assert.equal(turns, mode === "operator-stop" ? 1 : 2);
      }
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});

test("resuming the existing stalled session immediately requires gameplay", async () => {
  const f = await fixture(); let launched;
  try {
    f.supervisor.runDirectory = () => f.directory;
    f.supervisor.get = async () => JSON.parse(await readFile(path.join(f.directory, "run.json")));
    f.supervisor.startClaude = (id, directory, prompt) => { launched = { id, directory, prompt }; };
    const run = await f.supervisor.resume("fixture");
    assert.equal(run.claude_session_id, "same-session"); assert.equal(run.status, "queued");
    assert.match(launched.prompt, /Resume the same MazeBench/);
    assert.match(launched.prompt, /last 1 consecutive/);
    assert.match(launched.prompt, /won or action-limit status, or an operator pause\/stop/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
