import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { animateAsciiCommand } from "../animations/v1/ascii-playback.mjs";
import { createCommandTimeline } from "../animations/v1/timeline.mjs";
import { playTimeline } from "../animations/v1/player.mjs";
import { PlaySessionV1 } from "../play/current/play-session.mjs";
import { PlayGamepadInput } from "../ui/play-gamepad.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const cell = (blockId, x) => ({ blockId, x, y: 0, z: 0 });
const state = x => ({ width: 8, height: 1, objects: [cell("player", x)] });
const room = (objects, columnIndex = 0) => ({ width: 8, height: 1, objects, fileName: `${columnIndex}.json`, columnIndex, rowIndex: 0 });
const enginePromise = readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)).then(instantiateMazeBenchEngineV1);
const flush = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let now = 0, next = 0;
  const frames = new Map();
  return { frames, options: {
    now: () => now, requestFrame: callback => { frames.set(++next, callback); return next; },
    cancelFrame: id => frames.delete(id)
  }, advance(time) { now = time; const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); } };
}

test("ASCII uses the 3D step/slide clock, skips unchanged ticks, and only presents exact grid states", async () => {
  for (const [positions, expectedTimes] of [[[0, 1, 1], [100]], [[0, 1, 1, 2, 3, 3], [40, 80, 120]]]) {
    const c = clock(), frames = positions.map(state), shown = [], active = room(state(0).objects);
    const simulation = { frames, final: frames.at(-1) };
    const command = { state: state(0), room: active, simulation, stepMs: 100,
      presentFrame: frame => shown.push(frame) };
    const duration = createCommandTimeline({ ...command, definitions }).duration;
    let done = false;
    const pending = animateAsciiCommand(command, { definitions, ...c.options }).then(() => { done = true; });
    for (const [index, time] of expectedTimes.entries()) {
      c.advance(time - 1); await flush();
      assert.equal(shown.length, index); assert.equal(done, false);
      c.advance(time); await flush();
      assert.equal(shown.length, index + 1);
      assert.equal(shown[index].state.objects[0].x, index + 1);
    }
    await pending;
    assert.equal(duration, expectedTimes.at(-1));
    assert.equal(c.frames.size, 0);
  }
});

test("connected-room ASCII slides use projected local frames and finish with the same room-transition duration", async () => {
  const engine = await enginePromise, c = clock();
  const source = room([...Array.from({ length: 8 }, (_, x) => cell("ice-floor", x)), cell("player", 6)]);
  const destination = room(Array.from({ length: 8 }, (_, x) => cell("floor", x)), 1);
  const connected = new ConnectedWorldSessionV1(engine, definitions, [source, destination], { presentation: true });
  const initial = engine.createState(source), simulation = await connected.simulateCommand(initial, source, "right"), shown = [];
  const command = { state: initial, room: source, simulation, stepMs: 100, presentFrame: frame => shown.push(frame) };
  const timeline = createCommandTimeline({ ...command, definitions });
  let done = false;
  const pending = animateAsciiCommand(command, { definitions, ...c.options }).then(() => { done = true; });
  for (const time of timeline.times.slice(1)) c.advance(time);
  await flush(); assert.equal(done, false, "room timing continues after the final slide cell");
  assert.equal(shown.at(-1).room, destination);
  assert.equal(shown.at(-1).state.objects.find(object => object.blockId === "player").x, 0);
  assert(shown.every(frame => frame.state.width === 8));
  c.advance(timeline.duration - 1); await flush(); assert.equal(done, false);
  c.advance(timeline.duration); await pending; assert.equal(done, true);
});

test("held joystick and D-pad issue commands at identical times in ASCII and 3D", async () => {
  const engine = await enginePromise;
  const source = room([...Array.from({ length: 8 }, (_, x) => cell("floor", x)), cell("player", 0)]);
  for (const dpad of [false, true]) {
    const outcomes = [];
    for (const ascii of [false, true]) {
      const c = clock(), issued = [], connected = new ConnectedWorldSessionV1(engine, definitions, [source], { presentation: true });
      const session = new PlaySessionV1(engine, definitions, { frameDelay: 100,
        resolveCommand: (s, r, d) => connected.simulateCommand(s, r, d),
        animateCommand: command => ascii ? animateAsciiCommand(command, { definitions, ...c.options })
          : playTimeline(createCommandTimeline({ ...command, definitions }), () => {}, { ...c.options, signal: command.signal }).then(() => ({}))
      });
      session.open(source);
      let now = 0;
      const input = new PlayGamepadInput({ isAscii: () => ascii, canMove: () => !session.running,
        onMove: direction => { issued.push(now); void session.move(direction); },
        onCameraInput() {}, onRotate() {}, onPitchStep() {} });
      const pad = { connected: true, mapping: "standard", axes: [dpad ? 0 : 1, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({ value: Number(dpad && i === 15) })) };
      for (now = 0; now <= 650; now++) { c.advance(now); await flush(); input.update(pad, now); await flush(); }
      c.advance(1000); await flush();
      outcomes.push({ issued, state: session.state, moves: session.moves });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[1].issued, dpad ? [0, 260, 390, 520, 650] : [0, 195, 325, 455, 585]);
  }
});

test("ASCII playback cancels immediately and reset/undo cannot be overwritten by a late frame", async () => {
  const engine = await enginePromise;
  for (const action of ["undo", "reset", "open"]) {
    const c = clock();
    const source = room([...Array.from({ length: 8 }, (_, x) => cell("ice-floor", x)), cell("player", 1), cell("wall", 7)]);
    const destination = room([...Array.from({ length: 8 }, (_, x) => cell("floor", x)), cell("player", 3)], 1);
    const connected = new ConnectedWorldSessionV1(engine, definitions, [source, destination], { presentation: true });
    const session = new PlaySessionV1(engine, definitions, { frameDelay: 100,
      resolveCommand: (s, r, d) => connected.simulateCommand(s, r, d),
      animateCommand: command => animateAsciiCommand(command, { definitions, ...c.options }) });
    session.open(source); const initial = structuredClone(session.state), moving = session.move("right");
    await flush(); c.advance(40); await flush();
    assert.equal(session.state.objects.find(object => object.blockId === "player").x, 2);
    if (action === "open") session.open(destination); else await session[action]();
    await moving; c.advance(1000);
    assert.deepEqual(session.state, action === "open" ? engine.createState(destination) : initial);
    assert.equal(session.running, false); assert.equal(session.moves, 0); assert.equal(c.frames.size, 0);
  }
});

test("switching view or disabling tweens finishes ASCII at the latest exact frame without replaying every missed tick", async () => {
  const c = clock(), shown = [], active = room(state(0).objects);
  const frames = [1, 2, 3].map(state);
  let finish = false;
  const pending = animateAsciiCommand({ state: state(0), room: active, simulation: { frames, final: frames.at(-1) },
    presentFrame: frame => shown.push(frame) }, { definitions, ...c.options, finish: () => finish });
  finish = true; c.advance(1); await pending;
  assert.equal(shown.length, 1); assert.equal(shown[0].state, frames.at(-1)); assert.equal(c.frames.size, 0);
});
