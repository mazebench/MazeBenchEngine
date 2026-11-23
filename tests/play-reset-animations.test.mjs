import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCommandTimeline, createResetTimeline, captureTimeline, sampleTrack, groupMovingTracks } from "../animations/v1/timeline.mjs";
import { PlaySessionV1 } from "../play/current/play-session.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { clonePlayState, presentationIdentities } from "../play/current/presentation-identity.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";

const definitions = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const cell = (blockId, x, y = 1, z = 0, extra = {}) => ({ blockId, x, y, z, ...extra });
const state = objects => ({ width: 8, height: 4, objects });
const room = (objects, columnIndex = 0) => ({ ...state(objects), fileName: `${columnIndex}.json`, columnIndex, rowIndex: 0 });
const floor = () => Array.from({ length: 32 }, (_, i) => cell("floor", i % 8, Math.floor(i / 8)));
const enginePromise = readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url))
  .then(bytes => instantiateMazeBenchEngineV1(bytes));
const tracked = (timeline, blockId) => timeline.tracks.find(track => track.block.id === blockId);

// Same block types deliberately have different returns: merging them by their
// old forward path would make both objects incorrectly follow the first one.
test("reset eases objects and mechanisms home, restores hidden objects and keeps independent return paths", () => {
  const objects = [cell("player", 1), cell("crate", 2), cell("crate", 6),
    cell("gate", 3), cell("lift", 4), cell("puncher", 5, 2, 0, { orientation: "right" }),
    cell("orange-wall", 6, 2), cell("gem", 7)];
  const resetState = state(objects), active = room(objects);
  const current = state(objects.map(object => ({ ...object,
    x: object.blockId === "player" ? 5 : object.blockId === "crate" ? 4 : object.x,
    stateId: ["gate", "lift", "puncher"].includes(object.blockId) ? 1 : 0,
    z: object.blockId === "orange-wall" ? -2 : object.z,
    engineHidden: object.blockId === "gem" })));
  const saved = structuredClone({ current, resetState });
  const result = createResetTimeline({ state: current, resetState, room: active, definitions });
  assert.equal(result.duration, 250);
  assert.equal(sampleTrack(tracked(result, "player"), 62.5).x, 4.5, "long returns also ease");
  for (const kind of ["gate", "lift", "puncher"]) assert.equal(sampleTrack(tracked(result, kind), 125).phase, .5);
  assert.equal(sampleTrack(tracked(result, "orange-wall"), 125).z, -1);
  assert.equal(sampleTrack(tracked(result, "gem"), 125).opacity, .5);
  const crates = result.tracks.filter(track => track.block.id === "crate");
  assert.equal(sampleTrack(crates[0], 125).x, 3);
  assert.equal(sampleTrack(crates[1], 125).x, 5);
  assert(!groupMovingTracks(result.tracks).some(group => crates.every(track => group.includes(track))));
  assert.deepEqual({ current, resetState }, saved, "engine snapshots stay untouched");
});

test("reset during a command or another reset starts at the displayed fractional pose", () => {
  const objects = [cell("player", 1), cell("lift", 3)];
  const initial = state(objects), active = room(objects);
  const final = state([cell("player", 2), cell("lift", 3, 1, 0, { stateId: 1 })]);
  const forward = createCommandTimeline({ state: initial, room: active, definitions,
    simulation: { frames: [final], final } });
  const first = createResetTimeline({ state: initial, resetState: initial, room: active, definitions,
    snapshot: captureTimeline(forward, 25) });
  assert.equal(sampleTrack(tracked(first, "player"), 0).x, 1.125);
  assert.equal(sampleTrack(tracked(first, "lift"), 0).phase, .125);
  const second = createResetTimeline({ state: initial, resetState: initial, room: active, definitions,
    snapshot: captureTimeline(first, 100) });
  assert.deepEqual(sampleTrack(tracked(second, "player"), 0), sampleTrack(tracked(first, "player"), 100));
  assert.equal(sampleTrack(tracked(second, "player"), 250).x, 1);
});

