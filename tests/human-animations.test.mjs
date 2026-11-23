import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../render/vendor/three.module.min.js";
import { createCommandTimeline, createResetTimeline, sampleTrack, sampleSegments, groupMovingTracks } from "../animations/v1/timeline.mjs";
import { playTimeline } from "../animations/v1/player.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { addAnimatedGem, collectAnimatedGems, updateAnimatedGems } from "../animations/v1/gems.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { PlaySessionV1 } from "../play/current/play-session.mjs";
import { ConnectedWorldSessionV1 } from "../play/current/connected-world-session.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { V2_BLOCK_CATALOG, V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";

const blocks = new Map(V2_BLOCK_CATALOG.map(block => [block.id, block]));
const cell = (blockId, x, y = 0, z = 0, extra = {}) => ({ blockId, x, y, z, ...extra });
const room = (objects, columnIndex = 0) => ({ fileName: `${columnIndex}.json`, columnIndex, rowIndex: 0, width: 8, height: 4, objects });
const state = objects => ({ width: 8, height: 4, objects });

test("idle gems spin and bob without rebuilding geometry, including frozen backgrounds and ghost copies", () => {
  const root = new THREE.Group();
  const record = { x: 2, z: 3, source: {}, definition: { bottom: 1 } };
  const dimensions = { totalWidth: 8, totalHeight: 4 };
  addAnimatedGem(root, record, dimensions);
  const gem = collectAnimatedGems(root)[0], ghost = gem.clone(true);
  const original = { ...gem.userData.gemMotion };
  const geometry = gem.children.map(child => child.geometry);
  gem.matrixAutoUpdate = false;
  for (const time of [0, 800, 1600, 3200, 6000, 12000]) {
    updateAnimatedGems([gem, ghost], time);
    assert(Math.abs(gem.position.y - original.height) <= .06);
    assert.deepEqual(gem.position.toArray(), ghost.position.toArray());
    assert(gem.quaternion.angleTo(ghost.quaternion) < 1e-7);
    assert.equal(gem.matrix.elements[13], gem.position.y, "frozen background transforms update");
    assert.deepEqual(gem.children.map(child => child.geometry), geometry);
    assert.deepEqual(gem.userData.gemMotion, original);
    if (time === 6000) assert(Math.abs(gem.rotation.y - original.yaw - Math.PI) < 1e-10);
    if (time === 12000) assert.equal(gem.rotation.y, original.yaw);
  }
  updateAnimatedGems([gem], 1234);
  const replacement = new THREE.Group();
  addAnimatedGem(replacement, record, dimensions);
  updateAnimatedGems(collectAnimatedGems(replacement), 1234);
  assert.deepEqual(replacement.children[0].position.toArray(), gem.position.toArray(), "rebuilds retain the bob phase");
  assert.deepEqual(replacement.children[0].quaternion.toArray(), gem.quaternion.toArray(), "rebuilds retain the rotation phase");
  updateAnimatedGems([gem], 1234, false);
  assert.equal(gem.position.y, original.height);
  assert.equal(gem.rotation.y, original.yaw);
});

function timeline(objects, frames, options = {}) {
  return createCommandTimeline({ state: state(objects), room: room(objects), definitions: blocks,
    simulation: { frames: frames.map(state), final: state(frames.at(-1)), direction: "right" }, ...options });
}

test("single moves ease; uninterrupted slides merge and stay linear through intermediate cells", () => {
  const single = timeline([cell("player", 0)], [[cell("player", 1)]]);
  assert.equal(single.duration, 100);
  assert.equal(sampleTrack(single.tracks[0], 25).x, 0.125);
  assert.equal(sampleTrack(single.tracks[0], 75).x, 0.875);
  const slide = timeline([cell("player", 0)], [1, 2, 3].map(x => [cell("player", x)]));
  assert.equal(slide.duration, 120);
  assert.equal(slide.tracks[0].motion.length, 1);
  assert.equal(sampleTrack(slide.tracks[0], 10).x, 0.25);
  assert.equal(sampleTrack(slide.tracks[0], 50).x, 1.25);
  assert.equal(sampleTrack(slide.tracks[0], 120).x, 3);
  const ramp = timeline([cell("player", 0)], [[cell("player", 1, 0, 1)], [cell("player", 2, 0, 1)]]);
  assert.equal(sampleTrack(ramp.tracks[0], 10).x, 0.25);
  assert.equal(sampleTrack(ramp.tracks[0], 10).z, 0.25);
  assert.equal(sampleTrack(ramp.tracks[0], 50).x, 1.25);
});

