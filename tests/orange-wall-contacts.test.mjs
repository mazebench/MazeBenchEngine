import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../render/vendor/three.module.min.js";
import { surfaceContactEdges } from "../ui/joined-voxel-surface.mjs";
import { AnimatedWallContacts, contactShape, worldContactShapes } from "../ui/orange-wall-contacts.mjs";
import { ThickEdges } from "../ui/thick-edges.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { createCommandTimeline } from "../animations/v1/timeline.mjs";
import { PlayWorldRenderer } from "../ui/play-world-renderer.mjs";
import { instantiateMazeBenchEngineV1 } from "../engine/current/engine.mjs";
import { decodeVoxelRoom } from "../render/v1/voxel-world-v2.mjs";
import { createPlayWorldContext } from "../ui/play-world-context.mjs";

const segments = positions => Array.from({ length: positions.length / 6 }, (_, i) => positions.slice(i * 6, i * 6 + 6));
const floor = (x = 0, z = 0) => ({ position: [x, -.34375, z], size: [1, .34375, 1] });
const atFloor = positions => segments(positions).filter(p => Math.abs(p[1]) < 1e-7 && Math.abs(p[4]) < 1e-7);

test("animated contact buffers grow to the drawn contour and retain capacity on reverse seeks", () => {
  const walls = Array.from({ length: 32 }, (_, i) => ({
    track: { positions: [[i * 3, 0, -.5]] }, visible: i === 0, shape: { position: [i * 3, -.5, 0] }
  }));
  const supports = walls.map((wall, i) => ({ track: { positions: [[i * 3, 0, 0]] }, visible: true, shape: floor(i * 3) }));
  const root = new THREE.Group(), renderer = { totalWidth: 0, totalHeight: 0, thickEdges: new ThickEdges() };
  const contacts = new AnimatedWallContacts(renderer, root, walls, supports), geometry = contacts.mesh.geometry;
  contacts.update();
  const small = geometry.attributes.position;
  let released = 0; geometry.addEventListener("dispose", () => released++);
  walls.forEach(wall => { wall.visible = true; });
  contacts.update();
  const large = geometry.attributes.position, count = geometry.drawRange.count;
  assert.equal(contacts.mesh.geometry, geometry, "solid and ghost copies retain the same geometry object");
  assert.notEqual(small, large);
  assert.equal(released, 1, "old GPU attributes are released when growing");
  assert.equal(count, surfaceContactEdges(walls.map(wall => wall.shape), supports.map(support => support.shape)).length);
  assert(large.count >= count && large.count < count * 2);
  walls.forEach((wall, i) => { wall.visible = i === 0; });
  contacts.update();
  assert.equal(geometry.attributes.position, large);
  assert.equal(released, 1, "reverse seeking reuses the buffer");
  geometry.dispose(); contacts.mesh.material.dispose();
});

test("joined orange walls retain their floor intersection without tile seams at every lowering height", () => {
  for (const height of [-1, -.75, -.5, -.125]) {
    const walls = [0, 1].flatMap(x => [height, height + 1].map(y => ({ position: [x, y, 0] })));
    const edges = atFloor(surfaceContactEdges(walls, [floor(0), floor(1)]));
    assert.equal(edges.length, 6, `six perimeter segments, height ${height}`);
    assert(edges.every(p => !(p[0] === 1 && p[3] === 1)), "no line across the middle of the joined wall");
    assert.equal(edges.reduce((sum, p) => sum + Math.hypot(p[3] - p[0], p[5] - p[2]), 0), 6);
  }
  assert.deepEqual(surfaceContactEdges([{ position: [0, -2, 0] }], [floor()]), [], "fully buried walls add no floor outline");
});

test("flush lowered walls join across tiled floors without drawing the floors' internal sides", () => {
  for (const surface of [0, 2]) for (const bottom of [surface - 1, surface - .999, surface - .5, surface]) {
    const walls = Array.from({ length: 8 }, (_, x) => ({ position: [x, bottom, 0] }));
    const supports = Array.from({ length: 8 }, (_, x) => ({ position: [x, surface - .34375, 0], size: [1, .34375, 1] }));
    const edges = segments(surfaceContactEdges(walls, supports)).filter(p =>
      Math.abs(p[1] - surface) < 1e-7 && Math.abs(p[4] - surface) < 1e-7);
    assert(edges.every(p => !(p[0] === p[3] && p[0] > 0 && p[0] < 8)), `no internal seams at ${bottom}`);
    assert.equal(edges.reduce((sum, p) => sum + Math.hypot(p[3] - p[0], p[5] - p[2]), 0), 18,
      "the complete outer contact outline is preserved");
  }
});

test("a partly covered support edge keeps only its exposed ledge", () => {
  const walls = [0, 1].map(x => ({ position: [x, -1, 0] }));
  const partialNeighbor = { position: [1, -.34375, 0], size: [1, .34375, .5] };
  const seam = atFloor(surfaceContactEdges(walls, [floor(), partialNeighbor]))
    .filter(p => p[0] === 1 && p[3] === 1);
  assert.equal(seam.reduce((sum, p) => sum + Math.abs(p[5] - p[2]), 0), .5);
  assert(seam.every(p => Math.min(p[2], p[5]) >= .5), "covered half is hidden, real ledge remains");
});

