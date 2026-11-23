import { createHash } from "node:crypto";
import { readProjectBundle, writeProjectDirectory } from "./project-store.mjs";

export function projectRevision(bundle) {
  return `"${createHash("sha256").update(JSON.stringify(bundle)).digest("hex")}"`;
}

// Callers serialize saves. Checking inside that queue prevents a stale tab
// from replacing newly authored tests or metadata updated from the repository.
export async function saveProjectRevision(directory, payload, expectedRevision) {
  let current = null;
  try { current = await readProjectBundle(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const revision = current ? projectRevision(current) : "*";
  if (expectedRevision !== revision) {
    return { status: expectedRevision ? 409 : 428, revision, saved: false };
  }
  const result = await writeProjectDirectory(directory, payload);
  return { status: 200, revision: projectRevision(await readProjectBundle(directory)), saved: true, ...result };
}