test("turns, reversals, and pauses split tracks; joined rigid cubes and slopes move together", () => {
  const object = (x, y) => cell("player", x, y);
  const turned = timeline([object(0, 0)], [[object(1, 0)], [object(1, 1)], [object(0, 1)]]);
  assert.equal(turned.tracks[0].motion.length, 3);
  assert.deepEqual([sampleTrack(turned.tracks[0], 150).x, sampleTrack(turned.tracks[0], 150).y], [1, 0.5]);
  const body = x => [cell("weightless-box", x), cell("weightless-slope", x + 1), cell("player", x + 2)];
  assert.equal(groupMovingTracks(timeline(body(0), [body(1), body(2)]).tracks).length, 1);
  const paused = timeline([object(0, 0), cell("gate", 3)], [
    [object(1, 0), cell("gate", 3)], [object(1, 0), cell("gate", 3, 0, 0, { stateId: 1 })],
    [object(2, 0), cell("gate", 3, 0, 0, { stateId: 1 })]
  ]);
  assert.equal(paused.tracks[0].motion.length, 2);
  assert.equal(sampleTrack(paused.tracks[0], 150).x, 1);
});

test("disappearing actors continue one step along their motion and fade, without following sentinel coordinates", () => {
  const initial = [cell("player", 1), cell("gem", 3)];
  const frames = [[cell("player", 2), cell("gem", 3)], [cell("player", -1, -1, -2147483648), cell("gem", -1, -1)]];
  const original = structuredClone({ initial, frames });
  const result = timeline(initial, frames);
  assert.equal(sampleTrack(result.tracks[0], 60).x, 2.5);
  assert.equal(sampleTrack(result.tracks[0], 60).opacity, 0.5);
  assert.equal(sampleTrack(result.tracks[0], 80).x, 3);
  assert.equal(sampleTrack(result.tracks[0], 80).opacity, 0);
  assert.equal(sampleTrack(result.tracks[1], 60).x, 3, "stationary gem fades in place");
  assert.deepEqual({ initial, frames }, original);
});

test("all mechanisms interpolate both directions, including vertical orange-wall movement", () => {
  for (const blockId of ["puncher", "gate", "lift"]) {
    const result = timeline([cell(blockId, 1, 0, 0, { stateId: 0 })], [
      [cell(blockId, 1, 0, 0, { stateId: 1 })], [cell(blockId, 1, 0, 0, { stateId: 0 })]
    ]);
    assert.equal(sampleTrack(result.tracks[0], 50).phase, 0.5, blockId);
    assert.equal(sampleTrack(result.tracks[0], 100).phase, 1, blockId);
    assert.equal(sampleTrack(result.tracks[0], 150).phase, 0.5, blockId);
  }
  const orange = timeline([cell("orange-wall", 1, 0, 0)], [[cell("orange-wall", 1, 0, -1, { mechanismDepth: 1 })]]);
  assert.equal(sampleTrack(orange.tracks[0], 50).z, -0.5);
});

test("cycle rollback is not animated as another move and empty ticks do not slow playback", () => {
  const initial = state([cell("player", 0)]);
  const result = createCommandTimeline({ state: initial, room: room(initial.objects), definitions: blocks,
    simulation: { direction: "right", final: initial, cycle: { onCycle: "rollback-command" },
      frames: [initial, state([cell("player", 1)]), state([cell("player", 2)]), initial] } });
  assert.equal(result.duration, 80);
  assert.equal(sampleTrack(result.tracks[0], result.duration).x, 2);
  assert.equal(result.tracks[0].motion.length, 1);
  const blocked = createCommandTimeline({ state: initial, room: room(initial.objects), definitions: blocks,
    simulation: { direction: "left", final: initial, frames: [initial, initial] } });
  assert.equal(blocked.duration, 0);
});

