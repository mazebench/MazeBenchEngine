import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  cameraFacingSlopeDirection,
  cameraRelativeDirection,
  cameraYawQuarterTurns,
  stepCameraZoom,
} from "../app/cameraNavigation.mjs";

test("camera yaw snaps to the nearest normalized quarter turn", () => {
  assert.equal(cameraYawQuarterTurns(0), 0);
  assert.equal(cameraYawQuarterTurns(Math.PI / 2), 1);
  assert.equal(cameraYawQuarterTurns(-Math.PI / 2), 3);
  assert.equal(cameraYawQuarterTurns(Math.PI * 2), 0);
});

test("screen arrows follow the rotated camera", () => {
  assert.equal(cameraRelativeDirection("up", 0), "up");
  assert.equal(cameraRelativeDirection("up", 1), "left");
  assert.equal(cameraRelativeDirection("right", 1), "up");
  assert.equal(cameraRelativeDirection("down", 2), "up");
  assert.equal(cameraRelativeDirection("left", 3), "up");
});

test("slope painting always faces the far side of the camera", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(cameraFacingSlopeDirection),
    ["up", "left", "down", "right"],
  );
});

test("keyboard zoom uses deterministic bounded steps", () => {
  assert.ok(stepCameraZoom(1, 1) > 1);
  assert.ok(stepCameraZoom(1, -1) < 1);
  assert.equal(stepCameraZoom(10, 1), 10);
  assert.equal(stepCameraZoom(0.55, -1), 0.55);
  assert.equal(stepCameraZoom(Number.NaN, 1), 1.12);
});

test("the editor shares Q/E zoom with the level editor and retains minus/plus aliases", async () => {
  const canvas = await readFile(
    new URL("../app/MazeBenchCanvas.tsx", import.meta.url),
    "utf8",
  );
  assert.match(canvas, /key === "-"[\s\S]*?key === "="[\s\S]*?zoomCamera/);
  assert.doesNotMatch(canvas, /onWheel=/);
  assert.match(canvas, /key === "q"/);
  assert.match(canvas, /key === "e"/);
  const editor = await readFile(new URL("../app/VoxelBench.tsx", import.meta.url), "utf8");
  assert.match(editor, /key === "x"[\s\S]*?setSelectedBlock\(DELETE_TOOL_ID\)/);
  assert.doesNotMatch(editor, /key === "e"/);
});

test("editor camera fitting stays locked while voxel layers change", async () => {
  const renderer = await readFile(
    new URL("../public/mazebench-runtime/play-render-three.js", import.meta.url),
    "utf8",
  );
  assert.match(renderer, /editorCameraFitLock/);
  assert.match(renderer, /maximumLogicalLayer \+ Number\(app\.editorCameraElevationOffset/);
  assert.match(renderer, /fixedCameraDistance: editorCameraFitLock\.baseDistance/);
  assert.match(renderer, /elevationShift = elevationOffset - editorCameraFitLock\.elevationOffset/);
  assert.match(renderer, /minY: elevationShift/);
});
