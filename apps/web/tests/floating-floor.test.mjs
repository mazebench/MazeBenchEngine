import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../../../project-data/project.json", import.meta.url);

test("the tracked project catalog includes the MazeBench Floating Floor", async () => {
  const project = JSON.parse(await readFile(projectUrl, "utf8"));
  const roles = new Map(project.roles.map((role) => [role.id, role]));
  const blocks = new Map(project.blocks.map((block) => [block.id, block]));

  assert.deepEqual(roles.get("floating-floor"), {
    id: "floating-floor",
    name: "Floating Floor",
    description: "A one-weight hovering platform. One can be pushed like a Sokoban box; after entering a Row-0 hole it stays suspended for that movement tick, then becomes permanent Floor on the next tick.",
    generic: false,
  });
  assert.deepEqual(blocks.get("floating-floor"), {
    id: "floating-floor",
    name: "Floating floor",
    color: "#D6BD94",
    roleId: "floating-floor",
    occupancy: "solid",
    visual: { kind: "floating-floor" },
  });
});

test("the editor routes Floating Floor blocks through the MazeBench actor recipe", async () => {
  const [editor, canvas, renderer, manifest, styles] = await Promise.all([
    readFile(new URL("../app/VoxelBench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/MazeBenchCanvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url), "utf8"),
    readFile(new URL("../public/assets/objects/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /id: "floating-floor", name: "Floating floor"[\s\S]*?occupancy: "solid"[\s\S]*?kind: "floating-floor"/);
  assert.match(editor, /MazeBench floating floor/);
  assert.match(canvas, /const isFloatingFloor = definition\.visual\.kind === "floating-floor"/);
  assert.match(canvas, /isFloatingFloor[\s\S]*?\? "floating_floor"/);
  assert.match(renderer, /function addFloatingFloor\(/);
  assert.match(renderer, /actor\.type === "floating_floor"[\s\S]*?addFloatingFloor\(/);
  assert.match(renderer, /logicalSourceFollowsPaint: true,\s*selectionKey: actor\.selectionKey/);
  assert.match(manifest, /"mazebench-floating-floor"[\s\S]*?"hovering-top-rounded-platform"/);
  assert.match(styles, /\.swatch-cube\.floating-floor::before/);
});

test("the C++ adapter converts a filled Floating Floor into permanent Floor", async () => {
  const adapter = await readFile(new URL("../app/physicsEngine.ts", import.meta.url), "utf8");

  assert.match(adapter, /visualKind === "floating-floor" && mechanismId === 1/);
  assert.match(adapter, /blockId: floorBlockId \?\? voxel\.blockId/);
});
