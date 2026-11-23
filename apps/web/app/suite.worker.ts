import { createFrameComparisonContext, runRotationalTest } from "./suiteRunner";
import type { BlockDefinition, PhysicsRoleDefinition, TestCase, TestResult } from "./suiteTypes";

self.onmessage = async ({ data }: MessageEvent<{ tests: TestCase[]; blocks: BlockDefinition[]; roles: PhysicsRoleDefinition[] }>) => {
  try {
    const context = createFrameComparisonContext(data.blocks);
    const results: Record<string, TestResult> = {};
    let lastProgress = 0;
    for (const [index, test] of data.tests.entries()) {
      results[test.id] = await runRotationalTest(test, data.blocks, data.roles, context, true);
      if (performance.now() - lastProgress > 50 || index + 1 === data.tests.length) {
        self.postMessage({ progress: index + 1 });
        lastProgress = performance.now();
      }
    }
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "The C++ physics engine could not run" });
  }
};