function fakeClock() {
  let now = 0, next = 0;
  const callbacks = new Map();
  return { callbacks, options: {
    now: () => now,
    requestFrame: callback => { callbacks.set(++next, callback); return next; },
    cancelFrame: id => callbacks.delete(id)
  }, advance(time) { now = time; const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time)); } };
}

test("display-clock playback cancels promptly and never publishes an abandoned frame", async () => {
  const clock = fakeClock(), signal = new AbortController(), frames = [];
  const pending = playTimeline({ duration: 100 }, time => frames.push(time), { ...clock.options, signal: signal.signal });
  clock.advance(25);
  signal.abort();
  assert.equal(await pending, false);
  clock.advance(100);
  assert.deepEqual(frames, [0, 25]);
  assert.equal(clock.callbacks.size, 0);
  const completed = playTimeline({ duration: 100 }, time => frames.push(time), { ...clock.options, finish: () => true });
  assert.equal(await completed, true);
  assert.equal(frames.at(-1), 100);
});

async function realFixture() {
  const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));
  const source = room([...Array.from({ length: 8 }, (_, x) => cell("ice-floor", x)), cell("player", 6)]);
  const destination = room([...Array.from({ length: 8 }, (_, x) => cell("floor", x))], 1);
  return { engine, source, destination, connected: new ConnectedWorldSessionV1(engine, blocks, [source, destination], { presentation: true }) };
}

test("actual mechanism ticks keep lift passengers aligned and show punch extension/retraction", async () => {
  const { engine } = await realFixture();
  for (const kind of ["lift", "gate", "puncher", "orange-wall"]) {
    const objects = [
      ...Array.from({ length: 64 }, (_, i) => cell("floor", i % 8, Math.floor(i / 8))),
      cell("player", 1, 4),
      cell(kind === "orange-wall" ? "orange-button" : kind, 1, kind === "gate" ? 2 : 3, 0,
        { orientation: kind === "puncher" ? "right" : "top", stateId: 0 })
    ];
    if (kind === "orange-wall") objects.push(cell(kind, 3, 3, 0, { stateId: 1, mechanismDepth: 0 }));
    const source = { ...room(objects), height: 8 };
    const initial = engine.createState(source);
    const simulation = await engine.simulateCommand(initial, "up", blocks);
    const result = createCommandTimeline({ state: initial, room: source, simulation, definitions: blocks });
    const mechanism = result.tracks.find(track => track.object.blockId === kind);
    const extension = kind === "orange-wall" ? mechanism.motion[0] : mechanism.phases[0];
    const midpoint = (extension.start + extension.end) / 2;
    const mid = sampleTrack(mechanism, midpoint);
    if (kind === "orange-wall") assert.equal(mid.z, -0.5);
    else assert.equal(mid.phase, 0.5, kind);
    if (kind === "lift") {
      const passenger = result.tracks.find(track => track.block.roleId === "player");
      assert.equal(sampleTrack(passenger, midpoint).z, mid.phase);
    }
    if (kind === "puncher") {
      assert.equal(mechanism.phases.length, 2);
      assert.equal(sampleTrack(mechanism, (mechanism.phases[1].start + mechanism.phases[1].end) / 2).phase, 0.5);
      assert.equal(sampleTrack(mechanism, result.duration).phase, 0);
    }
  }
});

