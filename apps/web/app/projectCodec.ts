/// <reference types="vite/client" />
import ProjectCodecWorker from "./project-codec.worker.mjs?worker";

type Operation = "encode-incremental" | "decode";
type Reply = { id: number; value?: unknown; error?: string };
type ProjectSnapshot = Record<string, unknown> & { tests: { id: string }[] };

// One worker for the editor lifetime. IDs keep restore/export/autosave replies
// paired with their caller; effect cancellation still guards superseded saves.
export function createProjectCodec() {
  const worker = new ProjectCodecWorker();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let failure: Error | null = null;
  let sentTests = new Map<string, { id: string }>();
  const close = (error: Error) => {
    failure = error;
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.value);
  };
  worker.onerror = (event) => close(new Error(event.message || "Project worker failed to load"));
  worker.onmessageerror = () => close(new Error("Project worker returned an unreadable result"));
  const request = (operation: Operation, value: unknown, onPosted?: () => void): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, value }); onPosted?.(); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  return {
    decode: (source: string) => request("decode", source),
    encode: ({ tests, ...project }: ProjectSnapshot) => {
      const changedTests = tests.filter((test) => sentTests.get(test.id) !== test);
      return request("encode-incremental", { project, changedTests, testOrder: tests.map((test) => test.id) }, () => {
        sentTests = new Map(tests.map((test) => [test.id, test]));
      }) as Promise<string>;
    },
    dispose: () => close(new Error("Project editor closed")),
  };
}

