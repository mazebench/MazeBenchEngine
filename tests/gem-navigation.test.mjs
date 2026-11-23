import test from "node:test";
import assert from "node:assert/strict";
import { gemReplayFrames, gemFrameIndex, roomGemLocations, gemCollectionLocations, loadWorldGemLocations } from "../benchmarking/ui/gem-navigation.mjs";

test("replay stops at collection moves, merges simultaneous gems, and excludes the final plateau", () => {
  const frames = gemReplayFrames({ available: true, points: [
    { move: 0, gems: 0 }, { move: 3, gems: 1 }, { move: 3, gems: 2 },
    { move: 10, gems: 3 }, { move: 12, gems: 3 }, { move: 14, gems: 4 }
  ] }, 12);
  assert.deepEqual(frames, [{ move: 0, gems: 0 }, { move: 3, gems: 2 }, { move: 10, gems: 3 }]);
  assert.deepEqual([0, 2, 3, 9, 10, 50].map(move => gemFrameIndex(frames, move)), [0, 0, 1, 1, 2, 2]);
  assert.deepEqual(gemReplayFrames({ available: false }), [{ move: 0, gems: 0 }]);
  assert.deepEqual(gemReplayFrames({ available: true, points: [{ move: 15, gems: 0 }] }), [{ move: 0, gems: 0 }]);
});

const blocks = [{ id: "floor", roleId: "floor" }, { id: "prize", roleId: "goal" }];
const room = { storageFormat: "mazebench-voxel-room-v2", schemaVersion: 2, world: [16, 16],
  palette: [{ blockId: "floor" }, { blockId: "prize" }], voxels: [[1, 2, 0, 0], [3, 4, 1, 1]] };

test("gem map decodes goal roles and translates room coordinates without swapping axes", () => {
  assert.deepEqual(roomGemLocations(room, ["C", "F"], blocks), [{ worldX: 35, worldY: 84, room: "CxF", z: 1 }]);
  assert.throws(() => roomGemLocations(room, ["Z", "A"], blocks), /Invalid/);
});

test("static world loading bounds concurrent requests and propagates unavailable rooms", async () => {
  const rooms = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`room${i}.json`, ["A", String.fromCharCode(65 + i)]]));
  let active = 0, peak = 0;
  const result = await loadWorldGemLocations(async url => {
    if (url.endsWith("world.json")) return { rooms, blocks };
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return room;
  });
  assert.equal(result.length, 9);
  assert.equal(peak, 4);
  await assert.rejects(loadWorldGemLocations(async url => {
    if (url.endsWith("world.json")) return { rooms, blocks };
    throw Error("room unavailable");
  }), /room unavailable/);
});

const gem = (worldX, room = "AxA", z = 0) => ({ worldX, worldY: 1, room, z });
const collect = (count, player, traversedPositions = [], roomBefore = "AxA", roomAfter = "AxA") =>
  ({ gemsCollected: count, player, traversedPositions, roomBefore, roomAfter });
const status = (locations, actions, extra = {}) => gemCollectionLocations(locations, {
  actions, gems_collected: actions.reduce((n, a) => n + a.gemsCollected, 0), ...extra
}).map(g => g.status);

test("collection markers require recorded collections, including slide paths and multi-gem moves", () => {
  const locations = [gem(1), gem(2), gem(3)];
  assert.deepEqual(status(locations, [collect(0, gem(1))]), ["remaining", "remaining", "remaining"]);
  assert.deepEqual(status(locations, [collect(2, gem(2), [gem(1)])]), ["collected", "collected", "remaining"]);
  assert.deepEqual(status([gem(1), gem(20, "BxA")], [collect(2, gem(20, "BxA"), [gem(1)], "AxA", "BxA")]), ["collected", "collected"]);
});

test("room totals locate otherwise unambiguous collections, while ambiguity and edited maps remain unknown", () => {
  assert.deepEqual(status([gem(1), gem(20, "BxA")], [collect(1, gem(8))]), ["collected", "remaining"]);
  assert.deepEqual(status([gem(1), gem(2)], [collect(1, gem(8))]), ["unknown", "unknown"]);
  assert.deepEqual(status([gem(1), gem(1, "AxA", 1)], [collect(1, { worldX: 1, worldY: 1 })]), ["unknown", "unknown"]);
  assert.deepEqual(status([gem(1), gem(2)], [collect(1, gem(1))], { world_revision: 1 }), ["unknown", "unknown"]);
  assert.deepEqual(status([gem(1), gem(2)], [], { gems_collected: 1 }), ["unknown", "unknown"]);
  assert.deepEqual(status([gem(1), gem(2)], []), ["remaining", "remaining"]);
});
