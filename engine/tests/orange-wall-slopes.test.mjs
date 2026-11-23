import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise } from "../../apps/web/app/worldBounds.mjs";
import { orangeWallEngineAnchorZ } from "../../apps/web/app/orangeWalls.mjs";
import {
  blocksById, engine, simulateFinal, simulateFrames, voxelMechanismId, voxelRole,
} from "./helpers/project-engine.mjs";

const world = { width: 6, height: 6, floorLayer: 0 };
const cell = (blockId, x, y, z, metadata = {}) => ({ blockId, x, y, z, ...metadata });
const floor = () => Array.from({ length: 36 }, (_, i) => cell("floor", i % 6, Math.floor(i / 6), 0));
const wallState = { mechanismDepth: 0, stateId: 1 };
const get = (frame, blockId) => frame.find((v) => v.blockId === blockId);
const rampScene = () => [
  ...floor(), cell("player", 2, 5, 1),
  cell("orange-wall-slope", 2, 4, 1, { ...wallState, orientation: "up", variantId: 0 }),
  cell("wall", 2, 3, 1), cell("wall", 2, 2, 2),
];

for (let rotation = 0; rotation < 4; rotation++) {
  test(`orange slope climbs, slides, and preserves orientation at ${rotation * 90} degrees`, () => {
    const rotate = (frame) => rotateVoxelsClockwise(frame, world, rotation);
    const scene = rotate(rampScene());
    for (const input of [scene, [...scene].reverse()]) {
      const frames = simulateFrames(input, rotation, world);
      assert.equal(frames.cycle, null);
      assert.equal(frames.length, 2);
      for (const [index, frame] of frames.entries()) {
        assert.deepEqual(get(frame, "player"), rotate([cell("player", 2, 4 - index, 2)])[0]);
        assert.deepEqual(get(frame, "orange-wall-slope"), get(scene, "orange-wall-slope"));
      }
      assert.deepEqual(get(simulateFinal(input, rotation, world), "player"), get(frames.at(-1), "player"));
    }
  });
}

test("connected orange cubes and slopes lower and rise together without losing shape", () => {
  const scene = [
    ...floor(), cell("player", 0, 4, 1), cell("orange-button", 0, 3, 1, { orientation: "top" }),
    cell("orange-wall-slope", 3, 3, 2, { ...wallState, orientation: "left", variantId: 3 }),
    cell("orange-wall", 3, 2, 2, wallState),
  ];
  const lowered = simulateFinal(scene, 0, world);
  for (const blockId of ["orange-wall", "orange-wall-slope"]) {
    assert.deepEqual(get(lowered, blockId), { ...get(scene, blockId), mechanismDepth: 1, z: 1 });
  }
  const raised = simulateFinal(lowered, 2, world);
  for (const blockId of ["orange-wall", "orange-wall-slope"]) {
    assert.deepEqual(get(raised, blockId), get(scene, blockId));
  }
});

test("search finds and replays an uphill orange slope route", () => {
  const scene = [...rampScene(), cell("goal", 2, 3, 2)];
  const buffer = new Int32Array(engine.memory.buffer, engine.voxel_buffer(), scene.length * 5);
  scene.forEach((voxel, index) => buffer.set([
    voxel.x, voxel.y,
    blocksById.get(voxel.blockId)?.roleId === "orange-wall" ? orangeWallEngineAnchorZ(voxel) : voxel.z,
    voxelRole(voxel), voxelMechanismId(voxel),
  ], index * 5));
  assert.equal(engine.search_solve(scene.length, world.width, world.height, 1000), 1);
  assert.equal(engine.search_solution_length(), 1);
  const direction = engine.search_solution_step(0);
  assert.equal(direction, 0);
  const final = simulateFinal(scene, direction, world);
  assert.equal(get(final, "goal").x, -1, "replaying the solver's route collects the elevated gem");
});
