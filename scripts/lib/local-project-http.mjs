import { readProjectBundle } from "./project-store.mjs";
import { projectRevision, saveProjectRevision } from "./project-revision.mjs";

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 25 * 1024 * 1024) throw new Error("Project data exceeds 25 MB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Shared by the main site and the standalone lab's Vite middleware.
// Both use the same split project store and reject stale browser saves.
export function createLocalProjectHandler(directory) {
  let saveQueue = Promise.resolve();
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/local-project") return false;
    if (request.method === "GET") {
      try {
        await saveQueue;
        const project = await readProjectBundle(directory);
        response.setHeader("ETag", projectRevision(project));
        sendJson(response, 200, project);
      } catch (error) {
        sendJson(response, error.code === "ENOENT" ? 404 : 500, {
          error: error.code === "ENOENT" ? "No repo-backed project exists yet" : "Could not read repo-backed project",
        });
      }
    } else if (request.method === "PUT") {
      try {
        const project = JSON.parse(await readRequestBody(request));
        const pendingSave = saveQueue.catch(() => {}).then(() => saveProjectRevision(
          directory, project, request.headers["if-match"] ?? request.headers["if-none-match"],
        ));
        saveQueue = pendingSave.then(() => {}, () => {});
        const result = await pendingSave;
        if (!result.saved) {
          sendJson(response, result.status, {
            saved: false,
            error: "The project changed on disk. Export your browser draft before reloading the saved project.",
          });
        } else {
          response.setHeader("ETag", result.revision);
          sendJson(response, 200, {
            path: "project-data/project.json", saved: true,
            tests: result.tests ?? 0, changedTests: result.changedTests ?? 0,
          });
        }
      } catch (error) {
        sendJson(response, 500, { error: error.message || "Could not save repo-backed project" });
      }
    } else {
      response.setHeader("Allow", "GET, PUT");
      sendJson(response, 405, { error: "Method not allowed" });
    }
    return true;
  };
}
