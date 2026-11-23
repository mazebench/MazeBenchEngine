import assert from "node:assert/strict";
import test from "node:test";
import { rotateVoxelsClockwise, rotateWorldClockwise } from "../../apps/web/app/worldBounds.mjs";
import { normalizeOrangeWallFrame } from "../../apps/web/app/orangeWalls.mjs";
import { project, blocksById, simulateFrames, simulateFinal, frameDifference, summarize } from "./helpers/project-engine.mjs";

for (const authoredTest of project.tests) {
  test(`authored C++ suite: ${authoredTest.name} [${authoredTest.id}]`, {
    skip: authoredTest.hidden ? "Hidden by the level author" : false,
  }, () => {
    const failures = [];
    for (let quarterTurns = 0; quarterTurns < 4; quarterTurns += 1) {
      const world = rotateWorldClockwise(authoredTest.world, quarterTurns);
      const start = normalizeOrangeWallFrame({
        voxels: rotateVoxelsClockwise(authoredTest.start.voxels, authoredTest.world, quarterTurns),
      }, blocksById).voxels;
      const expected = normalizeOrangeWallFrame({
        voxels: rotateVoxelsClockwise(authoredTest.expected.voxels, authoredTest.world, quarterTurns),
      }, blocksById).voxels;
      const expectedIntermediate = (authoredTest.intermediate ?? []).map((frame) =>
        normalizeOrangeWallFrame({
          voxels: rotateVoxelsClockwise(frame.voxels, authoredTest.world, quarterTurns),
        }, blocksById).voxels);
      const actualFrames = simulateFrames(start, quarterTurns, world);
      const expectedCycle = authoredTest.cycle ?? null;
      if ((actualFrames.cycle?.startTick ?? null) !==
            (expectedCycle?.startTick ?? null) ||
          (actualFrames.cycle?.repeatTick ?? null) !==
            (expectedCycle?.repeatTick ?? null)) {
        failures.push(
          `${quarterTurns * 90}°: expected cycle ${expectedCycle ? `${expectedCycle.startTick}→${expectedCycle.repeatTick}` : "none"}, ` +
          `engine reported ${actualFrames.cycle ? `${actualFrames.cycle.startTick}→${actualFrames.cycle.repeatTick}` : "none"}`,
        );
      }
      const expectedTickCount = expectedIntermediate.length + 1;
      if (actualFrames.length !== expectedTickCount) {
        failures.push(
          `${quarterTurns * 90}°: expected ${expectedTickCount} tick frame(s), ` +
          `engine produced ${actualFrames.length}`,
        );
      }
      for (let index = 0; index < expectedIntermediate.length; index += 1) {
        const actualTick = actualFrames[index];
        if (!actualTick) {
          failures.push(`${quarterTurns * 90}° tick ${index + 1}: engine trace ended early`);
          break;
        }
        const tickDifference = frameDifference(expectedIntermediate[index], actualTick, world);
        if (tickDifference.missing.length || tickDifference.unexpected.length) {
          failures.push(
            `${quarterTurns * 90}° tick ${index + 1}: missing ${summarize(tickDifference.missing)} | ` +
            `unexpected ${summarize(tickDifference.unexpected)}`,
          );
          break;
        }
      }
      const actual = actualFrames.at(-1) ?? start;
      const difference = frameDifference(expected, actual, world);
      if (difference.missing.length || difference.unexpected.length) {
        failures.push(
          `${quarterTurns * 90}°: missing ${summarize(difference.missing)} | ` +
          `unexpected ${summarize(difference.unexpected)}`,
        );
      }
      const fastFinal = simulateFinal(start, quarterTurns, world);
      const fastDifference = frameDifference(expected, fastFinal, world);
      if (fastDifference.missing.length || fastDifference.unexpected.length) {
        failures.push(
          `${quarterTurns * 90}° fast final: missing ${summarize(fastDifference.missing)} | ` +
          `unexpected ${summarize(fastDifference.unexpected)}`,
        );
      }
    }
    assert.equal(
      failures.length,
      0,
      `${authoredTest.description || authoredTest.name}\n${failures.join("\n")}`,
    );
  });
}
