// Operator-only correction for the user-authorized IxM/IxN/JxM edits and
// action-10729 rollback. This is never available through HTTP or agent MCP.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, readSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BenchmarkGameRuntime } from "../benchmarking/v1/runtime.mjs";
import { BenchmarkSupervisor, benchmarkResumePrompt } from "../benchmarking/v1/supervisor.mjs";
import { assertRunConfiguration, verifyCheckpoint } from "../benchmarking/v1/integrity.mjs";
import { safeOpenFile, safeReadFile } from "../benchmarking/v1/safe-files.mjs";
import { originalStateHash } from "./recalculate-gem-free-novelty-v1.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";

export const LEVEL_ROLLBACK_10729 = {
  id: "run-2026-09-04T19-29-31-992Z-772688", from: 10864, to: 10729,
  manifest: "1c4d7e2c35d2ec5d506cf321a96b94d6169ba0683ef8576377a7c2b6a1be7b89",
  finalHash: "711177c61fb612a6f4b6cdf824c78e9100505cfa216c816aff4429ab2df82694",
  beforeEntryHash: "37cc17f1466b4105d9a71b1af52985d41830fd7a44cd5f4b72f0ec74e011be20",
  originalEntryHash: "9dc9cff58cab37a7ff26b9877093895b61f55484773476bc1fa34edacd762aaa",
  sourceCommit: "20aede86b9ac7f432e71d28f350826f76aa0c51d",
  files: {
    "level-data/v2/main-world/8ur7bs1t06.json": {
      room: "IxN", before: "d523100d15b2351b417599b83af8cec7691b1e5fc8f7fd5d3240aa259a2e593e",
      after: "b4e1261cf8de9d86cf82fb1a28de35e818b2991d667dc76a6f0e8a598b7485e2"
    },
    "level-data/v2/main-world/9ryrneexsm.json": {
      room: "IxM", before: "376bda4c1798daaf4a317f425105af808ccc8e465dd3ef92642f97396c219b5f",
      after: "82a53bf5a293f3bdb9c19451dbc34e64ebef6679a9fdc7603ae6ecd11771469b"
    },
    "level-data/v2/main-world/xmtj61iukw.json": {
      room: "JxM", before: "0a9cd3584b9d63d66184d0005c233008335a9b0f3f900d08c0be3701efc3a512",
      after: "765b8272cd913b35f760111159bda7b03854eb0735a90f12f24d8b6e32efe500"
    }
  }
};
const spec = LEVEL_ROLLBACK_10729;
const digest = value => createHash("sha256").update(value).digest("hex");
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const json = (directory, file) => JSON.parse(safeReadFile(directory, file));
function fileHash(directory, file) {
  const fd = safeOpenFile(directory, file), hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}
async function cloneFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
async function atomicCopy(source, destination) {
  const temporary = `${destination}.${process.pid}.rollback-tmp`;
  try { await cloneFile(source, temporary); await rename(temporary, destination); }
  finally { await rm(temporary, { force: true }); }
}

