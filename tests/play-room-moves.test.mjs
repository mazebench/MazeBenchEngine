import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PlaySessionV1 } from "../play/current/play-session.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";
import { MoveSequencePlayer } from "../ui/move-sequence.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const cell = (blockId, x, y = 1) => ({ blockId, x, y, z: 0 });
const floor = (id = "floor") => Array.from({ length: 32 }, (_, i) => cell(id, i % 8, Math.floor(i / 8)));
const room = (objects, columnIndex = 0) => ({ width: 8, height: 4, objects, fileName: `${columnIndex}.json`, columnIndex, rowIndex: 0 });
const enginePromise = readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)).then(instantiateMazeBenchEngineV1);

async function fixture(rooms = [room([...floor(), cell("wall", 0), cell("player", 1)])]) {
  const engine = await enginePromise, summaries = [];
  const connected = new ConnectedWorldSessionV1(engine, definitions, rooms, { presentation: true });
  const session = new PlaySessionV1(engine, definitions, { frameDelay: 0,
    resolveCommand: (state, active, direction) => connected.simulateCommand(state, active, direction),
    onChange: summary => summaries.push(summary) });
  session.open(rooms[0]);
  const player = new MoveSequencePlayer(() => session, () => {}, async () => {});
  return { session, summaries, player, rooms };
}

test("room UDLR round-trips through playback, skips blocked moves, and follows undo/reset/selection", async () => {
  const { session, summaries, player, rooms } = await fixture();
  await session.move("left");
  assert.equal(session.roomMoves, "");
  assert.equal(summaries.at(-1).canUndo, false);
  await player.run("RDLU");
  const final = structuredClone(session.state), recorded = session.roomMoves;
  assert.equal(recorded, "RDLU");
  assert.equal(summaries.at(-1).roomMoves, recorded);
  session.undo();
  assert.equal(session.roomMoves, "RDL");
  await session.reset();
  assert.equal(session.roomMoves, "");
  await player.run(recorded);
  assert.deepEqual(session.state, final);
  session.open(rooms[0]);
  assert.equal(session.roomMoves, "");
  assert.equal(summaries.at(-1).roomMoves, "");
});

test("a slide records one input; history survives the undo snapshot limit", async () => {
  const sliding = await fixture([room([...floor("ice-floor"), cell("player", 1), cell("wall", 7)])]);
  await sliding.session.move("right");
  assert.equal(sliding.session.state.objects.find(object => object.blockId === "player").x, 6);
  assert.equal(sliding.session.roomMoves, "R");
  sliding.session.undo();
  assert.equal(sliding.session.roomMoves, "");

  const { session, player } = await fixture();
  await player.run("RL".repeat(150));
  assert.equal(session.history.length, 256);
  assert.equal(session.roomMoves, "RL".repeat(150));
  session.undo();
  assert.equal(session.roomMoves, "RL".repeat(149) + "R");
});

test("room crossings start fresh and undo restores the previous visit's sequence", async () => {
  const source = room([...floor(), cell("player", 6)]), destination = room([...floor(), cell("player", 5)], 1);
  const { session } = await fixture([source, destination]);
  await session.move("right");
  assert.equal(session.roomMoves, "R");
  await session.move("right");
  assert.equal(session.room, destination);
  assert.equal(session.roomMoves, "");
  await session.move("down");
  assert.equal(session.roomMoves, "D");
  session.undo();
  assert.equal(session.roomMoves, "");
  session.undo();
  assert.equal(session.room, source);
  assert.equal(session.roomMoves, "R");
  await session.move("right");
  await session.move("left");
  assert.equal(session.room, source);
  assert.equal(session.roomMoves, "", "forward re-entry starts a new visit");
});

test("cancelling an in-flight command cannot append to restored or cleared room moves", async () => {
  for (const action of ["undo", "reset", "open"]) {
    const { session, rooms } = await fixture();
    await session.move("right");
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    session.setFrameDelay(100);
    session.animateCommand = ({ signal }) => new Promise(resolve => {
      signal.addEventListener("abort", () => resolve(false), { once: true });
      started();
    });
    const moving = session.move("down");
    await ready;
    assert.equal(session.roomMoves, "R");
    if (action === "open") session.open(rooms[0]); else await session[action]();
    await moving;
    assert.equal(session.roomMoves, action === "undo" ? "R" : "", action);
    assert.equal(session.running, false);
  }
});
