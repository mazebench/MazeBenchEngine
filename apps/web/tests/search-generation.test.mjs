import assert from "node:assert/strict";
import test from "node:test";

import {
  boxEntities,
  candidateSignature,
  exactBlockClusters,
  growGenericBox,
  growWallUpward,
  makeCandidate,
  mulberry32,
  mutateCandidate,
  relocateObjectives,
  reverseScrambleCandidate,
  shrinkGenericBox,
  shrinkStaticCluster,
} from "../public/search-worker.js";

const blocks = [
  { id: "floor", roleId: "floor" },
  { id: "wall", roleId: "solid" },
  { id: "ice", roleId: "ice" },
  { id: "player", roleId: "player" },
  { id: "gem", roleId: "goal" },
  { id: "weightless", roleId: "weightless-pushable" },
];

const configuration = {
  width: 16,
  depth: 16,
  layers: 16,
  collectibles: 1,
  minWeightlessBoxes: 4,
  maxWeightlessBoxes: 4,
  evolveHoles: true,
  blocks,
  roles: [],
  enabledBlockIds: blocks.map((block) => block.id),
  seed: 1,
};

test("search seeds distinct compact weightless polycubes into 3D terrain", () => {
  const candidate = makeCandidate(configuration, mulberry32(configuration.seed));
  const boxes = boxEntities(candidate.voxels, [blocks.at(-1)]);
  assert.deepEqual(boxes.map((members) => members[0].genericId), [0, 1, 2, 3]);
  assert.ok(boxes.every((members) => members.length >= 2 && members.length <= 5));

  const floors = candidate.voxels.filter((voxel) => voxel.blockId === "floor");
  const ice = candidate.voxels.filter((voxel) => voxel.blockId === "ice");
  const walls = candidate.voxels.filter((voxel) => voxel.blockId === "wall");
  assert.ok(floors.every((voxel) => voxel.z === 0));
  assert.ok(ice.some((voxel) => voxel.z === 0));
  assert.ok(ice.some((voxel) => voxel.z > 0));
  assert.ok(walls.every((voxel) => voxel.z >= 1));
  assert.ok(exactBlockClusters(candidate.voxels, new Set(["ice"])).length >= 2);
  assert.ok(walls.length >= configuration.width * 2 + (configuration.depth - 2) * 2);

  const rowZeroTerrain = candidate.voxels.filter((voxel) =>
    voxel.z === 0 && (voxel.blockId === "floor" || voxel.blockId === "ice"));
  assert.ok(rowZeroTerrain.length < configuration.width * configuration.depth);
});

test("weightless polycubes remain uncapped after their compact seed", () => {
  const member = { x: 8, y: 8, z: 1, blockId: "weightless", genericId: 0 };
  const voxels = [member];
  const members = [member];
  const blockRoles = new Map(blocks.map((block) => [block.id, block.roleId]));
  const random = mulberry32(97);
  for (let growth = 0; growth < 20; growth += 1) {
    assert.equal(growGenericBox(
      voxels, members, configuration, random, blockRoles,
    ), true);
  }
  assert.equal(members.length, 21);
});

