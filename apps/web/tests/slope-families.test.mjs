import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../../../project-data/project.json", import.meta.url);

test("MazeBench box and clone slopes are generic four-direction object families", async () => {
  const project = JSON.parse(await readFile(projectUrl, "utf8"));
  const roles = new Map(project.roles.map((role) => [role.id, role]));
  const blocks = new Map(project.blocks.map((block) => [block.id, block]));
  const boxSlope = blocks.get("blue-box-slope");
  const cloneSlope = blocks.get("yellow-clone-slope");

  assert.equal(roles.get("weightless-pushable")?.generic, true);
  assert.equal(roles.get("clone")?.generic, true);
  assert.deepEqual(boxSlope, {
    id: "blue-box-slope",
    name: "Blue box slope",
    color: "#5e87d9",
    roleId: "weightless-pushable",
    occupancy: "solid",
    visual: { kind: "slope" },
  });
  assert.deepEqual(cloneSlope, {
    id: "yellow-clone-slope",
    name: "Yellow clone slope",
    color: "#a0a244",
    roleId: "clone",
    occupancy: "solid",
    visual: { kind: "slope" },
  });
});

test("generic slope numbers use MazeBench's inclined ramp-face label", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );

  assert.match(renderer, /function iceSlopeGroupLabelGeometry\(direction\)/);
  assert.match(
    renderer,
    /addWeightlessSlopeGroupLabel\(\s*\{\s*direction: descriptor\.layer\?\.direction,\s*groupId: descriptor\.layer\.genericLabel/s,
  );
});

test("box and clone cubes share MazeBench's grouped actor render path with their slopes", async () => {
  const canvas = await readFile(new URL("../app/MazeBenchCanvas.tsx", import.meta.url), "utf8");
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );

  assert.match(canvas, /definition\.roleId === "weightless-pushable"[\s\S]*?"weightless_box"/);
  assert.match(canvas, /definition\.roleId === "clone"[\s\S]*?"clone"/);
  assert.match(canvas, /shape: definition\.visual\.kind === "slope" \? "slope"/);
  assert.match(canvas, /rigidFamilyType === "clone" \? `c\$\{genericId\}` : `M\$\{genericId\}`/);
  assert.match(renderer, /groupedSlopeActorContactsForVoxels/);
  assert.match(renderer, /groupedSlopeActorSuppressedEdgeContacts/);
});

test("ordinary Ice cubes and slopes suppress their shared internal outlines", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );

  assert.match(renderer, /return descriptor\.layer\?\.styleKey \? null : "ice_block"/);
  assert.match(renderer, /iceSlopeHighSideHasSolidContact/);
  assert.match(renderer, /iceSlopeBottomHasSolidContact/);
  assert.match(renderer, /iceSlopeCoveredTopFaceCellsForVoxels/);
  assert.match(renderer, /iceSlopeSuppressedEdgeContacts/);
});

test("browser simulation and search preserve distinct directional slope roles", async () => {
  const physicsEngine = await readFile(
    new URL("../app/physicsEngine.ts", import.meta.url),
    "utf8",
  );
  const searchWorker = await readFile(
    new URL("../public/search-worker.js", import.meta.url),
    "utf8",
  );
  const authoredSuite = await readFile(
    new URL("../../../engine/tests/helpers/project-engine.mjs", import.meta.url),
    "utf8",
  );

  for (const source of [physicsEngine, searchWorker]) {
    assert.match(source, /blue-box-slope-up/);
    assert.match(source, /blue-box-slope-left/);
    assert.match(source, /yellow-clone-slope-up/);
    assert.match(source, /yellow-clone-slope-left/);
    assert.match(source, /slopePhysicsRoleId\(block\.roleId, (?:orientation|direction)\)/);
  }
  assert.match(authoredSuite, /\["ice-slope", "blue-box-slope", "yellow-clone-slope"\]/);
  assert.match(authoredSuite, /slopePhysicsRoleId\(block\.roleId, direction\)/);
});
