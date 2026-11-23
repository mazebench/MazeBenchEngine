import { closeSync, createReadStream, readFileSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { safeOpenFile } from "./safe-files.mjs";

// Valid JSON, with one top-level field or array element per line. In particular,
// undo history never becomes one enormous V8 string. Ordinary JSON tools can
// still read the file; the runtime streams this layout when it exceeds 512 MB.
// The tab on the first line distinguishes it from legacy pretty/compact saves.
const PREFIX = "{\t\n";

export async function writeCheckpointJson(file, value) {
  const handle = await open(file, "wx", 0o600);
  try {
    let pending = PREFIX;
    async function append(text) {
      pending += text;
      if (pending.length >= 256 * 1024) {
        await handle.writeFile(pending, "utf8");
        pending = "";
      }
    }
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    for (const [index, [key, item]] of entries.entries()) {
      const suffix = index === entries.length - 1 ? "\n" : ",\n";
      if (Array.isArray(item)) {
        await append(`${JSON.stringify(key)}:[\n`);
        for (let i = 0; i < item.length; i++) {
          await append(`${JSON.stringify(item[i]) ?? "null"}${i === item.length - 1 ? "\n" : ",\n"}`);
        }
        await append(`]${suffix}`);
      } else {
        await append(`${JSON.stringify(key)}:${JSON.stringify(item)}${suffix}`);
      }
    }
    await append("}\n");
    if (pending) await handle.writeFile(pending, "utf8");
  } finally { await handle.close(); }
}

export async function readCheckpointJson(root, relative = "game-state.json") {
  const fd = safeOpenFile(root, relative);
  let input;
  try {
    const header = Buffer.alloc(Buffer.byteLength(PREFIX));
    readSync(fd, header, 0, header.length, 0);
    if (header.toString() !== PREFIX) {
      const value = JSON.parse(readFileSync(fd, "utf8"));
      if (value?.storage === "incremental-v1") {
        const { readJournal, readJournalSummary } = await import("../storage/journal.mjs");
        return value.kind === "summary" ? readJournalSummary(root) : readJournal(root, value.kind);
      }
      return value;
    }
    input = createReadStream(null, { fd, start: header.length, encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const result = {};
    let array = null, needsItem = false, needsField = false, ended = false;
    for await (const line of lines) {
      if (ended) throw new Error("Unexpected data after checkpoint JSON.");
      const comma = line.endsWith(",");
      const body = comma ? line.slice(0, -1) : line;
      if (array) {
        if (body === "]") {
          if (needsItem) throw new Error("Incomplete checkpoint array.");
          array = null;
          needsField = comma;
        } else {
          if (array.length && !needsItem) throw new Error("Missing checkpoint array separator.");
          array.push(JSON.parse(body));
          needsItem = comma;
        }
      } else if (body === "}" && !comma) {
        if (needsField) throw new Error("Incomplete checkpoint object.");
        ended = true;
      } else {
        if (Object.keys(result).length && !needsField) throw new Error("Missing checkpoint field separator.");
        const isArray = line.endsWith(":[");
        const field = JSON.parse(`{${isArray ? line.slice(0, -1) + "[]" : body}}`);
        const keys = Object.keys(field);
        if (keys.length !== 1 || Object.hasOwn(result, keys[0])) throw new Error("Invalid checkpoint field.");
        Object.defineProperty(result, keys[0], { value: field[keys[0]], enumerable: true, writable: true, configurable: true });
        if (isArray) { array = result[keys[0]]; needsItem = false; }
        else needsField = comma;
      }
    }
    if (!ended || array) throw new Error("Truncated checkpoint JSON.");
    return result;
  } finally {
    if (input) {
      input.destroy();
      await finished(input, { cleanup: true }).catch(() => {});
    } else closeSync(fd);
  }
}
