import assert from "node:assert/strict";
import test from "node:test";

import {
  blockCanShareCell,
  blockUsesPolycubeGroup,
  cellObjectSemanticKey,
  createCellObjectMultisetDiffer,
  diffObjectMultisets,
  eraseOneObjectAtCell,
  normalizeOccupancyProfile,
  objectCanShareCell,
  objectPaintsInsideClickedBody,
  placeObjectInCell,
} from "../app/cellObjects.mjs";

const definitions = new Map([
  ["box", { roleId: "pushable", occupancy: "solid" }],
  ["wall", { roleId: "solid", occupancy: "solid" }],
  ["gem", { roleId: "goal", occupancy: "sensor" }],
  ["button", { roleId: "button", occupancy: "sensor" }],
  ["orange-button-hidden", {
    roleId: "orange-button",
    occupancy: "inactive",
    visual: { kind: "button", buttonForm: "hidden" },
  }],
  ["orange-wall", {
    roleId: "orange-wall",
    occupancy: "inactive",
    visual: { kind: "orange-wall", orangeForm: "visible" },
  }],
  ["orange-wall-hidden", {
    roleId: "orange-wall",
    occupancy: "inactive",
    visual: { kind: "orange-wall", orangeForm: "hidden" },
  }],
  ["puncher", {
    roleId: "puncher",
    occupancy: "sensor",
    visual: { kind: "puncher" },
  }],
]);

const at = (blockId, extras = {}) => ({ x: 2, y: 3, z: 1, blockId, ...extras });

test("legacy goals migrate to pass-through sensors", () => {
  assert.equal(normalizeOccupancyProfile(undefined, "goal"), "sensor");
  assert.equal(normalizeOccupancyProfile(undefined, "solid"), "solid");
  assert.equal(blockCanShareCell({ roleId: "goal" }), true);
});

test("stateful lift numbers never become polycube group identities", () => {
  assert.equal(blockUsesPolycubeGroup({ roleId: "player-lift" }), false);
  assert.equal(blockUsesPolycubeGroup({ roleId: "weightless-pushable" }), true);
  assert.equal(blockUsesPolycubeGroup({ roleId: "clone" }), true);
});

test("lifts mount outside a clicked box while pass-through sensors may join its cell", () => {
  assert.equal(objectPaintsInsideClickedBody({
    roleId: "player-lift",
    occupancy: "sensor",
    visual: { kind: "lift" },
  }), false);
  assert.equal(objectPaintsInsideClickedBody({
    roleId: "orange-button",
    occupancy: "sensor",
    visual: { kind: "button" },
  }), true);
  assert.equal(objectPaintsInsideClickedBody({
    roleId: "goal",
    occupancy: "sensor",
    visual: { kind: "gem" },
  }), true);
  assert.equal(objectPaintsInsideClickedBody(definitions.get("puncher")), false);
});

test("a sensor joins an occupied solid cell without replacing the body", () => {
  const result = placeObjectInCell([at("box")], at("gem"), definitions);
  assert.equal(result.changed, true);
  assert.deepEqual(result.objects, [at("box"), at("gem")]);
});

test("a solid joins a sensor-only cell but replaces another solid", () => {
  const withSensor = placeObjectInCell([at("gem")], at("box"), definitions);
  assert.deepEqual(withSensor.objects, [at("gem"), at("box")]);

  const replacement = placeObjectInCell(withSensor.objects, at("wall"), definitions);
  assert.deepEqual(replacement.objects, [at("gem"), at("wall")]);
});

test("multiple distinct sensors may share a cell with one body", () => {
  const result = placeObjectInCell(
    [at("box"), at("gem")],
    at("button"),
    definitions,
  );
  assert.deepEqual(result.objects, [at("box"), at("gem"), at("button")]);
});

test("differently oriented buttons may share one cell", () => {
  const north = at("button", { orientation: "north", variantId: 1 });
  const east = at("button", { orientation: "east", variantId: 2 });
  const result = placeObjectInCell([north], east, definitions);
  assert.equal(result.changed, true);
  assert.deepEqual(result.objects, [north, east]);
});