test("classic wall and pushbox seeds match MazeBenchEngine3 proportions", () => {
  const classicBlocks = blocks.filter((block) => block.id !== "ice");
  const classicConfiguration = {
    ...configuration,
    layers: 1,
    terrainDensity: 45,
    minWeightlessBoxes: 3,
    maxWeightlessBoxes: 3,
    evolveHoles: false,
    blocks: classicBlocks,
    enabledBlockIds: classicBlocks.map((block) => block.id),
    seed: 20260812,
  };
  const candidate = makeCandidate(
    classicConfiguration, mulberry32(classicConfiguration.seed),
  );
  const occupied = new Set(candidate.voxels
    .filter((voxel) => voxel.blockId === "wall" && voxel.z === 1)
    .map((voxel) => `${voxel.x},${voxel.y}`));
  for (let x = 0; x < classicConfiguration.width; x += 1) {
    assert.ok(occupied.has(`${x},0`));
    assert.ok(occupied.has(`${x},${classicConfiguration.depth - 1}`));
  }
  for (let y = 0; y < classicConfiguration.depth; y += 1) {
    assert.ok(occupied.has(`0,${y}`));
    assert.ok(occupied.has(`${classicConfiguration.width - 1},${y}`));
  }
  const perimeter = classicConfiguration.width * 2 +
    (classicConfiguration.depth - 2) * 2;
  assert.ok(occupied.size >= perimeter);
  assert.ok(occupied.size <= perimeter + 20);

  const boxes = boxEntities(candidate.voxels, [blocks.at(-1)]);
  assert.equal(boxes.length, 3);
  assert.ok(boxes.every((members) => members.length >= 2 && members.length <= 5));
});

test("polycube mutations can remove non-leaf cubes without disconnecting the blob", () => {
  const generic = [
    { x: 1, y: 1, z: 1, blockId: "weightless", genericId: 7 },
    { x: 2, y: 1, z: 1, blockId: "weightless", genericId: 7 },
    { x: 1, y: 2, z: 1, blockId: "weightless", genericId: 7 },
    { x: 2, y: 2, z: 1, blockId: "weightless", genericId: 7 },
  ];
  assert.equal(shrinkGenericBox(generic, [...generic], () => 0), true);
  assert.equal(generic.length, 3);
  const domino = generic.slice(0, 2);
  assert.equal(shrinkGenericBox(domino, [...domino], () => 0), false);
  assert.equal(domino.length, 2);

  const structure = [
    { x: 1, y: 1, z: 1, blockId: "wall" },
    { x: 2, y: 1, z: 1, blockId: "wall" },
    { x: 1, y: 2, z: 1, blockId: "wall" },
    { x: 2, y: 2, z: 1, blockId: "wall" },
  ];
  assert.equal(shrinkStaticCluster(
    structure,
    [...structure],
    () => 0,
    blocks[0],
  ), true);
  assert.equal(structure.length, 3);
});

