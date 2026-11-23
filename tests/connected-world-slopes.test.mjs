import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { ConnectedWorldSessionV1 } from "../play/v1/connected-world-session.mjs";

const definitions = [
  { id: "ice", roleId: "ice", visual: { kind: "cube" } },
  { id: "wall", roleId: "solid", visual: { kind: "cube" } },
  { id: "player", roleId: "player", visual: { kind: "cube" } },
  { id: "slope", roleId: "ice", visual: { kind: "slope" } }
];
const directions = ["up", "right", "down", "left"];
const player = (state) => state.objects.find((object) => object.blockId === "player");
const room = (fileName, rowIndex, objects) => ({
  fileName, columnIndex: 1, rowIndex, width: 4, height: 4, objects
});

// Reduced NxJ seam: an alternating slope track reflects at its high north edge
// when the authoritative engine sees only the source room's rectangle.
function fixture() {
  const source = room("source.json", 1, [
    ...[0, 1, 2, 3].map((y) => ({ x: 1, y, z: 0, blockId: "ice" })),
    ...[0, 1, 2].map((y) => ({
      x: 1, y, z: 1, blockId: "slope", orientation: y % 2 ? "down" : "up"
    })),
    { x: 1, y: 3, z: 1, blockId: "player" }
  ]);
  const destination = room("destination.json", 0, [
    ...[0, 1, 2, 3].map((y) => ({ x: 1, y, z: 0, blockId: y === 0 ? "wall" : "ice" })),
    ...[1, 2, 3].map((y) => ({
      x: 1, y, z: 1, blockId: "slope", orientation: y % 2 ? "down" : "up"
    }))
  ]);
  return { source, destination };
}

function rotateRoom(value) {
  [value.columnIndex, value.rowIndex] = [2 - value.rowIndex, value.columnIndex];
  for (const object of value.objects) {
    [object.x, object.y] = [3 - object.y, object.x];
    if (object.orientation) {
      object.orientation = directions[(directions.indexOf(object.orientation) + 1) % 4];
    }
  }
}

async function loadEngine() {
  return instantiateMazeBenchEngineV1(await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url)));
}

for (const [rotation, direction] of directions.entries()) {
  test(`slope momentum crosses the ${direction} seam before the temporary boundary reflects it`, async () => {
    const engine = await loadEngine();
    const { source, destination } = fixture();
    const expected = { x: 1, y: 0, z: 1, blockId: "player" };
    for (let turn = 0; turn < rotation; turn += 1) {
      rotateRoom(source);
      rotateRoom(destination);
      [expected.x, expected.y] = [3 - expected.y, expected.x];
    }
    const initial = engine.createState(source);
    const isolated = await engine.simulateCommand(initial, direction, definitions);
    assert.deepEqual(player(isolated.final), player(initial), "isolated slopes bounce back to the start");

    const world = new ConnectedWorldSessionV1(engine, definitions, [source, destination]);
    const result = await world.simulateCommand(initial, source, direction);
    assert.equal(result.cycle, null);
    assert.equal(result.room, destination);
    assert.deepEqual(player(result.final), expected);
    assert.equal(result.animationFrames.findIndex((frame) => frame.room === destination), 3);
    assert.deepEqual(result.connectedRooms, [source.fileName, destination.fileName]);
    assert.deepEqual(initial, engine.createState(source), "reruns preserve the original command state");
  });
}

test("an outward command starting on the edge slope crosses immediately", async () => {
  const engine = await loadEngine();
  const { source, destination } = fixture();
  const world = new ConnectedWorldSessionV1(engine, definitions, [source, destination]);
  const initial = engine.createState(source);
  Object.assign(player(initial), { y: 0, z: 2 });
  const result = await world.simulateCommand(initial, source, "up");
  assert.equal(result.animationFrames[0].room, destination);
  assert.deepEqual(player(result.final), { x: 1, y: 0, z: 1, blockId: "player" });
});

test("missing or blocked slope neighbors preserve the engine's original bounce", async () => {
  const engine = await loadEngine();
  const { source, destination } = fixture();
  destination.objects.push({ x: 1, y: 3, z: 2, blockId: "wall" });
  const initial = engine.createState(source);
  const isolated = await engine.simulateCommand(initial, "up", definitions);
  for (const rooms of [[source], [source, destination]]) {
    const world = new ConnectedWorldSessionV1(engine, definitions, rooms);
    const result = await world.simulateCommand(initial, source, "up");
    assert.equal(result.room, source);
    assert.deepEqual(result.final, isolated.final);
    assert.deepEqual(result.frames, isolated.frames);
    assert.deepEqual(result.connectedRooms, [source.fileName]);
  }
});

test("a blocked first seam does not hide a later exit after the slope bounce", async () => {
  const engine = await loadEngine();
  const { source, destination } = fixture();
  destination.objects.push({ x: 1, y: 3, z: 2, blockId: "wall" });
  const south = room("south.json", 2, [{ x: 1, y: 0, z: 0, blockId: "wall" }]);
  const world = new ConnectedWorldSessionV1(engine, definitions, [source, destination, south]);
  const result = await world.simulateCommand(engine.createState(source), source, "up");
  assert.equal(result.room, south);
  assert.deepEqual(player(result.final), { x: 1, y: 0, z: 1, blockId: "player" });
  assert.deepEqual(result.connectedRooms, [source.fileName, south.fileName]);
});

test("an intermediate seam can resolve a cycle caused by temporary slope boundaries", async () => {
  const engine = await loadEngine();
  const { source, destination } = fixture();
  source.objects.push({ x: 1, y: 3, z: 1, blockId: "slope", orientation: "down" });
  Object.assign(player(source), { y: 2, z: 2 });
  const initial = engine.createState(source);
  const isolated = await engine.simulateCommand(initial, "up", definitions);
  assert.ok(isolated.cycle, "both temporary slope boundaries trap the isolated command in a cycle");
  const world = new ConnectedWorldSessionV1(engine, definitions, [source, destination]);
  const result = await world.simulateCommand(initial, source, "up");
  assert.equal(result.cycle, null);
  assert.equal(result.room, destination);
  assert.deepEqual(player(result.final), { x: 1, y: 0, z: 1, blockId: "player" });
});