test("orange ramps and elevated support surfaces get their actual cross section", () => {
  for (const direction of ["up", "down", "left", "right"]) {
    const edges = atFloor(surfaceContactEdges([{ position: [0, -.5, 0], direction }], [floor()]));
    assert.equal(edges.length, 4, direction);
    assert(edges.flat().some(value => Math.abs(value - .5) < 1e-7), "cross section follows the sloped face");
  }
  const raised = surfaceContactEdges([{ position: [0, 1.5, 0] }], [{ position: [0, 1, 0] }]);
  assert.equal(segments(raised).filter(p => p[1] === 2 && p[4] === 2).length, 4);
  const orange = { roleId: "orange-wall", visual: { kind: "cube" } };
  assert.equal(contactShape({ x: 0, y: 0, z: 0, engineHidden: true }, orange), null);
  assert.equal(contactShape({ x: 0, y: 0, z: 0 }, { ...orange, visual: { kind: "cube", orangeForm: "hidden" } }), null);
});

test("L×O LLLD keeps contact outlines on the floor through the tween and at rest", async () => {
  const manifestUrl = new URL("../level-data/v2/main-world/world.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  const definitions = new Map(manifest.blocks.map(block => [block.id, block]));
  const [fileName, position] = Object.entries(manifest.rooms).find(([, value]) => value.join("x") === "LxO");
  const room = { ...decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName, manifestUrl), "utf8"))),
    fileName, position, columnIndex: 0, rowIndex: 0 };
  const makeWorld = createPlayWorldContext({ ...manifest, blockDefinitions: definitions, columns: ["L"], rows: ["O"],
    roomWidth: room.width, roomHeight: room.height, rooms: [room] });
  const engine = await instantiateMazeBenchEngineV1(await readFile(new URL("../engine/current/voxel_physics.wasm", import.meta.url)));
  let state = engine.createState(room), lowering = null;
  for (const letter of "LLLD") {
    const simulation = await engine.simulateCommand(state, letter === "L" ? "left" : "down", definitions);
    const timeline = createCommandTimeline({ state, room, simulation, definitions });
    if (timeline.tracks.some(track => track.block.roleId === "orange-wall" && track.changed)) lowering = timeline;
    state = simulation.final;
  }
  assert(lowering, "sequence lowers the walls");
  const world = makeWorld(room);
  const renderer = Object.create(PlayWorldRenderer.prototype);
  Object.assign(renderer, { world, totalWidth: room.width, totalHeight: room.height, mode: "play", canvas: { dataset: {} },
    target: new THREE.Vector3(), scene: new THREE.Scene(), content: new THREE.Group(), cutawayContent: new THREE.Group(),
    renderer: { shadowMap: { enabled: false } }, cutaway: { height: 1, opacity: 0, followPlayer: false }, yaw: 0 });
  const animation = new CommandAnimationScene(renderer, lowering);
  const buffers = animation.wallContacts.map(contact => contact.mesh.geometry);
  const motion = lowering.tracks.find(track => track.block.roleId === "orange-wall" && track.changed).motion[0];
  for (const time of [.25, .5, .75, 1].map(t => motion.start + t * (motion.end - motion.start))) {
    animation.update(time); animation.beforeRender();
    let floorSegments = 0;
    for (const [index, contact] of animation.wallContacts.entries()) {
      assert.equal(contact.mesh.geometry, buffers[index], "geometry is retained");
      const geometry = contact.mesh.geometry, points = geometry.attributes.position;
      assert(geometry.drawRange.count <= points.count, "preallocated capacity covers all segments");
      for (let i = 0; i < geometry.drawRange.count; i += 6) {
        const y1 = points.getY(i) + contact.root.position.y, y2 = points.getY(i + 1) + contact.root.position.y;
        if (Math.abs(y1) < 1e-5 && Math.abs(y2) < 1e-5) floorSegments++;
      }
      assert(contact.mesh.material.clippingPlanes?.length, "Truncate clips contact lines too");
    }
    assert(floorSegments > 0, `floor contact during tween at ${time} ms`);
  }
  const finalWorld = { ...world, rooms: [{ ...room, objects: state.objects }] };
  const { walls, supports } = worldContactShapes(finalWorld);
  assert(atFloor(surfaceContactEdges(walls, supports)).length > 0, "settled renderer has the same contact outline");
  animation.dispose();
});

test("distant moving supports leave orange contours untouched; nearby supports match the full intersection", () => {
  const record = (shape, roleId = "solid") => ({ visible: true, shape, track: {
    positions: [[shape.position[0], shape.position[2], shape.position[1]]], block: { roleId }
  } });
  const walls = [0,1].map(x => record({ position: [x,-.5,0] }, "orange-wall"));
  const floors = Array.from({length:8},(_,x)=>Array.from({length:8},(_,z)=>record(floor(x,z)))).flat();
  const player = record({position:[7,0,7]}, "player");
  const root = new THREE.Group(), renderer = { totalWidth:0,totalHeight:0,thickEdges:new ThickEdges() };
  const contacts = new AnimatedWallContacts(renderer,root,walls,[...floors,player]);
  contacts.update();
  const position=contacts.mesh.geometry.attributes.position,version=position.version;
  player.shape.position=[6.5,0,7];contacts.update();
  assert.equal(position.version,version,"distant walking does not rewrite the contour buffer");
  const canonical = values => segments(values).map(segment=>segment.map(n=>Math.round(n*1e5)/1e5).join(",")).sort();
  for(const location of [[1,0,1],[1.5,-.25,0],[0,0,0],[.5,.5,0],[0,-1,0],[7,0,7]]) {
    player.shape.position=location;contacts.update();
    const expected=surfaceContactEdges(walls.map(r=>r.shape),[...floors,player].map(r=>r.shape));
    const actual=[],geometry=contacts.mesh.geometry,p=geometry.attributes.position;
    for(let i=0;i<geometry.drawRange.count;i+=6) actual.push(p.getX(i),p.getY(i),p.getZ(i),p.getX(i+1),p.getY(i+1),p.getZ(i+1));
    assert.deepEqual(canonical(actual),canonical(expected),`same contact edges at ${location}`);
  }
});
