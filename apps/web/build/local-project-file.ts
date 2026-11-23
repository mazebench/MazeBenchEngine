import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { createLocalProjectHandler } from "../../../scripts/lib/local-project-http.mjs";

export function localProjectFile(): Plugin {
  const handle = createLocalProjectHandler(fileURLToPath(new URL("../../../project-data", import.meta.url)));
  return {
    name: "voxelbench-local-project-file",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!await handle(request, response)) next();
      });
    },
  };
}
