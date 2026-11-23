import assert from "node:assert/strict";
import test from "node:test";

import {
  marqueeRectangle,
  marqueeSamplePoints,
} from "../app/marqueeSelection.mjs";

test("marquee rectangles normalize drags in every direction", () => {
  assert.deepEqual(marqueeRectangle(90, 70, 10, 20), {
    bottom: 70,
    height: 50,
    left: 10,
    right: 90,
    top: 20,
    width: 80,
  });
});

test("marquee samples cover the rectangle edges and interior", () => {
  const rectangle = marqueeRectangle(10, 20, 30, 40);
  const points = marqueeSamplePoints(rectangle, { minSpacing: 5 });

  assert.ok(points.some(({ x, y }) => x === 10 && y === 20));
  assert.ok(points.some(({ x, y }) => x === 30 && y === 40));
  assert.ok(points.some(({ x, y }) => x === 20 && y === 30));
});

test("large marquee sampling remains bounded", () => {
  const rectangle = marqueeRectangle(0, 0, 2400, 1600);
  const points = marqueeSamplePoints(rectangle, { maxSamples: 12000 });

  assert.ok(points.length >= 12000);
  assert.ok(points.length < 12500);
});