test("real C++ seam slides keep stable object identities, global movement and a smooth room camera", async () => {
  const { engine, source, destination, connected } = await realFixture();
  const initial = engine.createState(source);
  const simulation = await connected.simulateCommand(initial, source, "right");
  assert.equal(simulation.room, destination);
  const snapshot = structuredClone(simulation);
  const result = createCommandTimeline({ state: initial, room: source, simulation, definitions: blocks });
  const player = result.tracks.find(track => track.block.roleId === "player");
  assert.equal(player.motion.length, 1);
  assert.equal(player.positions[0][0], 6);
  assert.equal(player.positions.at(-1)[0], 8);
  assert.equal(sampleTrack(player, 60).x, 7.5);
  assert.ok(result.camera.length);
  const transition = result.camera[0];
  assert.equal(transition.end - transition.start, 250);
  const mid = sampleSegments(result.camera, [0, 0], (transition.start + transition.end) / 2, { alwaysEase: true });
  assert.deepEqual(mid, [4, 0]);
  assert.deepEqual(sampleSegments(result.camera, [0, 0], result.duration), [8, 0]);
  assert.deepEqual(simulation, snapshot, "visual compilation cannot change physics frames");
  const headless = new ConnectedWorldSessionV1(engine, blocks, [source, destination]);
  const ordinary = await headless.simulateCommand(initial, source, "right");
  assert.equal(ordinary.presentation, undefined, "headless consumers never opt into presentation data");
  assert.deepEqual(ordinary.final, simulation.final);
});

test("mid-tween undo/reset/room selection cancels on the first command and cannot overwrite the replacement state", async () => {
  for (const action of ["undo", "reset", "open"]) {
    const { engine, source, destination, connected } = await realFixture();
    let began;
    const ready = new Promise(resolve => { began = resolve; });
    const session = new PlaySessionV1(engine, blocks, {
      resolveCommand: (state, room, direction) => connected.simulateCommand(state, room, direction),
      animateCommand: ({ signal }) => new Promise(resolve => {
        signal.addEventListener("abort", () => resolve(false), { once: true }); began();
      })
    });
    session.open(source);
    const initial = structuredClone(session.state);
    const move = session.move("right");
    await ready;
    assert.equal(session.moves, 0);
    assert.deepEqual(session.state, initial, "canonical state stays exact during presentation");
    if (action === "open") session.open(destination); else session[action]();
    await move;
    assert.deepEqual(session.state, action === "open" ? engine.createState(destination) : initial, action);
    assert.equal(session.running, false);
    assert.equal(session.pendingMove, null);
    assert.equal(session.history.length, 0);
  }
});

test("tween completion and instant mode produce identical history, final room and undo", async () => {
  const { engine, source, destination, connected } = await realFixture();
  let calls = 0;
  const session = new PlaySessionV1(engine, blocks, {
    resolveCommand: (state, room, direction) => connected.simulateCommand(state, room, direction),
    animateCommand: () => { calls++; return { preserveCameraPosition: true }; }
  });
  session.open(source);
  await session.move("right");
  const expected = structuredClone(session.state);
  assert.equal(session.room, destination);
  assert.equal(session.moves, 1);
  assert.equal(calls, 1);
  session.undo();
  assert.equal(session.room, source);
  session.setFrameDelay(0);
  await session.move("right");
  assert.deepEqual(session.state, expected);
  assert.equal(session.moves, 1);
  assert.equal(calls, 1, "zero delay never starts a tween");
});

test("declining 3D animation preserves cancellable discrete ASCII ticks", async () => {
  const { engine, source, connected } = await realFixture();
  let cancel = false, restored = false, session;
  session = new PlaySessionV1(engine, blocks, {
    frameDelay: 1,
    resolveCommand: (state, room, direction) => connected.simulateCommand(state, room, direction),
    animateCommand: () => false,
    onFrame: () => {
      if (!cancel) return;
      cancel = false;
      restored = session.undo();
    }
  });
  session.open(source);
  const initial = structuredClone(session.state);
  cancel = true;
  await session.move("right");
  assert.equal(restored, true);
  assert.deepEqual(session.state, initial);
  assert.equal(session.moves, 0);
  assert.equal(session.running, false);
});