export async function replayLevelEntry10729(runtime, originals) {
  const old = runtime.internal, target = old.actions[spec.to - 1];
  assert.equal(old.actionCount, spec.from); assert.equal(old.gemsCollected.length, 10);
  assert.equal(old.stateHashes.at(-1), spec.finalHash);
  assert.equal(old.stateHashes[spec.to - 1], spec.beforeEntryHash);
  assert.equal(old.stateHashes[spec.to], spec.originalEntryHash);
  assert.equal(target.action, "down"); assert.equal(target.roomBefore, "IxL"); assert.equal(target.roomAfter, "IxM");
  assert.equal(old.noveltyVersion, 1); assert.equal(old.noveltyHashes.length, old.actionCount + 1);
  const stack = [], prefixStack = [];
  let yaw = 0, pitch = 1;
  for (const action of old.actions) {
    if (action.action === "undo") stack.pop();
    else if (action.stateChanged) stack.push(action.index - 1);
    if (action.index < spec.to) {
      if (action.action === "camera left") yaw = (yaw + 3) % 4;
      if (action.action === "camera right") yaw = (yaw + 1) % 4;
      if (action.action === "camera up") pitch = Math.max(0, pitch - 1);
      if (action.action === "camera down") pitch = Math.min(4, pitch + 1);
    }
    if (action.index === spec.to - 1) prefixStack.push(...stack);
  }
  assert.equal(stack.length, old.history.length);
  const index = stack.indexOf(spec.to - 1);
  assert.equal(index, 9562); assert.deepEqual(stack.slice(0, index), prefixStack);
  const prior = old.history[index], entry = old.history[index + 1];
  assert.equal(stack[index + 1], spec.to);
  assert.equal(originalStateHash(prior, old.gemsCollected), spec.beforeEntryHash);
  assert.equal(originalStateHash(entry, old.gemsCollected), spec.originalEntryHash);
  const prefix = old.actions.slice(0, spec.to - 1), tail = old.actions.slice(spec.to - 1);
  assert(tail.every(a => a.gemsCollected === 0));
  // After the crossing only these newly entered rooms were used. Therefore
  // earlier room-entry caches and the retained prefix undo stack are exact.
  assert(tail.every(a => ["IxM", "IxN"].includes(a.roomAfter)));
  assert(tail.slice(1).every(a => ["IxM", "IxN"].includes(a.roomBefore)));
  const visitedRooms = old.visitedRooms.slice(0, prefix.at(-1).roomsVisited);
  assert.equal(visitedRooms.length, 93);
  for (const file of Object.keys(spec.files)) assert(!visitedRooms.includes(path.basename(file)));
  const previous = {
    ...old, ...structuredClone(prior), actionCount: spec.to - 1, actions: prefix,
    updatedAt: prefix.at(-1).at, history: old.history.slice(0, index),
    stateHashes: old.stateHashes.slice(0, spec.to), noveltyHashes: old.noveltyHashes.slice(0, spec.to),
    positions: old.positions.slice(0, spec.to), yaw, pitch, visitedRooms,
    roomEntryStates: Object.fromEntries(visitedRooms.map(file => [file, old.roomEntryStates[file]])),
    gemsCollected: [...old.gemsCollected],
    blockedActions: old.blockedActions - tail.filter(a => a.blocked).length,
    deaths: old.deaths - tail.filter(a => a.died && old.positions[a.index - 1]).length,
    resets: old.resets - tail.filter(a => a.action === "reset").length,
    undos: old.undos - tail.filter(a => a.action === "undo").length,
    cameraActions: old.cameraActions - tail.filter(a => a.action.startsWith("camera ")).length
  };
  assert.equal(originalStateHash(previous, previous.gemsCollected), spec.beforeEntryHash);
  const assets = runtime.assets;
  const oldRooms = assets.rooms.map(room => originals.has(room.fileName)
    ? { ...room, ...decodeVoxelRoom(JSON.parse(originals.get(room.fileName))) } : room);
  const oldWorld = new ConnectedWorldSessionV1(assets.engine, assets.blocks, oldRooms);
  const replay = await oldWorld.simulateCommand(prior.state, assets.roomsByFile.get(prior.roomFile), cameraRelativeMoveDirection(target.action, yaw));
  assert.equal(replay.room.fileName, entry.roomFile);
  assert.deepEqual(replay.final, entry.state, "Original crossing must reproduce exactly before applying the authored edit.");
  const repaired = new BenchmarkGameRuntime(runtime.projectRoot, runtime.runDirectory, assets, previous);
  repaired.persist = async () => {}; // The caller publishes the complete staged checkpoint once.
  await repaired.apply(target.action);
  const state = repaired.internal;
  state.updatedAt = target.at; state.actions.at(-1).at = target.at;
  assert.equal(state.actionCount, spec.to); assert.equal(state.roomFile, "9ryrneexsm.json");
  assert.equal(state.visitedRooms.length, 94); assert.equal(state.history.length, index + 1);
  assert.deepEqual(state.gemsCollected, old.gemsCollected);
  assert.deepEqual(state.positions, old.positions.slice(0, spec.to + 1));
  assert.deepEqual(state.actions.slice(0, -1), old.actions.slice(0, spec.to - 1));
  assert.deepEqual({ ...state.actions.at(-1), stateHash: target.stateHash }, target);
  assert.deepEqual(state.stateHashes.slice(0, -1), old.stateHashes.slice(0, spec.to));
  assert.deepEqual(state.noveltyHashes.slice(0, -1), old.noveltyHashes.slice(0, spec.to));
  assert.equal(state.noveltyHashes.length, spec.to + 1);
  assert.notEqual(state.stateHashes.at(-1), spec.originalEntryHash);
  assert.equal(originalStateHash(state, state.gemsCollected), state.stateHashes.at(-1));
  assert.deepEqual(state.state, state.roomEntryState);
  assert.deepEqual(state.state, state.roomEntryStates[state.roomFile]);
  assert(!state.roomEntryStates["8ur7bs1t06.json"] && !state.roomEntryStates["xmtj61iukw.json"]);
  return state;
}

