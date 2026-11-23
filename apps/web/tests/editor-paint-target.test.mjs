import assert from "node:assert/strict";
import test from "node:test";

import { resolveEditorPaintTarget } from "../app/editorPaintTarget.mjs";

const actorPick = {
  kind: "actor",
  paintLayer: 3,
  paintX: 4,
  paintY: 5,
  sourceLayer: 2,
  sourceX: 1,
  sourceY: 2,
};

test("a shareable object painted on an actor joins the actor cell", () => {
  assert.deepEqual(
    resolveEditorPaintTarget(actorPick, { selectedCanShare: true }),
    { x: 1, y: 2, layer: 2 },
  );
});

test("solid painting and ordinary terrain faces preserve adjacent placement", () => {
  assert.deepEqual(
    resolveEditorPaintTarget(actorPick, { selectedCanShare: false }),
    { x: 4, y: 5, layer: 3 },
  );
  assert.deepEqual(
    resolveEditorPaintTarget(
      { ...actorPick, kind: "terrain" },
      { selectedCanShare: true },
    ),
    { x: 4, y: 5, layer: 3 },
  );
});

test("erase and replace always address the picked source occupant", () => {
  for (const options of [{ erase: true }, { replace: true }]) {
    assert.deepEqual(
      resolveEditorPaintTarget(actorPick, options),
      { x: 1, y: 2, layer: 2 },
    );
  }
});
