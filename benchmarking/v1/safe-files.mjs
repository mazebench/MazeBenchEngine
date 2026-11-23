import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

function entryInfo(candidate) {
  try { return lstatSync(candidate); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function safeDirectory(parent, relative, { create = false } = {}) {
  const root = realpathSync(parent);
  const parts = String(relative).split(/[\\/]/);
  if (!parts.length || parts.some(p => !p || p === "." || p === "..")) throw new Error("Unsafe directory path.");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (create && !entryInfo(current)) mkdirSync(current, { mode: 0o700 });
    const info = entryInfo(current);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace directories must not contain symbolic links.");
  }
  return current;
}

// The caller owns the returned descriptor. Streaming readers use the same
// no-symlink/no-hardlink boundary as small record reads.
export function safeOpenFile(root, relative) {
  const parts = String(relative).split("/");
  const name = parts.pop();
  if (!name || name === "." || name === ".." || name.includes("\\")) throw new Error("Unsafe file path.");
  const directory = parts.length ? safeDirectory(root, parts.join("/")) : realpathSync(root);
  const fd = openSync(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Records must be regular files without links.");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

export function safeReadFile(root, relative, encoding = "utf8") {
  const fd = safeOpenFile(root, relative);
  try { return readFileSync(fd, encoding); }
  finally { closeSync(fd); }
}

export function writeWorkspaceScript(workspace, relative, source) {
  const parts = relative.split("/");
  const name = parts.pop();
  const directory = parts.length ? safeDirectory(workspace, parts.join("/"), { create: true }) : realpathSync(workspace);
  const destination = path.join(directory, name);
  const existing = entryInfo(destination);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error("Python scripts must be regular files without symbolic or hard links.");
  }
  // Do not open/truncate/chmod an agent-controlled destination. A new inode
  // followed by rename cannot follow a final symlink or modify a hardlink target.
  // The sandbox forbids child processes, and the previous interpreter has exited
  // before this writer runs, so agent code cannot race the checked parent chain.
  const temporary = path.join(directory, `.script-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}
