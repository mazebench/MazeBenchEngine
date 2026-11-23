import { createHash } from "node:crypto";
import { safeDirectory, safeReadFile } from "./safe-files.mjs";

const RECORDS = ["current_board.txt", "current_state.json", "moves.txt", "history.jsonl"];
const digest = text => createHash("sha256").update(text).digest("hex");
const moveDirectory = index => `move_history/move_${index}`;

export function moveRecordIndex(actions) {
  return [...RECORDS, "move_history/index.json", "move_history/move_0.txt", ...actions.slice(-100).flatMap(action => [
    `${moveDirectory(action.index)}.txt`,
    ...(action.animation ? [action.animation.index_record] : [])
  ])];
}

// Render and stage one frame at a time; only the small index lives in the
// signed action history. ASCII records never contain raw engine state.
export async function stageMoveAnimation({ action, frames, render, writeText, cycle = null }) {
  const directory = moveDirectory(action.index);
  const entries = [];
  for (const [index, frame] of frames.entries()) {
    const record = `${directory}/frame_${String(index).padStart(4, "0")}.txt`;
    const kind = index === 0 ? "before" : index === frames.length - 1 ? "final" : "animation";
    const { room, level, camera } = await render(frame);
    const content = `# move ${action.index} · ${action.action} · frame ${index}/${frames.length - 1} · ${kind} · ${room}\n${level}\n`;
    await writeText(`records/${record}`, content);
    entries.push({ index, record, kind, room, ...(camera ? { camera } : {}), sha256: digest(content) });
  }
  const indexRecord = `${directory}/index.json`;
  const content = JSON.stringify({ schema_version: 1, action_index: action.index, action: action.action,
    frame_count: entries.length, final_frame: entries.length - 1, cycle, frames: entries }, null, 2) + "\n";
  await writeText(`records/${indexRecord}`, content);
  return { frame_count: entries.length, index_record: indexRecord, index_sha256: digest(content) };
}

export function readMoveRecord(runDirectory, actions, actionCount, requested) {
  const record = String(requested || "").trim().replaceAll("\\", "/");
  const page = /^move_history\/page_(0|[1-9]\d*)\.json$/.exec(record);
  if (record === "move_history/index.json") return { record, content: JSON.stringify({ action_count: actionCount, page_size: 100,
    page_count: Math.ceil(actions.length / 100), first_page: actions.length ? "move_history/page_0.json" : null,
    latest_page: actions.length ? `move_history/page_${Math.floor((actions.length - 1) / 100)}.json` : null }) };
  if (page) {
    const n = Number(page[1]); if (!Number.isSafeInteger(n) || n * 100 >= actions.length) throw new Error("Unknown history page.");
    return { record, content: JSON.stringify({ page: n, next_page: (n + 1) * 100 < actions.length ? `move_history/page_${n + 1}.json` : null,
      files: actions.slice(n * 100, (n + 1) * 100).flatMap(a => [`${moveDirectory(a.index)}.txt`, ...(a.animation ? [a.animation.index_record] : [])]) }) };
  }
  const unknown = () => { throw new Error("Unknown benchmark record. Use a path from the records index or a move's animation index."); };
  const snapshot = /^move_history\/move_(0|[1-9]\d*)\.txt$/.exec(record);
  const animation = /^move_history\/move_([1-9]\d*)\/(index\.json|frame_\d{4,}\.txt)$/.exec(record);
  if (!RECORDS.includes(record) && !snapshot && !animation) unknown();
  const move = Number((snapshot || animation)?.[1]);
  const action = actions[move - 1]?.index === move ? actions[move - 1] : actions.find(a => a.index === move);
  if ((snapshot || animation) && (!Number.isSafeInteger(move) || move > actionCount || (move !== 0 && !action))) unknown();
  const recordsDirectory = safeDirectory(runDirectory, "records");
  if (!animation) return { record, content: safeReadFile(recordsDirectory, record) };
  const descriptor = action?.animation;
  const expectedIndex = `${moveDirectory(move)}/index.json`;
  if (!descriptor || descriptor.index_record !== expectedIndex) unknown();
  const indexText = safeReadFile(recordsDirectory, expectedIndex);
  if (digest(indexText) !== descriptor.index_sha256) throw new Error("Move animation index failed integrity verification.");
  if (record === expectedIndex) return { record, content: indexText };
  const index = JSON.parse(indexText);
  const entry = index.frames.find(frame => frame.record === record);
  if (!entry) unknown();
  const content = safeReadFile(recordsDirectory, record);
  if (digest(content) !== entry.sha256) throw new Error("Move animation frame failed integrity verification.");
  return { record, content };
}
