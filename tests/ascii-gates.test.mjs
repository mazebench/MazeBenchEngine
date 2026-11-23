import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderAsciiFrameV1 } from "../render-ascii/v1/ascii-scene.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const pixels = (frame, name) => frame.pixels.flat().filter(pixel => pixel.name === name);
const roomWithGate = state => ({ width: 1, height: 1, objects: [
  { x: 0, y: 0, z: 0, blockId: "floor" },
  { x: 0, y: 0, z: 0, blockId: "gate", ...state }
] });

test("ASCII distinguishes flat and raised gates without inventing a vertical flat-gate wall", async () => {
  for (const [state, raised] of [[{}, false], [{ stateId: 0 }, false], [{ stateId: 1 }, true],
    [{ engineGenericId: 5 }, true], [{ genericId: 4 }, false], [{ stateId: 0, genericId: 1 }, false]]) {
    const room = roomWithGate(state);
    const top = await renderAsciiFrameV1(room, definitions, { pitch: 0 });
    assert.deepEqual(top.rows, Array(4).fill(raised ? "YYYY" : "yyyy"));
    const side = await renderAsciiFrameV1(room, definitions, { pitch: 4 });
    assert.equal(pixels(side, "gate").length, raised ? 16 : 0);
    const pitched = await renderAsciiFrameV1(room, definitions, { pitch: 1 });
    assert.equal(pixels(pitched, "gate").length, raised ? 16 : 12);
  }
});

test("lowered gate plates follow mounted faces and remain hidden beneath occupants", async () => {
  for (const [orientation, x, y, yaw] of [["north", 1, 0, 2], ["east", 2, 1, 1], ["south", 1, 2, 0], ["west", 0, 1, 3]]) {
    const room = { width: 3, height: 3, objects: [
      { x: 1, y: 1, z: 0, blockId: "wall" },
      { x, y, z: 0, blockId: "gate", orientation, stateId: 0 }
    ] };
    const side = await renderAsciiFrameV1(room, definitions, { pitch: 4, yaw });
    assert.equal(pixels(side, "gate").length, 16, orientation);
    const away = await renderAsciiFrameV1(room, definitions, { pitch: 4, yaw: (yaw + 2) % 4 });
    assert.equal(pixels(away, "gate").length, 0, orientation);
    room.objects.push({ x, y, z: 0, blockId: "crate" });
    const covered = await renderAsciiFrameV1(room, definitions, { pitch: 4, yaw });
    assert.equal(pixels(covered, "gate").length, 0, orientation);
  }
  const room = roomWithGate({ stateId: 0 });
  room.objects.push({ x: 0, y: 0, z: 0, blockId: "orange-button", orientation: "top" });
  const button = await renderAsciiFrameV1(room, definitions, { pitch: 0 });
  assert.equal(pixels(button, "gate").length, 12);
  assert.equal(pixels(button, "orange-button").length, 4);
  room.objects.push({ x: 0, y: 0, z: 0, blockId: "player" });
  const covered = await renderAsciiFrameV1(room, definitions, { pitch: 0 });
  assert.equal(pixels(covered, "gate").length, 0);
  assert.equal(pixels(covered, "player").length, 16);
});

test("actual gate engine ticks render lowercase before rising and uppercase after rising", async () => {
  const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url)));
  const room = { width: 1, height: 3, objects: [
    { x: 0, y: 2, z: 0, blockId: "player" },
    { x: 0, y: 0, z: 0, blockId: "gate", stateId: 0 },
    ...[0, 1, 2].map(y => ({ x: 0, y, z: 0, blockId: "floor" }))
  ] };
  const command = await engine.simulateCommand(room, "up", definitions);
  assert.deepEqual(command.frames.map(frame => frame.objects[1].stateId), [0, 1]);
  const observations = await Promise.all(command.frames.map(frame => renderAsciiFrameV1(frame, definitions, { pitch: 0 })));
  assert.deepEqual(observations.map(frame => [...new Set(pixels(frame, "gate").map(pixel => pixel.glyph))]), [["y"], ["Y"]]);
  const released = await engine.simulateCommand(command.final, "down", definitions);
  const observation = await renderAsciiFrameV1(released.final, definitions, { pitch: 0 });
  assert.deepEqual([...new Set(pixels(observation, "gate").map(pixel => pixel.glyph))], ["y"]);
});