test("Ice-only 16-row seeds are dense and begin with a reachable gem", () => {
  const iceOnlyBlocks = blocks.filter((block) =>
    ["floor", "ice", "player", "gem"].includes(block.id));
  const candidate = makeCandidate({
    ...configuration,
    terrainDensity: 45,
    minWeightlessBoxes: 0,
    maxWeightlessBoxes: 0,
    evolveHoles: false,
    blocks: iceOnlyBlocks,
    enabledBlockIds: iceOnlyBlocks.map((block) => block.id),
    seed: 20260812,
  }, mulberry32(20260812));
  const ice = candidate.voxels.filter((voxel) => voxel.blockId === "ice");
  assert.ok(ice.length >= 100);
  assert.ok(ice.filter((voxel) => voxel.z === 0).length >= 40);
  assert.ok(ice.some((voxel) => voxel.z > 0));

  const player = candidate.voxels.find((voxel) => voxel.blockId === "player");
  const gem = candidate.voxels.find((voxel) => voxel.blockId === "gem");
  const rigid = new Set(candidate.voxels
    .filter((voxel) => voxel.blockId !== "player" && voxel.blockId !== "gem")
    .map((voxel) => `${voxel.x},${voxel.y},${voxel.z}`));
  const reachable = new Set([`${player.x},${player.y},${player.z}`]);
  const queue = [player];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${cell.x + dx},${cell.y + dy},${cell.z}`;
      const support = `${cell.x + dx},${cell.y + dy},${cell.z - 1}`;
      if (!rigid.has(key) && rigid.has(support) && !reachable.has(key)) {
        reachable.add(key);
        queue.push({ x: cell.x + dx, y: cell.y + dy, z: cell.z });
      }
    }
  }
  assert.ok(reachable.has(`${gem.x},${gem.y},${gem.z}`));
});

test("Ice becomes the complete starting floor when Floor is disabled", () => {
  const iceFloorBlocks = blocks.filter((block) =>
    ["ice", "player", "gem"].includes(block.id));
  const candidate = makeCandidate({
    ...configuration,
    layers: 1,
    minWeightlessBoxes: 0,
    maxWeightlessBoxes: 0,
    evolveHoles: false,
    blocks: iceFloorBlocks,
    enabledBlockIds: iceFloorBlocks.map((block) => block.id),
    seed: 415,
  }, mulberry32(415));
  const base = candidate.voxels.filter((voxel) => voxel.z === 0);
  assert.equal(base.length, configuration.width * configuration.depth);
  assert.ok(base.every((voxel) => voxel.blockId === "ice"));
});

test("player and gem endpoints receive their own evolution mutation", () => {
  const candidate = makeCandidate(configuration, mulberry32(809));
  const blockRoles = new Map(blocks.map((block) => [block.id, block.roleId]));
  const before = candidate.voxels.filter((voxel) =>
    ["player", "goal"].includes(blockRoles.get(voxel.blockId)))
    .map((voxel) => `${voxel.blockId}:${voxel.x},${voxel.y},${voxel.z}`)
    .sort();
  assert.equal(relocateObjectives(
    candidate.voxels,
    configuration,
    mulberry32(810),
    blockRoles,
    blocks.find((block) => block.id === "player"),
    [blocks.find((block) => block.id === "gem")],
  ), true);
  const after = candidate.voxels.filter((voxel) =>
    ["player", "goal"].includes(blockRoles.get(voxel.blockId)))
    .map((voxel) => `${voxel.blockId}:${voxel.x},${voxel.y},${voxel.z}`)
    .sort();
  assert.notDeepEqual(after, before);
  assert.equal(after.length, 2);
});

test("very tall sparse search volumes do not enumerate empty layers", () => {
  const sparseBlocks = blocks.filter((block) =>
    ["floor", "player", "gem"].includes(block.id));
  const candidate = makeCandidate({
    ...configuration,
    width: 4,
    depth: 4,
    layers: 1000,
    minWeightlessBoxes: 0,
    maxWeightlessBoxes: 0,
    evolveHoles: false,
    blocks: sparseBlocks,
    enabledBlockIds: sparseBlocks.map((block) => block.id),
    seed: 922,
  }, mulberry32(922));
  assert.equal(candidate.layers, 1000);
  assert.ok(candidate.voxels.every((voxel) => voxel.z <= 1));
});

test("candidate signatures deduplicate reordered copies of the same board", () => {
  const candidate = makeCandidate(configuration, mulberry32(19));
  const reordered = {
    ...candidate,
    voxels: [...candidate.voxels].reverse(),
  };
  assert.equal(candidateSignature(candidate), candidateSignature(reordered));
});

test("reverse scrambling pulls boxes away from a solved classic-room state", () => {
  const classicBlocks = blocks.filter((block) => block.id !== "ice");
  const voxels = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      voxels.push({ x, y, z: 0, blockId: "floor" });
      if (x === 0 || y === 0 || x === 7 || y === 7) {
        voxels.push({ x, y, z: 1, blockId: "wall" });
      }
    }
  }
  voxels.push(
    { x: 3, y: 3, z: 1, blockId: "player" },
    { x: 3, y: 3, z: 1, blockId: "gem" },
    { x: 4, y: 3, z: 1, blockId: "weightless", genericId: 0 },
  );
  const candidate = {
    id: "scramble-test",
    world: { width: 8, height: 8, floorLayer: 0 },
    layers: 3,
    voxels,
    solution: [],
  };
  const pulls = reverseScrambleCandidate(candidate, {
    ...configuration,
    width: 8,
    depth: 8,
    layers: 3,
    targetMoves: 50,
    blocks: classicBlocks,
    enabledBlockIds: classicBlocks.map((block) => block.id),
  }, mulberry32(7));
  assert.ok(pulls > 0);
  assert.deepEqual(
    candidate.voxels.find((voxel) => voxel.blockId === "gem"),
    { x: 3, y: 3, z: 1, blockId: "gem" },
  );
  assert.notDeepEqual(
    candidate.voxels.find((voxel) => voxel.blockId === "player"),
    { x: 3, y: 3, z: 1, blockId: "player" },
  );
});

test("one row above the floor never generates Row-2 voxels", () => {
  const oneRowConfiguration = {
    ...configuration,
    layers: 1,
    terrainDensity: 70,
    minWeightlessBoxes: 4,
    maxWeightlessBoxes: 4,
    seed: 31,
  };
  let candidate = makeCandidate(oneRowConfiguration, mulberry32(31));
  assert.ok(candidate.voxels.every((voxel) => voxel.z <= 1));
  assert.ok(candidate.voxels.some((voxel) => voxel.z === 1));
  const random = mulberry32(32);
  for (let mutation = 0; mutation < 300; mutation += 1) {
    candidate = mutateCandidate(candidate, oneRowConfiguration, random);
    assert.ok(candidate.voxels.every((voxel) => voxel.z <= 1));
  }
});

test("initial walls grow upward while respecting the selected Row-20 ceiling", () => {
  const wallsOnlyBlocks = blocks.filter((block) =>
    ["floor", "wall", "player", "gem"].includes(block.id));
  const tallConfiguration = {
    ...configuration,
    layers: 20,
    terrainDensity: 70,
    minWeightlessBoxes: 0,
    maxWeightlessBoxes: 0,
    evolveHoles: false,
    blocks: wallsOnlyBlocks,
    enabledBlockIds: wallsOnlyBlocks.map((block) => block.id),
    seed: 781,
  };
  let candidate = makeCandidate(tallConfiguration, mulberry32(781));
  const initialWalls = candidate.voxels.filter((voxel) => voxel.blockId === "wall");
  assert.ok(initialWalls.some((voxel) => voxel.z > 1));
  assert.ok(initialWalls.every((voxel) => voxel.z <= 20));

  const random = mulberry32(782);
  for (let mutation = 0; mutation < 500; mutation += 1) {
    candidate = mutateCandidate(candidate, tallConfiguration, random);
    assert.ok(candidate.voxels.every((voxel) => voxel.z >= 0 && voxel.z <= 20));
  }
});

test("explicit upward wall growth may paint Row 20 but never Row 21", () => {
  const wall = { x: 3, y: 3, z: 19, blockId: "wall" };
  const voxels = [wall];
  const blockRoles = new Map(blocks.map((block) => [block.id, block.roleId]));
  assert.equal(growWallUpward(
    voxels,
    new Set(["wall"]),
    { ...configuration, layers: 20 },
    () => 0,
    blockRoles,
  ), true);
  assert.ok(voxels.some((voxel) => voxel.z === 20));
  assert.equal(growWallUpward(
    voxels.filter((voxel) => voxel.z === 20),
    new Set(["wall"]),
    { ...configuration, layers: 20 },
    () => 0,
    blockRoles,
  ), false);
});

test("initial terrain can occupy every horizontal perimeter", () => {
  const enabledBlocks = blocks.filter((block) => block.id !== "weightless");
  const candidate = makeCandidate({
    ...configuration,
    layers: 1,
    terrainDensity: 70,
    minWeightlessBoxes: 0,
    maxWeightlessBoxes: 0,
    blocks: enabledBlocks,
    enabledBlockIds: enabledBlocks.map((block) => block.id),
    seed: 31,
  }, mulberry32(31));
  const terrain = candidate.voxels.filter((voxel) =>
    voxel.blockId !== "floor" || voxel.z !== 0);
  assert.ok(terrain.some((voxel) => voxel.x === 0));
  assert.ok(terrain.some((voxel) => voxel.x === configuration.width - 1));
  assert.ok(terrain.some((voxel) => voxel.y === 0));
  assert.ok(terrain.some((voxel) => voxel.y === configuration.depth - 1));
});

test("MazeBench planar seeds keep Ice flat, sparse, and component-limited", () => {
  const planar = {
    ...configuration,
    layers: 1,
    terrainMode: "planar",
    initialIceMax: 18,
    initialHoleMax: 8,
    reverseScramblePercent: 0,
    terrainDensity: 45,
    seed: 812,
  };
  const random = mulberry32(planar.seed);
  let totalIce = 0;
  let totalHoles = 0;
  for (let sample = 0; sample < 32; sample += 1) {
    const candidate = makeCandidate(planar, random);
    const ice = candidate.voxels.filter((voxel) => voxel.blockId === "ice");
    const rowZero = candidate.voxels.filter((voxel) => voxel.z === 0 &&
      ["floor", "ice"].includes(voxel.blockId));
    assert.ok(ice.every((voxel) => voxel.z === 0));
    assert.ok(ice.length <= 18);
    assert.ok(exactBlockClusters(candidate.voxels, new Set(["ice"])).length <= 3);
    assert.ok(configuration.width * configuration.depth - rowZero.length <= 8);
    totalIce += ice.length;
    totalHoles += configuration.width * configuration.depth - rowZero.length;
  }
  assert.ok(totalIce > 0);
  assert.ok(totalHoles > 0);
});

test("mixed Ice seeds can reverse-pull boxes before terrain is added", () => {
  const candidate = makeCandidate({
    ...configuration,
    layers: 1,
    terrainMode: "planar",
    initialIceMax: 18,
    initialHoleMax: 8,
    reverseScramblePercent: 100,
    minimumScramblePulls: 1,
    targetMoves: 100,
    seed: 913,
  }, mulberry32(913));
  assert.ok(candidate.scramblePulls >= 1);
  assert.ok(candidate.voxels.some((voxel) => voxel.blockId === "ice"));
  assert.ok(candidate.voxels.filter((voxel) => voxel.blockId === "ice")
    .every((voxel) => voxel.z === 0));
  assert.notDeepEqual(
    candidate.voxels.find((voxel) => voxel.blockId === "player"),
    candidate.voxels.find((voxel) => voxel.blockId === "gem"),
  );
});

test("fresh endpoints may require moving a box instead of guaranteeing a box-free route", () => {
  const planar = {
    ...configuration,
    layers: 1,
    terrainMode: "planar",
    initialIceMax: 0,
    initialHoleMax: 0,
    evolveHoles: false,
    minWeightlessBoxes: 10,
    maxWeightlessBoxes: 10,
    reverseScramblePercent: 0,
    seed: 1014,
  };
  const random = mulberry32(planar.seed);
  let foundBlockedRoute = false;
  for (let sample = 0; sample < 48 && !foundBlockedRoute; sample += 1) {
    const candidate = makeCandidate(planar, random);
    const rigid = new Set(candidate.voxels.filter((voxel) =>
      !["player", "gem"].includes(voxel.blockId)).map((voxel) =>
      `${voxel.x},${voxel.y},${voxel.z}`));
    const player = candidate.voxels.find((voxel) => voxel.blockId === "player");
    const gem = candidate.voxels.find((voxel) => voxel.blockId === "gem");
    const visited = new Set([`${player.x},${player.y},${player.z}`]);
    const queue = [player];
    for (let head = 0; head < queue.length; head += 1) {
      const cell = queue[head];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${cell.x + dx},${cell.y + dy},${cell.z}`;
        const support = `${cell.x + dx},${cell.y + dy},${cell.z - 1}`;
        if (!rigid.has(key) && rigid.has(support) && !visited.has(key)) {
          visited.add(key);
          queue.push({ x: cell.x + dx, y: cell.y + dy, z: cell.z });
        }
      }
    }
    foundBlockedRoute = !visited.has(`${gem.x},${gem.y},${gem.z}`);
  }
  assert.equal(foundBlockedRoute, true);
});