export async function repairLevelRollback10729(root, directory) {
  const metadata = json(directory, "run.json"), manifest = json(directory, "integrity.json");
  assert.equal(metadata.id, spec.id); assert.equal(metadata.status, "paused");
  assert.equal(metadata.model, "gpt-6-astra"); assert.equal(metadata.tools_enabled, false);
  assert.equal(metadata.codex_thread_id, "01a06de5-cf11-7883-9f85-b1197dd668f5");
  assert.equal(metadata.integrity.manifest_sha256, spec.manifest);
  assert.equal(fileHash(directory, "integrity.json"), spec.manifest);
  await assert.rejects(() => stat(path.join(directory, "integrity-violation.json")), { code: "ENOENT" });
  assertRunConfiguration(metadata, manifest); verifyCheckpoint(directory);
  const originalLevels = new Map();
  for (const [file, hashes] of Object.entries(spec.files)) {
    assert.equal(manifest.files[file], hashes.before); assert.equal(fileHash(root, file), hashes.after);
    const original = execFileSync("git", ["show", `${spec.sourceCommit}:${file}`], { cwd: root });
    assert.equal(digest(original), hashes.before);
    originalLevels.set(path.basename(file), original);
    manifest.files[file] = hashes.after;
  }
  const encodedManifest = encode(manifest), integrity = { ...metadata.integrity, manifest_sha256: digest(encodedManifest) };
  const assertInactive = async () => {
    const response = await fetch(`http://localhost:8080/api/benchmark/v1/runs/${spec.id}`);
    assert(response.ok); const run = await response.json();
    assert.equal(run.runner_active, false); assert.equal(run.status, "paused"); assert.equal(run.action_count, spec.from);
  };
  await assertInactive();
  const artifacts = ["integrity.json", "game-state.json", "summary.json", "display.json", "records/current_board.txt",
    "records/current_state.json", "records/moves.txt", "records/history.jsonl",
    `records/move_history/move_${spec.to}.txt`, `display-history/move_${spec.to}.json`, "run.json", "checkpoint.json"];
  const future = [];
  for (const folder of ["display-history", "records/move_history"]) {
    for (const name of await readdir(path.join(directory, folder))) {
      const match = /^move_(\d+)\.(json|txt)$/.exec(name); assert(match);
      if (Number(match[1]) > spec.to) future.push(`${folder}/${name}`);
    }
  }
  assert.equal(future.length, (spec.from - spec.to) * 2);
  const protectedFiles = [...artifacts, ...future, "prompt.md", "agent-events.jsonl", "tool-activity.jsonl", "agent-stderr.log", "sandbox-state/direct-model-catalog.json"];
  const originalHashes = Object.fromEntries(protectedFiles.map(file => [file, fileHash(directory, file)]));
  const staging = await mkdtemp(path.join(directory, ".level-rollback-"));
  const backup = path.join(directory, "repairs", "level-rollback-10729-v1");
  try {
    for (const folder of ["records/move_history", "display-history"])
      await mkdir(path.join(staging, folder), { recursive: true, mode: 0o700 });
    for (const file of ["game-state.json", "summary.json", "checkpoint.json", "prompt.md", "sandbox-state/integrity-key", "sandbox-state/direct-model-catalog.json"])
      await cloneFile(path.join(directory, file), path.join(staging, file));
    await writeFile(path.join(staging, "integrity.json"), encodedManifest, { mode: 0o600 });
    const supervisor = new BenchmarkSupervisor(root);
    await supervisor.verifyRunCapabilityBoundary({ ...metadata, integrity }, staging);
    const original = await BenchmarkGameRuntime.open(root, staging);
    const state = await replayLevelEntry10729(original, originalLevels);
    const runtime = new BenchmarkGameRuntime(root, staging, original.assets, state);
    await runtime.persist({ writeSnapshot: true });
    const reopened = await BenchmarkGameRuntime.open(root, staging);
    assert.deepEqual(reopened.summary(), runtime.summary());
    assert.deepEqual(reopened.internal.state, state.state);
    assert.deepEqual(reopened.internal.noveltyHashes, state.noveltyHashes);
    const repair = {
      at: new Date().toISOString(), kind: "operator-engine-rollback", action_count: spec.to, previous_action_count: spec.from,
      reason: "User edited IxM, IxN, and JxM and requested rollback to action 10729 before resuming. Replayed the original IxL-to-IxM crossing with the updated authored world. Earlier actions retain their original level versions.",
      files: spec.files, original_manifest_sha256: spec.manifest, repaired_manifest_sha256: integrity.manifest_sha256,
      original_state_hash: spec.finalHash, original_entry_hash: spec.originalEntryHash, repaired_state_hash: state.stateHashes.at(-1),
      original_checkpoint_authenticated: true, original_crossing_reproduced: true,
      codex_thread_id: metadata.codex_thread_id, conversation_retained: true, token_usage_retained: true,
      preserved: ["actions 0–10728", "10 collected gems", "action-10729 player position", "prefix undo/reset history", "camera", "model/tool policy", "prompt", "paused status"],
      novelty_note: "Retained the gem-free novelty prefix through 10728 and recomputed 10729. Removed all later novelty and position entries.",
      original_artifacts: originalHashes, archived_future: future, backup
    };
    metadata.integrity = integrity; metadata.runtime_repairs = [...(metadata.runtime_repairs || []), repair];
    metadata.status = "paused"; metadata.error = null; metadata.completed_at = null;
    metadata.paused_at = repair.at; metadata.updated_at = repair.at;
    await writeFile(path.join(staging, "run.json"), encode(metadata), { mode: 0o600 });
    assert.match(benchmarkResumePrompt(metadata, runtime.summary()), /rolled this run back from action 10864 to action 10729/);
    await supervisor.verifyRunCapabilityBoundary(metadata, staging);
    await assertInactive();
    for (const [file, hash] of Object.entries(originalHashes)) assert.equal(fileHash(directory, file), hash);
    await mkdir(backup, { mode: 0o700 });
    for (const file of protectedFiles) await cloneFile(path.join(directory, file), path.join(backup, file));
    for (const [file, hashes] of Object.entries(spec.files)) {
      await writeFile(path.join(backup, `${hashes.room}.before.json`), originalLevels.get(path.basename(file)), { flag: "wx", mode: 0o600 });
      await cloneFile(path.join(root, file), path.join(backup, `${hashes.room}.after.json`));
    }
    await writeFile(path.join(backup, "repair.json"), encode(repair), { flag: "wx", mode: 0o600 });
    try {
      for (const file of artifacts) await atomicCopy(path.join(staging, file), path.join(directory, file));
      for (const file of future) await rm(path.join(directory, file));
      await supervisor.verifyRunCapabilityBoundary(metadata, directory);
    } catch (error) {
      for (const file of [...artifacts, ...future]) await atomicCopy(path.join(backup, file), path.join(directory, file));
      verifyCheckpoint(directory); throw error;
    }
    return { id: spec.id, status: "paused", action_count: state.actionCount, room: "IxM", gems: 10,
      edited_rooms: Object.values(spec.files).map(file => file.room), archived_actions: spec.from - spec.to,
      state_hash: state.stateHashes.at(-1), resume_ready: true, backup };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], spec.id);
  const root = path.resolve(import.meta.dirname, ".."), records = process.env.MAZEBENCH_RECORDS_ROOT || path.join(os.homedir(), "records/mazebench-benchmark");
  console.log(JSON.stringify(await repairLevelRollback10729(root, path.join(records, spec.id)), null, 2));
}