test("animation scene morphs real mechanism geometry without rebuilding or reallocating it per frame", () => {
  const initial = [cell("player", 0), cell("gem", 1), cell("gate", 2), cell("lift", 3), cell("puncher", 4, 0, 0, { orientation: "right" }),
    cell("lift", 5, 0, 0, { orientation: "east" }), cell("orange-wall", 6)];
  const final = initial.map(object => ({ ...object, stateId: 1,
    x: object.blockId === "player" ? 1 : object.x, z: object.blockId === "orange-wall" ? -1 : object.z }));
  const result = timeline(initial, [final]);
  const active = room(initial);
  const world = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A"], rows: ["A"], roomWidth: 8,
    roomHeight: 4, blockDefinitions: blocks, rooms: [active] })(active);
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { world, totalWidth: 8, totalHeight: 4, mode: "play", canvas: { dataset: {} },
    target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
    renderer: { shadowMap: { enabled: true } }, cutaway: { height: 1, opacity: 0.2, followPlayer: false }, yaw: 0 });
  const animation = new CommandAnimationScene(renderer, result);
  const geometries = [];
  animation.root.traverse(object => { if (object.geometry) geometries.push(object.geometry); });
  const gate = animation.actors.find(actor => actor.tracks[0].object.blockId === "gate");
  const bounds = () => { gate.root.children[0].geometry.computeBoundingBox(); return gate.root.children[0].geometry.boundingBox.getSize(new THREE.Vector3()).y; };
  const low = bounds();
  updateAnimatedGems(animation.gems, 1500);
  animation.update(50); animation.beforeRender();
  assert.equal(animation.gems.length, 1);
  const upperGem = collectAnimatedGems(animation.upper)[0];
  assert.deepEqual(upperGem.position.toArray(), animation.gems[0].position.toArray(), "command and Truncate copies bob together");
  assert.deepEqual(upperGem.quaternion.toArray(), animation.gems[0].quaternion.toArray());
  const middle = bounds();
  const lift = animation.actors.find(actor => actor.tracks[0].object.blockId === "lift");
  const marker = lift.root.children.find(object => object.userData.liftMarker);
  assert.equal(marker.rotation.y, Math.PI / 2, "lift marker rotates intact through the half-open state");
  animation.update(100); animation.beforeRender();
  assert.ok(low < middle && middle < bounds());
  const after = []; animation.root.traverse(object => { if (object.geometry) after.push(object.geometry); });
  assert.deepEqual(after, geometries);
  assert.equal(renderer.content.visible, false);
  assert.equal(animation.upper.visible, true);
  let disposed = 0;
  for (const geometry of geometries.filter(geometry => !geometry.userData.persistentGeometry)) geometry.addEventListener("dispose", () => disposed++);
  animation.dispose();
  assert.ok(disposed > 0);
  assert.equal(renderer.content.visible, true);
  assert.equal(renderer.scene.children.length, 0);
});

test("Truncate retains coplanar block tops while following fractional player heights without rebuilding", () => {
  const initial = [cell("player", 0, 0, 1), cell("wall", 2, 0, 1), cell("wall", 2, 0, 2)];
  const final = [cell("player", 0, 0, 2), ...initial.slice(1)];
  const active = room(initial);
  const world = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A"], rows: ["A"], roomWidth: 8,
    roomHeight: 4, blockDefinitions: blocks, rooms: [active] })(active);
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { world, totalWidth: 8, totalHeight: 4, mode: "play", canvas: { dataset: {} },
    target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: 2, opacity: .2, followPlayer: false }, yaw: 0 });
  const animation = new CommandAnimationScene(renderer, timeline(initial, [final]));
  const geometry = []; animation.root.traverse(object => { if (object.geometry) geometry.push(object.geometry); });
  for (const followPlayer of [false, true]) {
    renderer.cutaway.followPlayer = followPlayer;
    for (const time of [0, 50, 100, 50, 0]) {
      animation.update(time); animation.beforeRender();
      const height = followPlayer ? JSON.parse(renderer.canvas.dataset.motionPlayer).z + 1 : 2;
      const top = new THREE.Vector3(100, height, -100);
      assert(animation.lowerPlane.distanceToPoint(top) < 0, "coplanar originals are replaced by closed cut surfaces");
      assert(animation.upperPlane.distanceToPoint(top) < -.001, "ghost faces cannot overlap the retained top");
      assert(animation.edgePlane.distanceToPoint(top) < -.001, "bottom edges on the hidden next layer are excluded");
      assert(animation.caps.some(caps => [...caps.groups.values()].some(group => group.surface.geometry.drawRange.count > 0)),
        "a filled cross section remains during fractional-height motion");
      assert(animation.lowerPlane.distanceToPoint(top.clone().add(new THREE.Vector3(0, .003, 0))) < 0,
        "the clearance must not reveal upper layers");
      const after = []; animation.root.traverse(object => { if (object.geometry) after.push(object.geometry); });
      assert.deepEqual(after, geometry, "seeking and changing the clip height retain geometry");
    }
  }
  renderer.cutaway = { height: null, opacity: 0, followPlayer: false };
  animation.beforeRender();
  assert.equal(animation.lowerPlane.constant, 1e6);
  assert.equal(animation.upper.visible, false);
  animation.dispose();
});

