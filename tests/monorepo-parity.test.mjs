import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import test from "node:test";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { blocksById, simulateFinal } from "../engine/tests/helpers/project-engine.mjs";
import { rotateVoxelsClockwise } from "../apps/web/app/worldBounds.mjs";

const canonical = new URL("../apps/web/public/physics/voxel_physics.wasm", import.meta.url);
const live = new URL("../engine/current/voxel_physics.wasm", import.meta.url);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("the test lab and browser engine load the very same built WASM file", async () => {
  assert.equal(await realpath(live), await realpath(canonical));
  const info = JSON.parse(await readFile(new URL("../engine/current/build-info.json", import.meta.url), "utf8"));
  assert.equal(digest(await readFile(canonical)), info.wasm.sha256);
  for (const file of info.files) {
    assert.equal(digest(await readFile(new URL(`../${file.path}`, import.meta.url))), file.sha256,
      `Rebuild the canonical engine after editing ${file.path}`);
  }
});

test("all four orange ramp directions produce the same result through both live adapters", async () => {
  const engine = await instantiateMazeBenchEngineV1(await readFile(canonical));
  const world = { width: 6, height: 6, floorLayer: 0 };
  const cell = (blockId, x, y, z, metadata = {}) => ({ blockId, x, y, z, ...metadata });
  const scene = [
    ...Array.from({ length: 36 }, (_, i) => cell("floor", i % 6, Math.floor(i / 6), 0)),
    cell("player", 2, 5, 1),
    cell("orange-wall-slope", 2, 4, 1, { orientation: "up", variantId: 0, stateId: 1, mechanismDepth: 0 }),
    cell("wall", 2, 3, 1), cell("wall", 2, 2, 2), cell("goal", 2, 3, 2),
  ];
  const definitions = [...blocksById.values()].map(block => block.roleId === "floor"
    ? { ...block, visual: { kind: "floor" } } : block);
  for (let rotation = 0; rotation < 4; rotation++) {
    const voxels = rotateVoxelsClockwise(scene, world, rotation);
    const expected = simulateFinal(voxels, rotation, world);
    const objects = voxels.map(voxel => ({ ...voxel,
      z: blocksById.get(voxel.blockId).roleId === "floor" ? voxel.z : voxel.z - 1 }));
    const { final } = await engine.simulateCommand({ ...world, objects }, rotation, definitions);
    const actualPlayer = final.objects.find(v => v.blockId === "player");
    const expectedPlayer = expected.find(v => v.blockId === "player");
    assert.deepEqual([actualPlayer.x, actualPlayer.y, actualPlayer.z + 1],
      [expectedPlayer.x, expectedPlayer.y, expectedPlayer.z]);
    assert.equal(final.objects.find(v => v.blockId === "goal").x, -1);
    assert.equal(final.objects.find(v => v.blockId === "orange-wall-slope").orientation,
      expected.find(v => v.blockId === "orange-wall-slope").orientation);
  }
});