test("visible and invisible Orange Walls may share any occupied cell", () => {
  const definition = definitions.get("orange-wall");
  assert.equal(objectCanShareCell(definition, at("orange-wall", { stateId: 0 })), true);
  assert.equal(objectCanShareCell(definition, at("orange-wall", { stateId: 1 })), true);
  assert.equal(objectCanShareCell(definition, at("orange-wall", { stateId: 2 })), true);

  const lowered = at("orange-wall", { stateId: 0, mechanismDepth: 2 });
  const result = placeObjectInCell(
    [lowered],
    at("box"),
    definitions,
  );
  assert.deepEqual(result.objects, [lowered, at("box")]);

  const buried = at("orange-wall", { stateId: 2, mechanismDepth: 4 });
  const buriedResult = placeObjectInCell([at("wall")], buried, definitions);
  assert.deepEqual(buriedResult.objects, [at("wall"), buried]);

  const hiddenWall = at("orange-wall-hidden", { stateId: 2, mechanismDepth: 4 });
  const hiddenResult = placeObjectInCell([at("box")], hiddenWall, definitions);
  assert.deepEqual(hiddenResult.objects, [at("box"), hiddenWall]);
});

test("the invisible Orange Button may share a solid object's cell", () => {
  const hidden = at("orange-button-hidden", { orientation: "east", variantId: 2 });
  const result = placeObjectInCell([at("box")], hidden, definitions);
  assert.deepEqual(result.objects, [at("box"), hidden]);
});

test("repainting an Orange Wall replaces its remaining-rise number", () => {
  const existing = at("orange-wall", { stateId: 1, mechanismDepth: 1 });
  const replacement = at("orange-wall", { stateId: 1, mechanismDepth: 4 });
  const result = placeObjectInCell([existing], replacement, definitions);
  assert.equal(result.changed, true);
  assert.deepEqual(result.objects, [replacement]);
});

test("semantic identity separates group, variant, state, and orientation", () => {
  const base = at("mechanism", { groupId: 3, variantId: 1, stateId: 0, orientation: "north" });
  assert.notEqual(cellObjectSemanticKey(base), cellObjectSemanticKey({ ...base, stateId: 1 }));
  assert.notEqual(cellObjectSemanticKey(base), cellObjectSemanticKey({ ...base, variantId: 2 }));
  assert.notEqual(cellObjectSemanticKey(base), cellObjectSemanticKey({ ...base, orientation: "east" }));
  assert.equal(
    cellObjectSemanticKey({ ...base, groupId: undefined, genericId: 3 }),
    cellObjectSemanticKey(base),
  );
});

test("frame differences count duplicate occupants instead of collapsing them", () => {
  const gem = at("gem");
  const difference = diffObjectMultisets([gem, { ...gem }], [gem]);
  assert.deepEqual(difference.missing, [gem]);
  assert.deepEqual(difference.unexpected, []);
});

test("the numeric suite differ preserves exact semantic multiset behavior", () => {
  const differ = createCellObjectMultisetDiffer();
  const expected = [
    at("box", { groupId: 7, orientation: "east", stateId: 2 }),
    at("gem"),
    at("gem"),
    at("orange-wall", { mechanismDepth: 3, stateId: 1 }),
  ];
  const actual = [
    at("gem"),
    at("box", { genericId: 7, orientation: "east", stateId: 2 }),
    at("orange-wall", { mechanismDepth: 4, stateId: 1 }),
    at("button", { orientation: "north" }),
  ];
  assert.deepEqual(differ(expected, actual), diffObjectMultisets(expected, actual));
  assert.deepEqual(differ(expected, [...expected].reverse()), {
    missing: [],
    unexpected: [],
  });
});

test("erase removes one occupant and preserves the rest of the cell", () => {
  const result = eraseOneObjectAtCell(
    [at("box"), at("gem"), at("button")],
    { x: 2, y: 3, z: 1 },
  );
  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, at("button"));
  assert.deepEqual(result.objects, [at("box"), at("gem")]);
});

test("erase may target the exact custom occupant picked inside an overlap", () => {
  const box = at("box", { instanceId: "box-a" });
  const gem = at("gem", { instanceId: "gem-a" });
  const result = eraseOneObjectAtCell(
    [box, gem],
    { x: 2, y: 3, z: -20 },
    "instance:gem-a",
  );
  assert.deepEqual(result.removed, gem);
  assert.deepEqual(result.objects, [box]);
});
