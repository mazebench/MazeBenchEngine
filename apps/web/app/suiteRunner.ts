import { simulateCommandWithCpp } from "./physicsEngine";
import { applyWorldToTest, cropVoxelsToWorld, rotateVoxelsClockwise, rotateWorldClockwise } from "./worldBounds.mjs";
import { createCellObjectMultisetDiffer } from "./cellObjects.mjs";
import { orangeWallVisualFrame } from "./orangeWalls.mjs";
import { compareCycleExpectation } from "./cycleExpectation.mjs";
import type { Direction, PhysicsRoleDefinition, BlockDefinition, Voxel, Frame, WorldSettings, TestCase, FrameComparison, FrameComparisonContext, RotationDegrees, RotationCheck, TestResult } from "./suiteTypes";
function cropFrameToWorld(frame: Frame, world: WorldSettings): Frame { return { voxels: cropVoxelsToWorld(frame.voxels, world) }; }
function cropTestToWorld(test: TestCase): TestCase { return applyWorldToTest({ ...test, input: "up" }, test.world) as TestCase; }

const ROTATION_CASES: Array<{
  degrees: RotationDegrees;
  input: Direction;
  quarterTurns: 0 | 1 | 2 | 3;
}> = [
  { degrees: 0, input: "up", quarterTurns: 0 },
  { degrees: 90, input: "right", quarterTurns: 1 },
  { degrees: 180, input: "down", quarterTurns: 2 },
  { degrees: 270, input: "left", quarterTurns: 3 },
];
export function createFrameComparisonContext(
  definitions: BlockDefinition[],
): FrameComparisonContext {
  return {
    blocksById: new Map(definitions.map((definition) => [definition.id, definition])),
    differ: createCellObjectMultisetDiffer(),
  };
}

export function compareFrames(
  expected: Frame,
  actual: Frame,
  world: WorldSettings,
  definitions: BlockDefinition[],
  context: FrameComparisonContext = createFrameComparisonContext(definitions),
): FrameComparison {
  const boundedExpected = cropFrameToWorld(expected, world);
  const boundedActual = cropFrameToWorld(actual, world);
  const visibleExpected = orangeWallVisualFrame(
    boundedExpected, context.blocksById) as Frame;
  const visibleActual = orangeWallVisualFrame(
    boundedActual, context.blocksById) as Frame;
  const { missing, unexpected } = context.differ(
    visibleExpected.voxels,
    visibleActual.voxels,
  ) as { missing: Voxel[]; unexpected: Voxel[] };
  return { actual: boundedActual, pass: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

function rotateFrame(frame: Frame, world: WorldSettings, quarterTurns: number): Frame {
  return { voxels: rotateVoxelsClockwise(frame.voxels, world, quarterTurns) };
}

export async function runRotationalTest(
  test: TestCase,
  definitions: BlockDefinition[],
  roles: PhysicsRoleDefinition[],
  comparisonContext = createFrameComparisonContext(definitions),
  compactPassingResult = false,
): Promise<TestResult> {
  const world = test.world;
  const canonicalTest = cropTestToWorld(test);
  const checks: RotationCheck[] = [];
  for (const { degrees, input, quarterTurns } of ROTATION_CASES) {
    const horizontalWorld = rotateWorldClockwise(world, quarterTurns);
    const rotatedWorld: WorldSettings = { ...horizontalWorld, floorLayer: 0 };
    const rotatedTest: TestCase = {
      ...canonicalTest,
      input,
      world: rotatedWorld,
      start: rotateFrame(canonicalTest.start, world, quarterTurns),
      expected: rotateFrame(canonicalTest.expected, world, quarterTurns),
      intermediate: canonicalTest.intermediate.map((frame) =>
        rotateFrame(frame, world, quarterTurns)),
    };
    const simulation = await simulateCommandWithCpp(
      rotatedTest.start, input, definitions, roles, rotatedWorld);
    const expectedFrames = [
      rotatedTest.start,
      ...rotatedTest.intermediate,
      rotatedTest.expected,
    ];
    const actualFrames = [rotatedTest.start, ...simulation.frames];
    const trace = Array.from(
      { length: Math.max(expectedFrames.length, actualFrames.length) },
      (_, index) => {
        const expectedPresent = index < expectedFrames.length;
        const actualPresent = index < actualFrames.length;
        const expectedFrame = expectedFrames[index] ?? { voxels: [] };
        const actualFrame = actualFrames[index] ?? { voxels: [] };
        const comparison = compareFrames(
          expectedFrame,
          actualFrame,
          rotatedWorld,
          definitions,
          comparisonContext,
        );
        return {
          ...comparison,
          actualPresent,
          expected: expectedFrame,
          expectedPresent,
          pass: expectedPresent && actualPresent && comparison.pass,
        };
      },
    );
    const firstMismatchFrame = trace.findIndex((frame) => !frame.pass);
    const cycleDifference = compareCycleExpectation(rotatedTest.cycle, simulation.cycle);
    const selectedFrame = firstMismatchFrame >= 0
      ? trace[firstMismatchFrame]
      : trace.at(-1)!;
    const tick = firstMismatchFrame > 0 ? firstMismatchFrame : undefined;
    checks.push({
      ...selectedFrame,
      cycleDifference,
      expected: selectedFrame.expected,
      firstMismatchFrame: firstMismatchFrame >= 0 ? firstMismatchFrame : null,
      input,
      pass: firstMismatchFrame < 0 && cycleDifference === null,
      rotation: degrees,
      trace,
      tick,
      world: rotatedWorld,
    });
  }
  const representative = checks.find((check) => !check.pass) ?? checks[0];
  const result: TestResult = {
    ...representative,
    checks,
    pass: checks.every((check) => check.pass),
  };
  if (!compactPassingResult || !result.pass) return result;
  const compactChecks = checks.map((check) => ({
    ...check,
    actual: { voxels: [] },
    expected: { voxels: [] },
    missing: [],
    trace: [],
    unexpected: [],
  }));
  return { ...compactChecks[0], checks: compactChecks };
}

