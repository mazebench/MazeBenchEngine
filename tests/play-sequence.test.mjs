import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { instantiateMazeBenchEngineV1 } from "../engine/v1/engine.mjs";
import { PlaySessionV1 } from "../play/v1/play-session.mjs";
import { solverPathLabelV1 } from "../editor/v1/solvers.mjs";
import { MoveSequencePlayer, parseMoveSequence } from "../ui/move-sequence.mjs";

test("solver UDLR output round-trips through sequence input, including lowercase and whitespace", () => {
  const solution = ["down", "right", "right", "down", "left", "up"];
  assert.equal(solverPathLabelV1(solution), "DRRDLU");
  assert.deepEqual(parseMoveSequence(solverPathLabelV1(solution)), solution);
  assert.deepEqual(parseMoveSequence("drrdlu"), solution);
  assert.deepEqual(parseMoveSequence(" u, D\nL\tR "), ["up", "down", "left", "right"]);
  for (const text of ["", " \n", "UDRX", "up down", "R2", "↓ →"]) assert.throws(() => parseMoveSequence(text));
});

async function fixture() {
  const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/v1/voxel_physics.wasm", import.meta.url)));
  const blocks = [
    { id: "floor", roleId: "floor", visual: { kind: "floor" } },
    { id: "player", roleId: "player", visual: { kind: "cube" } }
  ];
  const room = { width: 2, height: 1, objects: [
    { x: 0, y: 0, z: 0, blockId: "player" },
    { x: 0, y: 0, z: 0, blockId: "floor" },
    { x: 1, y: 0, z: 0, blockId: "floor" }
  ] };
  const messages = [], commands = [];
  let player;
  const session = new PlaySessionV1(engine, blocks, {
    frameDelay: 0,
    resolveCommand: (state, _room, direction) => {
      commands.push(direction);
      return engine.simulateCommand(state, direction, blocks);
    },
    onChange: summary => { if (summary.error) player?.stop(summary.error, true); }
  });
  session.open(room);
  player = new MoveSequencePlayer(() => session, status => messages.push(status), async () => {});
  return { session, player, room, commands, messages };
}

test("long sequences execute every command through the real engine and retain normal undo", async () => {
  const { session, player, commands } = await fixture();
  await player.run("RL".repeat(20));
  assert.equal(commands.length, 40);
  assert.equal(player.completed, 40);
  assert.equal(session.moves, 40);
  assert.equal(session.queue.length, 0);
  assert.equal(session.undo(), true);
  assert.equal(session.moves, 39);
  await assert.rejects(player.run("RR?"));
  assert.equal(commands.length, 40);
});

test("Stop finishes the in-flight move and does not submit the rest", async () => {
  const { session, player, commands } = await fixture();
  const simulate = session.resolveCommand;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  session.resolveCommand = async (...args) => { await gate; return simulate(...args); };
  const playback = player.run("RL");
  player.stop();
  assert.equal(player.running, true);
  release();
  await playback;
  assert.deepEqual(commands, ["right"]);
  assert.equal(player.completed, 1);
  assert.equal(player.running, false);
});

test("reset, undo, and room selection invalidate a sequence without replaying queued commands", async () => {
  for (const action of ["reset", "undo", "open"]) {
    const { session, player, commands, room } = await fixture();
    await session.move("right");
    commands.length = 0;
    const simulate = session.resolveCommand;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    session.resolveCommand = async (...args) => { await gate; return simulate(...args); };
    const playback = player.run("LR");
    session[action](room);
    release();
    await playback;
    assert.equal(commands.length, 1, action);
    assert.equal(player.completed, 0, action);
    assert.match(player.reason, /game state changed/, action);
  }
});

test("death or engine failure stops sequence playback", async () => {
  const death = await fixture();
  death.session.resolveCommand = (state, _room, direction) => {
    death.commands.push(direction);
    const final = structuredClone(state);
    final.objects.find(object => object.blockId === "player").x = -1;
    return { final, frames: [final] };
  };
  await death.player.run("RR");
  assert.equal(death.commands.length, 1);
  assert.match(death.player.reason, /player fell/);
  const failure = await fixture();
  failure.session.resolveCommand = () => { throw new Error("Fixture failure"); };
  await failure.player.run("RR");
  assert.equal(failure.player.completed, 0);
  assert.equal(failure.player.reason, "Fixture failure");
  assert.equal(failure.player.running, false);
});