test("real collection and projection retain return identities across commands, clones, and undo", async () => {
  const engine = await enginePromise;
  const source = room([...floor(), cell("player", 1), cell("gem", 2), cell("crate", 3)]);
  const connected = new ConnectedWorldSessionV1(engine, definitions, [source], { presentation: true });
  const initial = engine.createState(source);
  const first = await connected.simulateCommand(initial, source, "right");
  const second = await connected.simulateCommand(clonePlayState(first.final), source, "right");
  const result = createResetTimeline({ state: clonePlayState(second.final), resetState: initial, room: source, definitions });
  const crate = tracked(result, "crate"), gem = tracked(result, "gem");
  assert.equal(sampleTrack(crate, 0).x, 4);
  assert.equal(sampleTrack(crate, 250).x, 3);
  assert.equal(sampleTrack(gem, 0).opacity, 0);
  assert.equal(sampleTrack(gem, 125).opacity, .5);
  assert.equal(sampleTrack(gem, 250).x, 2);
  assert.equal(new Set(result.tracks.map(track => track.key)).size, result.tracks.length);
  const session = new PlaySessionV1(engine, definitions, { frameDelay: 0,
    resolveCommand: (s, r, d) => connected.simulateCommand(s, r, d) });
  session.open(source);
  await session.move("right");
  const keys = presentationIdentities(session.state, source);
  await session.move("right");
  session.undo();
  assert.deepEqual(presentationIdentities(session.state, source), keys);
});

test("departed rooms return to authored state while the player finishes in the next room", async () => {
  const engine = await enginePromise;
  const source = room([...floor(), cell("player", 7), cell("crate", 2, 2), cell("gem", 3, 2)]);
  const destination = room(floor(), 1);
  const connected = new ConnectedWorldSessionV1(engine, definitions, [source, destination], { presentation: true });
  const initial = engine.createState(source);
  initial.objects.find(object => object.blockId === "crate").x = 5;
  initial.objects.find(object => object.blockId === "gem").engineHidden = true;
  const simulation = await connected.simulateCommand(initial, source, "right");
  assert.equal(simulation.room, destination);
  const result = createCommandTimeline({ state: initial, room: source, simulation, definitions });
  const crate = tracked(result, "crate");
  const back = crate.motion.at(-1);
  assert.equal(back.end - back.start, 250);
  assert.equal(sampleTrack(crate, (back.start + back.end) / 2).x, 3.5);
  assert.equal(sampleTrack(crate, result.duration).x, 2);
  assert.equal(sampleTrack(tracked(result, "gem"), result.duration).opacity, 1);
  assert.equal(sampleTrack(tracked(result, "player"), result.duration).x, 8);
  assert.equal(result.tracks.filter(track => track.block.roleId === "player").length, 1);
});

test("animated reset commits exact state immediately, can be superseded, and drains input after completion", async () => {
  const engine = await enginePromise;
  const source = room([...floor(), cell("player", 1)]), destination = room([...floor(), cell("player", 4)], 1);
  const connected = new ConnectedWorldSessionV1(engine, definitions, [source, destination], { presentation: true });
  let complete, calls = 0, rendered = null;
  const session = new PlaySessionV1(engine, definitions, {
    resolveCommand: (s, r, d) => connected.simulateCommand(s, r, d),
    animateCommand: () => ({}),
    animateReset: ({ signal }) => new Promise(resolve => {
      calls++; complete = resolve; signal.addEventListener("abort", () => resolve(false));
    }), onFrame: (s, r) => { rendered = r; }
  });
  session.open(source); await session.move("right");
  const resetting = session.reset();
  assert.deepEqual(session.state, engine.createState(source));
  assert.equal(session.moves, 0); assert.equal(session.history.length, 0); assert.equal(session.running, true);
  session.open(destination); await resetting;
  assert.equal(rendered, destination); assert.equal(session.room, destination); assert.equal(session.running, false);
  session.open(source); await session.move("right");
  const next = session.reset(); session.move("right"); complete({}); await next;
  // drain continues asynchronously after the completed reset.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.state.objects.find(object => object.blockId === "player").x, 2);
  assert.equal(session.moves, 1);
  session.setFrameDelay(0); await session.reset();
  assert.equal(calls, 2, "disabled tweens never start reset animations");
});

test("Reset after entry restores that visit's entry state, not the room's authored spawn", async () => {
  const engine = await enginePromise;
  const source = room([...floor(), cell("player", 7)]), destination = room([...floor(), cell("player", 5)], 1);
  const connected = new ConnectedWorldSessionV1(engine, definitions, [source, destination], { presentation: true });
  let result;
  const session = new PlaySessionV1(engine, definitions, {
    resolveCommand: (s, r, d) => connected.simulateCommand(s, r, d), animateCommand: () => ({}),
    animateReset: reset => { result = createResetTimeline({ ...reset, definitions }); }
  });
  session.open(source); await session.move("right"); await session.move("right");
  await session.reset();
  assert.equal(session.room, destination);
  assert.equal(session.state.objects.find(object => object.blockId === "player").x, 0);
  assert.equal(sampleTrack(tracked(result, "player"), result.duration).x, 8);
  assert.equal(result.tracks.filter(track => track.block.roleId === "player").length, 1);
});
