// Antigravity offloads large MCP responses to host files. Keep all model-visible
// chunks small and expose lossless, content-addressed pages ONLY via maze_observe.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { safeDirectory, safeReadFile } from "../v1/safe-files.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");
export function splitResponse(text, maximum = 2400) {
  const pages = [];
  let page = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maximum) { pages.push(page); page = ""; bytes = 0; }
    page += char; bytes += size;
  }
  pages.push(page);
  return pages;
}
function resultPage(text, sha, index, isError = false) {
  const pages = splitResponse(text);
  if (!Number.isSafeInteger(index) || index < 0 || index >= pages.length) throw new Error("Unknown response page.");
  const next = index + 1 < pages.length ? "Continue by calling maze_observe with record=\"response_pages/" + sha + "/" + (index + 1) + ".txt\"." : "End of response.";
  const header = "Read-only MazeBench response, page " + (index + 1) + "/" + pages.length + ". " + next + "\n---\n";
  return { content: [{ type: "text", text: header + pages[index] }], isError };
}
export function boundToolResult(directory, result) {
  if (!Array.isArray(result?.content) || result.content.some(block => block.type !== "text")) return result;
  const text = result.content.map(block => block.text).join("\n");
  // Drop duplicated structuredContent: the same data remains losslessly in text.
  if (Buffer.byteLength(text) <= 2400) return { content: result.content, isError: Boolean(result.isError) };
  const sha = hash(text);
  const parent = safeDirectory(directory, "response-pages", { create: true });
  try { writeFileSync(path.join(parent, sha + ".txt"), text, { flag: "wx", mode: 0o400 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (hash(safeReadFile(directory, "response-pages/" + sha + ".txt")) !== sha) throw new Error("Cached response integrity failure.");
  return resultPage(text, sha, 0, Boolean(result.isError));
}
export function readResponsePage(directory, record) {
  const match = /^response_pages\/([a-f0-9]{64})\/(0|[1-9][0-9]{0,6})\.txt$/.exec(record);
  if (!match) throw new Error("Invalid read-only response page.");
  const text = safeReadFile(directory, "response-pages/" + match[1] + ".txt");
  if (hash(text) !== match[1]) throw new Error("Cached response integrity failure.");
  return resultPage(text, match[1], Number(match[2]));
}

