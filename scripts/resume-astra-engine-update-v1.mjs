// Operator-only adoption of the reviewed engine, animation, transition and
// authored-level updates. No HTTP/MCP endpoint can invoke this migration.
// Restore the requested action-11686 entry, preserving its authenticated prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, readSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkSupervisor, benchmarkResumePrompt } from "../benchmarking/v1/supervisor.mjs";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { safeOpenFile, safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { originalStateHash } from "./recalculate-gem-free-novelty-v1.mjs";

const spec = JSON.parse(await readFile(new URL("./astra-engine-update-assets-v1.json", import.meta.url)));
const TARGET = 11686;
const PRIOR_HASH = "20c818321e3eeaa66117643604d785b801c694532fe9af337a66e3304a850b33";
const ENTRY_HASH = "54d4ae0bdcdfd0ebdceb060e2bafd9912f46864147941e2db6066fa0523e6e9b";
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const json = (root, file) => JSON.parse(safeReadFile(root, file));
function fileDigest(root, file) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = safeOpenFile(root, file);
  try {
    let length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
async function cloneFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.engine-update-tmp`;
  try { await cloneFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export async function replayAstraRollback11686(runtime) {
  const old = runtime.internal, target = old.actions[TARGET - 1];
  assert.equal(old.actionCount, spec.action_count);
  assert.equal(old.stateHashes.at(-1), spec.state_hash);
  assert.equal(old.stateHashes[TARGET - 1], PRIOR_HASH);
  assert.equal(old.stateHashes[TARGET], ENTRY_HASH);
  assert.equal(old.gemsCollected.length, 11);
  assert.equal(target.action, "down");
  assert.equal(target.roomBefore, "MxJ");
  assert.equal(target.roomAfter, "MxK");
  const stack = [], prefixStack = [];
  let yaw = 0, pitch = 1;
  for (const action of old.actions) {
    if (action.action === "undo") stack.pop();
    else if (action.stateChanged) stack.push(action.index - 1);
    if (action.index < TARGET) {
      if (action.action === "camera left") yaw = (yaw + 3) % 4;
      if (action.action === "camera right") yaw = (yaw + 1) % 4;
      if (action.action === "camera up") pitch = Math.max(0, pitch - 1);
      if (action.action === "camera down") pitch = Math.min(4, pitch + 1);
    }
    if (action.index === TARGET - 1) prefixStack.push(...stack);
  }
  assert.equal(stack.length, old.history.length);
  const index = stack.indexOf(TARGET - 1);
  assert.equal(index, 10380);
  assert.equal(stack[index + 1], TARGET);
  assert.deepEqual(stack.slice(0, index), prefixStack);
  const prior = old.history[index], entry = old.history[index + 1];
  assert.equal(originalStateHash(prior, old.gemsCollected), PRIOR_HASH);
  assert.equal(originalStateHash(entry, old.gemsCollected), ENTRY_HASH);
  const tail = old.actions.slice(TARGET - 1);
  assert(tail.every(a => ["up", "down", "left", "right"].includes(a.action) && a.gemsCollected === 0));
  assert(tail.every(a => ["MxJ", "MxK"].includes(a.roomBefore) && ["MxJ", "MxK"].includes(a.roomAfter)));
  const visitedRooms = old.visitedRooms.slice(0, old.actions[TARGET - 2].roomsVisited);
  assert.equal(visitedRooms.length, 94);
  assert(!visitedRooms.includes(entry.roomFile));
  const previous = {
    ...old, ...structuredClone(prior), actionCount: TARGET - 1,
    actions: old.actions.slice(0, TARGET - 1), history: old.history.slice(0, index),
    stateHashes: old.stateHashes.slice(0, TARGET), noveltyHashes: old.noveltyHashes.slice(0, TARGET),
    positions: old.positions.slice(0, TARGET), yaw, pitch, visitedRooms,
    roomEntryStates: { ...Object.fromEntries(visitedRooms.map(file => [file, old.roomEntryStates[file]])),
      [prior.roomFile]: structuredClone(prior.roomEntryState) },
    blockedActions: old.blockedActions - tail.filter(a => a.blocked).length,
    deaths: old.deaths - tail.filter(a => a.died && old.positions[a.index - 1]).length
  };
  // Verify the original transition with the originally pinned WASM and room.
  const oldWasm = execFileSync("git", ["show", "1c57ee71:engine/v1/voxel_physics.wasm"], { cwd: runtime.projectRoot, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(digest(oldWasm), spec.files["engine/v1/voxel_physics.wasm"].before);
  const roomFile = `level-data/v2/main-world/${entry.roomFile}`;
  const oldRoom = execFileSync("git", ["show", `20aede86:${roomFile}`], { cwd: runtime.projectRoot });
  assert.equal(digest(oldRoom), spec.files[roomFile].before);
  const source = runtime.assets.roomsByFile.get(prior.roomFile);
  const destination = { ...runtime.assets.roomsByFile.get(entry.roomFile), ...decodeVoxelRoom(JSON.parse(oldRoom)) };
  const oldWorld = new ConnectedWorldSessionV1(await instantiateMazeBenchEngineV1(oldWasm), runtime.assets.blocks, [source, destination]);
  const original = await oldWorld.simulateCommand(prior.state, source, cameraRelativeMoveDirection(target.action, yaw));
  assert.deepEqual(original.final, entry.state, "Original entry must reproduce before adopting the updated room");

  const repaired = new BenchmarkGameRuntime(runtime.projectRoot, runtime.runDirectory, runtime.assets, previous);
  let animation;
  repaired.persist = async (options) => { animation = options; };
  await repaired.apply(target.action);
  const state = repaired.internal;
  state.updatedAt = target.at;
  state.actions.at(-1).at = target.at;
  assert.equal(state.actionCount, TARGET);
  assert.equal(state.roomFile, entry.roomFile);
  assert.deepEqual(state.positions, old.positions.slice(0, TARGET + 1));
  assert.deepEqual(state.actions.slice(0, -1), old.actions.slice(0, TARGET - 1));
  assert.deepEqual({ ...state.actions.at(-1), stateHash: target.stateHash }, target);
  assert.deepEqual(state.gemsCollected, old.gemsCollected);
  assert.equal(originalStateHash(state, state.gemsCollected), state.stateHashes.at(-1));
  assert.equal(state.stateHashes.at(-1), "a8ec99d069184320b3a6fea2cadf4a477c70ec5feb4b708f50567a6ef68b4ab8");
  assert.equal(state.history.length, index + 1);
  assert.deepEqual(state.state, state.roomEntryState);
  assert.deepEqual(state.state, state.roomEntryStates[entry.roomFile]);
  return { state, animation };
}

export async function adoptAstraEngineUpdate(root, directory) {
  const metadata = json(directory, "run.json"), manifest = json(directory, "integrity.json");
  assert.equal(metadata.id, spec.id);
  assert.equal(metadata.status, "paused");
  assert.equal(metadata.model, "gpt-6-astra");
  assert.equal(metadata.effort, "max");
  assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.codex_thread_id, "01a06de5-cf11-7883-9f85-b1197dd668f5");
  assert.equal(metadata.error, null);
  assert.equal(metadata.integrity.manifest_sha256, spec.manifest_sha256);
  assert.equal(fileDigest(directory, "integrity.json"), spec.manifest_sha256);
  assertRunConfiguration(metadata, manifest);
  verifyCheckpoint(directory);

  // Explicit old/new hashes admit only changes examined for this checkpoint.
  for (const [file, hashes] of Object.entries(spec.files)) {
    assert.equal(manifest.files[file] ?? null, hashes.before, `Unexpected old asset: ${file}`);
    assert.equal(fileDigest(root, file), hashes.after, `Unreviewed asset: ${file}`);
    manifest.files[file] = hashes.after;
  }
  manifest.files = Object.fromEntries(Object.keys(manifest.files).sort().map(file => [file, manifest.files[file]]));
  const assertInactive = async () => {
    const response = await fetch("http://localhost:8080/api/benchmark/v1/runs");
    assert(response.ok);
    const run = (await response.json()).runs.find(run => run.id === spec.id);
    assert.equal(run.runner_active, false);
    assert.equal(run.status, "paused");
    assert.equal(run.action_count, spec.action_count);
    assert.equal(run.gems_collected, 11);
  };
  await assertInactive();
  const artifacts = ["integrity.json", "game-state.json", "summary.json", "display.json", "records/current_board.txt",
    "records/current_state.json", "records/moves.txt", "records/history.jsonl",
    `records/move_history/move_${TARGET}.txt`, `display-history/move_${TARGET}.json`, "checkpoint.json", "run.json"];
  const future = [];
  for (const folder of ["display-history", "records/move_history"]) {
    for (const name of await readdir(path.join(directory, folder))) {
      const match = /^move_(\d+)\.(json|txt)$/.exec(name);
      assert(match, "This pre-animation checkpoint must contain only final snapshots");
      if (Number(match[1]) > TARGET) future.push(`${folder}/${name}`);
    }
  }
  assert.equal(future.length, (spec.action_count - TARGET) * 2);
  const protectedFiles = [...artifacts, ...future, "prompt.md", "agent-events.jsonl", "tool-activity.jsonl", "agent-stderr.log"];
  const originals = Object.fromEntries(protectedFiles.map(file => [file, fileDigest(directory, file)]));
  const staging = await mkdtemp(path.join(directory, ".engine-update-"));
  const backup = path.join(directory, "repairs", "engine-animation-rollback-11686-v1");
  try {
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"])
      await cloneFile(path.join(directory, file), path.join(staging, file));
    const encoded = encode(manifest);
    const integrity = { ...metadata.integrity, manifest_sha256: digest(encoded), asset_count: Object.keys(manifest.files).length };
    await writeFile(path.join(staging, "integrity.json"), encoded, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const runtime = await BenchmarkGameRuntime.open(root, staging);
    assert.equal(runtime.internal.actionCount, spec.action_count);
    assert.equal(runtime.internal.stateHashes.at(-1), spec.state_hash);
    assert.equal(runtime.internal.roomFile, "vv03groobw.json");
    assert.equal(runtime.internal.gemsCollected.length, 11);
    const { state, animation } = await replayAstraRollback11686(runtime);
    const repaired = new BenchmarkGameRuntime(root, staging, runtime.assets, state);
    await repaired.persist(animation);
    const reopened = await BenchmarkGameRuntime.open(root, staging);
    assert.deepEqual(reopened.summary(), repaired.summary());
    assert.deepEqual(reopened.internal.state, state.state);
    const animationFiles = [state.actions.at(-1).animation.index_record,
      ...json(staging, `records/${state.actions.at(-1).animation.index_record}`).frames.map(frame => frame.record)]
      .map(record => `records/${record}`);
    const repair = {
      at: new Date().toISOString(), kind: "operator-runtime-update", action_count: TARGET,
      reason: "User requested rollback to action 11686 after the engine imports, animation-record feature, connected slope exit fix, and authored room edits; leave paused for manual resume and relay that MxF was broken and is fixed.",
      resume_notice: "The engine has been updated and the connected-room slope exit bug has been fixed. The user reports that room MxF was broken and its authored level is now fixed. Action 11686 now uses the corrected MxK entry layout with your original arrival position. Normal room crossings load updated authored rooms. Undo, reset, and saved room jumps can restore older historical snapshots, so normal re-entry is needed to load a corrected authored layout. Use current tool observations as the authority; prior conclusions about broken rooms may no longer apply.",
      files: spec.files, original_manifest_sha256: spec.manifest_sha256,
      repaired_manifest_sha256: integrity.manifest_sha256,
      previous_action_count: spec.action_count, archived_actions: spec.action_count - TARGET,
      original_checkpoint_authenticated: true, original_entry_reproduced: true,
      original_state_hash: spec.state_hash, original_entry_hash: ENTRY_HASH, state_hash: state.stateHashes.at(-1),
      prefix_through_11685_preserved: true, gems_preserved: 11, archived_future: future,
      conversation_retained: true, token_usage_retained: true, model_and_tools_retained: true,
      preserved_artifacts: originals, backup
    };
    metadata.integrity = integrity;
    metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair, {
      at: repair.at, kind: "operator-engine-rollback", action_count: TARGET, previous_action_count: spec.action_count,
      reason: repair.reason, backup
    }];
    metadata.updated_at = repair.at;
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertInactive();
    verifyCheckpoint(directory);
    for (const [file, hash] of Object.entries(originals)) assert.equal(fileDigest(directory, file), hash);
    await mkdir(backup, { mode: 0o700 });
    for (const file of protectedFiles) await cloneFile(path.join(directory, file), path.join(backup, file));
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(backup, "resume-prompt.txt"), benchmarkResumePrompt(metadata, repaired.summary()), { flag: "wx", mode: 0o600 });
    try {
      for (const file of [...animationFiles, ...artifacts]) await atomicCopy(path.join(staging, file), path.join(directory, file));
      for (const file of future) await rm(path.join(directory, file));
      for (const file of ["prompt.md", "agent-events.jsonl", "tool-activity.jsonl", "agent-stderr.log"]) assert.equal(fileDigest(directory, file), originals[file]);
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of [...artifacts, ...future]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      await rm(path.join(directory, `records/move_history/move_${TARGET}`), { recursive: true, force: true });
      throw error;
    }
    return { id: spec.id, status: "paused", action_count: TARGET, room: "MxK", gems: 11, archived_actions: spec.action_count - TARGET, backup };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], spec.id);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await adoptAstraEngineUpdate(root, path.join(records, spec.id)), null, 2));
}
