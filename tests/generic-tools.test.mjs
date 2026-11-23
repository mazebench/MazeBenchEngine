import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parserToolTokens } from "../editor/v1/directional-tools.mjs";
import { voxelPlacementForTool } from "../editor/v1/face-placement-v2.mjs";
import {
  canonicalGenericToolToken,
  concreteGenericToolToken,
  genericToolDescriptor
} from "../editor/v1/generic-tools.mjs";
import { genericNumberLabel } from "../render/v1/generic-labels.mjs";

const parser = JSON.parse(await readFile(
  new URL("../editor/v1/level_parsing.json", import.meta.url),
  "utf8"
));

test("toolbox exposes one cube and one slope tool for each numbered family", () => {
  const tokens = parserToolTokens(parser);
  assert.ok(tokens.includes("M0"));
  assert.ok(tokens.includes("c0"));
  assert.ok(tokens.includes("SrM0"));
  assert.ok(tokens.includes("Src0"));
  assert.ok(tokens.includes("pr"));
  assert.ok(tokens.includes("Pr"));
  assert.equal(tokens.includes("M1"), false);
  assert.equal(tokens.includes("c1"), false);
});

test("cube and slope variants share the chosen family number", () => {
  assert.equal(concreteGenericToolToken("M0", 37), "M37");
  assert.equal(concreteGenericToolToken("SrM0", 37), "SrM37");
  assert.equal(concreteGenericToolToken("c0", 12), "c12");
  assert.equal(concreteGenericToolToken("Src0", 12), "Src12");
  assert.equal(canonicalGenericToolToken("SlM37"), "SrM0");
  assert.equal(canonicalGenericToolToken("Suc12"), "Src0");
  assert.equal(genericToolDescriptor("Sdc8").name, "Clone Ice Slope 8");
});

test("generic cube and slope placements preserve both engine identity fields", () => {
  const coordinate = { x: 4, y: 5, z: 2 };
  const directions = { far: "up", near: "down" };
  const blockSlope = voxelPlacementForTool("SrM37", coordinate, {}, directions);
  const cloneSlope = voxelPlacementForTool("Src12", coordinate, {}, directions);

  assert.deepEqual(blockSlope, {
    ...coordinate,
    blockId: "weightless-slope",
    genericId: 37,
    groupId: 37,
    orientation: "up",
    variantId: 0
  });
  assert.deepEqual(cloneSlope, {
    ...coordinate,
    blockId: "clone-slope",
    genericId: 12,
    groupId: 12,
    orientation: "up",
    variantId: 0
  });
});

test("renderer labels numbered V2 and legacy generic objects", () => {
  assert.equal(
    genericNumberLabel({ groupId: 37 }, { roleId: "weightless-pushable" }),
    "37"
  );
  assert.equal(
    genericNumberLabel({ genericId: 12 }, { roleId: "clone" }),
    "12"
  );
  assert.equal(genericNumberLabel({ type: "weightless_box", groupId: "M8" }), "8");
  assert.equal(genericNumberLabel({ type: "crate", groupId: 8 }), null);
});
