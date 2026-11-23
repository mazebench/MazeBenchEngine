// Operator-only historical reconstruction. Every recovered board must match its
// original full-state hash (including gems) before the new analytics key is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cameraRelativeMoveDirection } from "../play/v1/camera-relative-input.mjs";
import { noveltyStateHash, NOVELTY_VERSION } from "../benchmarking/v1/novelty.mjs";

export function originalStateHash(snapshot, gems) {
  return createHash("sha256").update(JSON.stringify({
    roomFile: snapshot.roomFile,
    objects: snapshot.state.objects.map(o => ({
      blockId: o.blockId, x: o.x, y: o.y, z: o.z,
      genericId: o.genericId ?? o.engineGenericId ?? null, groupId: o.groupId ?? null,
      stateId: o.stateId ?? null, mechanismDepth: o.mechanismDepth ?? null, orientation: o.orientation ?? null
    })), gemsCollected: [...gems].sort()
  })).digest("hex");
}

function* subsets(values, count, start = 0, prefix = []) {
  if (!count) { yield prefix; return; }
  for (let i = start; i <= values.length - count; i++) yield* subsets(values, count - 1, i + 1, [...prefix, values[i]]);
}

export async function reconstructNovelty(state, assets) {
  assert.equal(state.actions.length, state.actionCount);
  assert.equal(state.stateHashes.length, state.actionCount + 1);
  const indexes = [];
  for (const action of state.actions) {
    if (action.action === "undo") indexes.pop();
    else if (action.stateChanged) indexes.push(action.index - 1);
  }
  assert.equal(indexes.length, state.history.length, "Undo history cannot be aligned with the action record.");
  const exact = new Map(indexes.map((index, i) => [index, state.history[i]]));
  exact.set(state.actionCount, { roomFile: state.roomFile, state: state.state, roomEntryState: state.roomEntryState });
  const known = new Map(), gemSets = new Map([[0, []]]);
  const gemCount = index => index ? state.actions[index - 1].totalGems : 0;
  const resolveGems = (snapshot, count, expected) => {
    if (!gemSets.has(count)) {
      const lower = Math.max(...[...gemSets.keys()].filter(value => value < count));
      const previous = gemSets.get(lower);
      const remaining = state.gemsCollected.filter(gem => !previous.includes(gem));
      for (const added of subsets(remaining, count - previous.length)) {
        const candidate = [...previous, ...added].sort();
        if (originalStateHash(snapshot, candidate) === expected) { gemSets.set(count, candidate); break; }
      }
    }
    const gems = gemSets.get(count);
    assert(gems, `Cannot authenticate historical gem set with ${count} collected gems.`);
    assert.equal(originalStateHash(snapshot, gems), expected, "Recovered board does not match its original state hash.");
    return gems;
  };
  for (const [index, snapshot] of [...exact.entries()].sort(([a], [b]) => a - b)) {
    resolveGems(snapshot, gemCount(index), state.stateHashes[index]);
    known.set(state.stateHashes[index], snapshot);
  }
  let current = exact.get(0) || known.get(state.stateHashes[0]);
  assert(current, "Missing authenticated initial board.");
  const roomEntries = new Map([[current.roomFile, current.roomEntryState]]), undo = [];
  const cache = new Map();
  const key = (snapshot, fullHash) => {
    if (!cache.has(fullHash)) cache.set(fullHash, noveltyStateHash(snapshot.roomFile, snapshot.state, assets.definitions));
    return cache.get(fullHash);
  };
  const hashes = [key(current, state.stateHashes[0])], seen = new Set(hashes), flags = [];
  let yaw = 0, simulated = 0;
  for (const record of state.actions) {
    const index = record.index, action = record.action;
    const restored = action === "undo" ? undo.pop() : null;
    if (action !== "undo" && record.stateChanged) undo.push(current);
    let next = exact.get(index) || known.get(record.stateHash);
    if (!next) {
      if (["up", "down", "left", "right"].includes(action)) {
        const beforeRoom = assets.roomsByFile.get(current.roomFile);
        const result = await assets.connectedWorld.simulateCommand(current.state, beforeRoom, cameraRelativeMoveDirection(action, yaw));
        const roomFile = (result.room || beforeRoom).fileName;
        next = { roomFile, state: result.final, roomEntryState: roomFile === current.roomFile ? current.roomEntryState : result.final };
        simulated++;
      } else if (action === "undo") next = restored || current;
      else if (action === "reset") next = { ...current, state: current.roomEntryState };
      else if (action.startsWith("room ")) {
        const room = assets.roomsByLabel.get(action.slice(5).toUpperCase());
        const entry = roomEntries.get(room?.fileName);
        assert(entry, `Missing room entry at action ${index}.`);
        next = { roomFile: room.fileName, state: entry, roomEntryState: entry };
      } else if (action.startsWith("camera ")) next = current;
      else throw new Error(`Unsupported historical action ${action}.`);
      try { resolveGems(next, record.totalGems, record.stateHash); }
      catch (error) { throw new Error(`Cannot reconstruct action ${index} (${action}, ${record.roomAfter}): ${error.message}`, { cause: error }); }
      known.set(record.stateHash, next);
    }
    if (action === "camera left") yaw = (yaw + 3) % 4;
    if (action === "camera right") yaw = (yaw + 1) % 4;
    current = next;
    roomEntries.set(next.roomFile, next.roomEntryState);
    const noveltyHash = key(next, record.stateHash);
    hashes.push(noveltyHash);
    flags.push(!seen.has(noveltyHash));
    seen.add(noveltyHash);
  }
  assert.equal(hashes.length, state.actionCount + 1);
  assert(!flags.some((novel, i) => novel && !state.actions[i].novel), "Recalculation unexpectedly promoted a duplicate state.");
  return {
    noveltyVersion: NOVELTY_VERSION, noveltyHashes: hashes, flags,
    report: { action_count: state.actionCount, authenticated_snapshots: exact.size, reconstructed_movements: simulated,
      old_novel: state.actions.filter(a => a.novel).length, new_novel: flags.filter(Boolean).length,
      old_rate: state.actions.filter(a => a.novel).length / state.actionCount,
      new_rate: flags.filter(Boolean).length / state.actionCount,
      changed_actions: state.actions.filter((a, i) => a.novel !== flags[i]).map(a => a.index) }
  };
}
