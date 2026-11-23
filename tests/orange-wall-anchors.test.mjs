import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { createCommandTimeline, sampleTrack } from "../animations/v1/timeline.mjs";

const manifestUrl = new URL("../level-data/v2/main-world/world.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const definitions = new Map(manifest.blocks.map(block => [block.id, block]));
const [fileName, position] = Object.entries(manifest.rooms).find(([, position]) => position.join("x") === "LxO");
const room = { ...decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName, manifestUrl), "utf8"))),
  fileName, position, columnIndex: 11, rowIndex: 14 };
const sequence = "RRRDDDLLLLDLUDDDDLLDDLLDDRRRRDRRUUU";

for (const connected of [false, true]) {
  test(`L×O box pushes keep orange walls anchored in every ${connected ? "connected Play" : "engine"} frame and tween`, async () => {
    const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));
    const world = new ConnectedWorldSessionV1(engine, definitions, [room], { presentation: true });
    let state = engine.createState(room), step = 0, wallMotion = 0, boxMotion = 0;
    for (const letter of sequence) {
      step++;
      const direction = { U: "up", D: "down", L: "left", R: "right" }[letter];
      const simulation = connected ? await world.simulateCommand(state, room, direction)
        : await engine.simulateCommand(state, direction, definitions);
      const trace = simulation.presentation || { initial: state, frames: simulation.frames };
      for (const [tick, frame] of trace.frames.entries()) {
        for (const [index, object] of trace.initial.objects.entries()) {
          const role = definitions.get(object.blockId)?.roleId, current = frame.objects[index];
          if (role === "orange-wall") {
            assert.deepEqual([current.x, current.y], [object.x, object.y], `wall ${index}, move ${step} ${letter}, tick ${tick}`);
            wallMotion += Number(current.z !== object.z);
          } else if (role === "weightless-pushable") {
            boxMotion += Number(current.x !== object.x || current.y !== object.y);
          }
        }
      }
      const timeline = createCommandTimeline({ state, room, simulation, definitions });
      for (const track of timeline.tracks.filter(track => track.block.roleId === "orange-wall")) {
        for (let time = 0; time <= timeline.duration; time += 10) {
          const pose = sampleTrack(track, time);
          assert.deepEqual([pose.x, pose.y], track.positions[0].slice(0, 2), `wall tween, move ${step} ${letter}`);
        }
      }
      state = simulation.final;
    }
    assert(wallMotion > 0, "the regression must exercise wall raising/lowering");
    assert(boxMotion > 0, "the regression must exercise pushed boxes");
  });
}
