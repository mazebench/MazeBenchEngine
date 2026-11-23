import { createProjectCodecTaskProcessor } from "./projectCodecTasks.mjs";

const processTask = createProjectCodecTaskProcessor();

self.onmessage = ({ data: { id, operation, value } }) => {
  try {
    self.postMessage({ id, value: processTask(operation, value) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