test("fade-out and reset fade-in keep opaque surfaces depth-writing with the same mask on their outlines", () => {
  const objects = [cell("weightless-box", 2, 2)], active = room(objects);
  const hidden = state(objects.map(object => ({ ...object, engineHidden: true })));
  const context = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A"], rows: ["A"],
    roomWidth: 8, roomHeight: 4, blockDefinitions: blocks, rooms: [active] });
  for (const reset of [false, true]) {
    const result = reset ? createResetTimeline({ state: hidden, resetState: state(objects), room: active, definitions: blocks })
      : createCommandTimeline({ state: state(objects), room: active, definitions: blocks, simulation: { frames: [hidden], final: hidden } });
    const renderer = Object.create(PlayWorldRenderer.prototype);
    Object.assign(renderer, { world: context(active), totalWidth: 8, totalHeight: 4, mode: "play", canvas: { dataset: {} },
      target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
      renderer: { shadowMap: { enabled: true } }, cutaway: { height: 1, opacity: .2, followPlayer: false }, yaw: 0 });
    const animation = new CommandAnimationScene(renderer, result);
    animation.update(result.duration / 2); animation.beforeRender();
    const part = animation.parts[1];
    assert.equal(part.coverage.value, .5);
    const faces = part.lowerMaterials.filter(({ source }) => source.depthWrite);
    assert(faces.length > 0);
    for (const { source, material } of faces) {
      assert.equal(material.transparent, false, "fading solid faces must stay in the opaque depth pass");
      assert.equal(material.depthWrite, true);
      assert.equal(material.opacity, source.opacity, "surface alpha must not expose rear faces");
    }
    const versions = [...part.lowerMaterials, ...part.upperMaterials].map(({ material }) => {
      const shader = { uniforms: {}, vertexShader: "#include <project_vertex>",
        fragmentShader: "#include <clipping_planes_fragment>\n#include <opaque_fragment>" };
      material.onBeforeCompile(shader);
      assert.equal(shader.uniforms.mazeFadeCoverage, part.coverage, "faces, outlines and ghosts share coverage");
      return material.version;
    });
    animation.update(result.duration * .75); animation.beforeRender();
    assert.equal(part.coverage.value, reset ? .875 : .125);
    assert.deepEqual([...part.lowerMaterials, ...part.upperMaterials].map(({ material }) => material.version), versions,
      "fading changes uniforms without recompiling materials");
    for (const { source, material } of part.upperMaterials) assert.equal(material.opacity, source.opacity * .2);
    animation.dispose();
  }
});

