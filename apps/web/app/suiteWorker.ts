/// <reference types="vite/client" />
import SuiteWorker from "./suite.worker.ts?worker";
import type { BlockDefinition, PhysicsRoleDefinition, TestCase, TestResult } from "./suiteTypes";

// A single worker per run keeps physics and frame comparisons off the UI thread.
// Termination also releases its WASM memory after completion or revision changes.
export function startSuiteWorker(tests: TestCase[], blocks: BlockDefinition[], roles: PhysicsRoleDefinition[], onProgress: (done: number) => void) {
  const worker = new SuiteWorker();
  let rejectJob: (reason: Error) => void;
  const result = new Promise<Record<string, TestResult>>((resolve, reject) => {
    rejectJob = reject;
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      else if (data.results) resolve(data.results);
      else if (data.progress !== undefined) onProgress(data.progress);
    };
    worker.onerror = event => reject(new Error(event.message || "Test worker failed to load"));
    worker.onmessageerror = () => reject(new Error("Test worker returned an unreadable result"));
    worker.postMessage({ tests, blocks, roles });
  }).finally(() => worker.terminate());
  return { result, cancel() { worker.terminate(); rejectJob(new Error("Test run cancelled")); } };
}