test("fast multi-room travel retargets camera and lighting without changing an earlier easing curve", () => {
  const rooms = Array.from({ length: 4 }, (_, i) => ({ ...room([], i), width: 1, height: 1 }));
  const initial = { width: 4, height: 1, objects: [cell("player", 0)] };
  const frames = [1, 2, 3].map(x => ({ ...initial, objects: [cell("player", x)] }));
  const result = createCommandTimeline({ state: { ...initial, width: 1 }, room: rooms[0], definitions: blocks,
    simulation: { direction: "right", frames, final: frames.at(-1),
      animationFrames: frames.map((state, i) => ({ state, room: rooms[i + 1] })),
      presentation: { initial, frames, rooms, originX: 0, originY: 0 } } });
  assert.deepEqual(result.times, [0, 40, 80, 120]);
  assert.deepEqual(result.camera.map(segment => segment.end - segment.start), [250, 250, 250]);
  assert.equal(result.duration, 330, "room transitions overlap rather than pausing at every seam");
  const beforeRetarget = sampleSegments(result.camera, [0, 0], 39, { alwaysEase: true });
  assert.deepEqual(beforeRetarget, sampleSegments([result.camera[0]], [0, 0], 39, { alwaysEase: true }));
  assert.deepEqual(sampleSegments(result.camera, [0, 0], 40, { alwaysEase: true }), result.camera[1].from);
  assert.deepEqual(sampleSegments(result.camera, [0, 0], 330, { alwaysEase: true }), [3, 0]);
  const middle = sampleSegments(result.lighting, result.initialLight, 125, { alwaysEase: true });
  assert(middle.filter(weight => weight > 0 && weight < 1).length > 1);
  assert(Math.abs(middle.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.deepEqual(sampleSegments(result.lighting, result.initialLight, 330, { alwaysEase: true }), [0, 0, 0, 1]);
});

test("a tween preserves the settled room-border outlines instead of revealing temporary room boxes", async () => {
  const initial = [cell("wall", 7), cell("player", 2, 2)];
  const source = room(initial), neighbor = room([cell("wall", 0)], 1);
  const context = createPlayWorldContext({ storageFormat: V2_WORLD_FORMAT, columns: ["A", "B"], rows: ["A"],
    roomWidth: 8, roomHeight: 4, blockDefinitions: blocks, rooms: [source, neighbor] });
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { canvas: { dataset: {} }, mode: "play", pickVoxels: false,
    scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(), placementPreview: new THREE.Group(),
    target: new THREE.Vector3(), cameraMotion: {}, renderer: { shadowMap: { enabled: false } },
    cutaway: { height: null, opacity: 0, followPlayer: false }, render() {}, requestModels() {}, yaw: 0 });
  renderer.setWorld(context(source), { preserveCamera: true });
  await renderer.backgroundReady;
  const seamLines = root => {
    const lines = new Set();
    root.traverse(object => {
      if (!object.visible || !object.userData.mazeWideOutline) return;
      const a = object.geometry.attributes.position, b = object.geometry.attributes.lineOther;
      for (let i = 0; i < Math.min(a.count, object.geometry.drawRange.count); i++) if (Math.abs(a.getX(i)) < 1e-6 && Math.abs(b.getX(i)) < 1e-6) {
        lines.add([[a.getX(i), a.getY(i), a.getZ(i)], [b.getX(i), b.getY(i), b.getZ(i)]].map(p => p.join(",")).sort().join(":"));
      }
    });
    return [...lines].sort();
  };
  const settled = seamLines(renderer.content);
  assert.deepEqual(settled, [], "matching wall faces have no room-border line");
  const final = initial.map(object => object.blockId === "player" ? { ...object, x: 3 } : object);
  const animation = new CommandAnimationScene(renderer, timeline(initial, [final]));
  for (const height of [null, 1]) for (const time of [0, 25, 50, 75, 100]) {
    renderer.cutaway.height = height;
    animation.update(time); animation.beforeRender();
    assert.deepEqual(seamLines(animation.root.children[0]), settled, `same outline at ${time} ms, ceiling ${height}`);
  }
  animation.dispose();
  assert.deepEqual(seamLines(renderer.content), settled);
});

test("stationary scenery uses one pose without changing slide or mechanism timing", () => {
  const terrain=Array.from({length:400},(_,i)=>cell("wall",i%8,Math.floor(i/8)%4,2+Math.floor(i/32)));
  const actor=cell("player",0),frames=[1,2,3].map(x=>[cell("player",x),...terrain.map(o=>({...o}))]);
  const full=timeline([actor,...terrain],frames),minimal=timeline([actor],frames.map(frame=>[frame[0]]));
  assert.deepEqual(full.times,minimal.times);assert.deepEqual(full.tracks[0],minimal.tracks[0]);
  assert(full.tracks.slice(1).every(track=>track.positions.length===1&&!track.changed));
  for(const time of [0,20,50,80,120]) assert.deepEqual(sampleTrack(full.tracks[0],time),sampleTrack(minimal.tracks[0],time));
});
