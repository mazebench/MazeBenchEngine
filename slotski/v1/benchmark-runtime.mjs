import { createJournal, attachJournal, summaryHistory } from "../../benchmarking/storage/journal.mjs";
import { readCheckpointJson } from "../../benchmarking/v1/checkpoint-json.mjs";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { signCheckpoint, verifyCheckpoint } from "../../benchmarking/v1/integrity.mjs";
import { safeDirectory, safeReadFile } from "../../benchmarking/v1/safe-files.mjs";
import { moveRecordIndex, readMoveRecord, stageMoveAnimation } from "../../benchmarking/v1/move-animation.mjs";
import { parseSlotskiLevel, validateBlocks, moveSlotski, slotskiSolved, slotskiAscii, normalizeSlotskiAction, expandSlotskiSequence, validateSlotskiAction } from "./engine.mjs";
export { expandSlotskiSequence } from "./engine.mjs";

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const terminal = status => ["won", "action-limit"].includes(status);
export class SlotskiBenchmarkRuntime {
  constructor(projectRoot, runDirectory, world, internal) {
    this.projectRoot = projectRoot; this.runDirectory = runDirectory; this.world = world; this.internal = internal;
    if (world.levels.length !== 1 || internal.version !== "slotski-v1") throw new Error("Invalid Slotski checkpoint.");
    this.level = parseSlotskiLevel(world.levels[0]);
    validateBlocks(this.level, internal.blocks);
    for (const blocks of internal.history) validateBlocks(this.level, blocks);
  }
  static async assets(root) { return JSON.parse(await readFile(path.join(root, "level-data/slotski/v1/world.json"), "utf8")); }
  static async create(root, directory, { actionLimit = 100, incremental = false } = {}) {
    if (actionLimit !== null && (!Number.isSafeInteger(actionLimit) || actionLimit < 1)) throw new Error("Invalid action budget.");
    const world = await this.assets(root), first = parseSlotskiLevel(world.levels[0]);
    const internal = { version: "slotski-v1", blocks: clone(first.blocks), history: [], actionCount: 0, actionLimit,
      actions: [], stateHashes: [], positions: [], blockedActions: 0, resets: 0, undos: 0, updatedAt: now() };
    const runtime = new this(root, directory, world, internal);
    for (const name of ["workspace", "sandbox-state", "records/move_history", "display-history"]) await mkdir(path.join(directory, name), { recursive: true, mode: 0o700 });
    internal.stateHashes.push(runtime.stateHash()); internal.positions.push(runtime.position(first.target));
    await runtime.persist(); if(incremental)await runtime.enableIncremental(); return runtime;
  }
  static async open(root, directory) {
    verifyCheckpoint(directory);
    const runtime = new this(root, directory, await this.assets(root), await readCheckpointJson(directory));
    runtime.journal = await attachJournal(directory, runtime.internal, runtime.summary({compact:true}));
    return runtime;
  }
  get room() { return "Level 1"; }
  stateHash() {
    // Only the labelled board counts. History, action counter and selected block
    // do not make a repeated arrangement novel.
    const state = this.internal.blocks.map(b => [b.id, b.x, b.y]).sort((a, b) => a[0].localeCompare(b[0]));
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
  }
  position(id) {
    const b = this.internal.blocks.find(b => b.id === id);
    return { room: this.room, block: b.id, localX: b.x, localY: b.y, worldX: b.x, worldY: b.y, z: 0 };
  }
  status() {
    if (slotskiSolved(this.level, this.internal.blocks)) return "won";
    return this.internal.actionLimit !== null && this.internal.actionCount >= this.internal.actionLimit ? "action-limit" : "playing";
  }
  recordIndex() { return moveRecordIndex(this.internal.actions); }
  async readRecord(value) {
    if (this.persistenceError) throw this.persistenceError;
    if(this.journal){
      const record=String(value||"").trim();
      if(record==="moves.txt")return{record,content:this.internal.actions.map(a=>a.action).join("\n")+"\n"};
      if(record==="history.jsonl")return{record,content:this.internal.actions.map(a=>JSON.stringify(a)).join("\n")+"\n"};
      if(["current_state.json","current_board.txt"].includes(record)){const o=await this.renderObservation();return{record,content:record==="current_board.txt"?o.level+"\n":JSON.stringify({...o,level:undefined,records:undefined})};}
    }
    return readMoveRecord(this.runDirectory, this.internal.actions, this.internal.actionCount, value);
  }
  async renderObservation({ includeColor = false } = {}) {
    if (this.persistenceError) throw this.persistenceError;
    const s = this.internal, level = slotskiAscii(this.level, s.blocks), target = s.blocks.find(b => b.id === this.level.target);
    return { schema_version: 1, world: "slotski", topology: "single-level", observation_revision: s.actionCount, game_status: this.status(), room: this.room,
      level_number: 1, levels_total: 1, levels_solved: Number(this.status() === "won"), board_width: this.level.width, board_height: this.level.height,
      blocks: clone(s.blocks), target_block: this.level.target, target_row: target.y, exit: { edge: "bottom", x: this.level.exit_x, width: 2, winning_target_y: this.level.height - 2 },
      action_count: s.actionCount, action_limit: s.actionLimit, actions_remaining: s.actionLimit === null ? null : Math.max(0, s.actionLimit - s.actionCount),
      state_hash: s.stateHashes.at(-1), novel_state: s.actions.at(-1)?.novel ?? true, level,
      ...(includeColor ? { colored_level: level.split("\n").map(row => [...row].map(text => ({ text,
        color: text === this.level.target ? "#ff9e80" : text === "v" ? "#53deb5" : text === "#" ? "#8295a5" : text === "." ? "#53626e" : "#93c9ef" }))) } : {}),
      ascii_legend: `Repeated letters are cells of one block; ${this.level.target} is the 2×2 target. . empty · # boundary · vv bottom exit. Move one block one cell; no pushing or rotation. Win when ${this.level.target}'s top-left is (${this.level.exit_x}, ${this.level.height - 2}). Coordinates: x right, y down, zero-based.`,
      recent_actions: s.actions.slice(-12), records: { read_with: "maze_observe({record: <relative path>})", files: this.recordIndex() },
      allowed_actions: terminal(this.status()) ? [] : ["<block letter><U|D|L|R>", "block <letter> move <up|down|left|right>", "undo", "reset"] };
  }
  async apply(input) {
    if (this.persistenceError) throw this.persistenceError;
    const action = normalizeSlotskiAction(input), s = this.internal;
    validateSlotskiAction(this.level, action);
    if (terminal(this.status())) throw new Error("This benchmark has reached its terminal state.");
    const before = this.stateHash(), beforeFrame = slotskiAscii(this.level, s.blocks);
    if (action === "undo") { if (s.history.length) s.blocks = s.history.pop(); s.undos++; }
    else if (action === "reset") { s.blocks = clone(this.level.blocks); s.history = []; s.resets++; }
    else {
      const move = moveSlotski(this.level, s.blocks, action);
      if (move.changed) { s.history.push(clone(s.blocks)); s.blocks = move.blocks; }
    }
    const after = this.stateHash(), novel = !s.stateHashes.includes(after), changed = before !== after;
    const movement = /^[A-Z][UDLR]$/.test(action), blocked = movement && !changed;
    if (blocked) s.blockedActions++;
    s.actionCount++; s.updatedAt = now(); s.stateHashes.push(after);
    const position = this.position(movement ? action[0] : this.level.target);
    s.positions.push(position);
    const record = { index: s.actionCount, action, at: s.updatedAt, roomBefore: this.room, roomAfter: this.room, level: 1,
      stateChanged: changed, moved: changed, blocked, died: false, novel, stateHash: after, blocks: clone(s.blocks), player: position,
      block: movement ? action[0] : null, levelsSolved: Number(slotskiSolved(this.level, s.blocks)) };
    s.actions.push(record);
    await this.persist({ animationFrames: [{ room: this.room, level: beforeFrame }, { room: this.room, level: slotskiAscii(this.level, s.blocks) }] });
    return { action: record, observation: await this.renderObservation() };
  }
  async applySequence(input) {
    const actions = expandSlotskiSequence(input), steps = [];
    // Validate the entire request before mutating, including unknown labels.
    for (const action of actions) validateSlotskiAction(this.level, action);
    for (const action of actions) {
      if (terminal(this.status())) break;
      const result = await this.apply(action);
      steps.push({ action: result.action, status: { game_status: result.observation.game_status, action_count: result.observation.action_count } });
    }
    return { requested_count: actions.length, completed_count: steps.length, stopped_early: steps.length < actions.length, steps, final_observation: await this.renderObservation() };
  }
  summary({compact=false}={}) {
    const s = this.internal, target = s.blocks.find(b => b.id === this.level.target);
    return { schema_version: 1, world: "slotski", updated_at: s.updatedAt, game_status: this.status(), action_count: s.actionCount, action_limit: s.actionLimit,
      room: this.room, level_number: 1, levels_total: 1, levels_solved: Number(this.status() === "won"), block_count: s.blocks.length, target_row: target.y,
      board_width: this.level.width, board_height: this.level.height, target_block: this.level.target,
      ...summaryHistory(this,{compact}),
      blocked_actions: s.blockedActions, resets: s.resets, undos: s.undos, deaths: 0, camera_actions: 0 };
  }
  async enableIncremental() {
    const display = JSON.parse(await readFile(path.join(this.runDirectory,"display.json"),"utf8"));
    this.journal = await createJournal(this.runDirectory,this.internal,this.summary(),display,await this.renderObservation());
    this.journal.setSummary(this.summary({compact:true}));
  }
  async persist({ animationFrames = null } = {}) {
    if (this.persistenceError) throw this.persistenceError;
    let staging;
    try {
      staging = await mkdtemp(path.join(this.runDirectory, ".checkpoint-"));
      const artifacts = [];
      const writeText = async (relative, value) => {
        const file = path.join(staging, relative);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, value, { flag: "wx", mode: 0o600 });
        artifacts.push(relative);
      };
      if (animationFrames) this.internal.actions.at(-1).animation = await stageMoveAnimation({
        action: this.internal.actions.at(-1), frames: animationFrames, render: frame => frame, writeText
      });
      const o = await this.renderObservation({ includeColor: true }), s = this.internal;
      const display = { observation_revision: o.observation_revision, room: o.room, world: "slotski", level: o.level, colored_level: o.colored_level, ascii_legend: o.ascii_legend };
      if(this.journal){
        await writeText(`records/move_history/move_${s.actionCount}.txt`, `# move ${s.actionCount} · ${s.actions.at(-1)?.action || "initial"} · ${o.room}\n${o.level}\n`);
        await writeText(`display-history/move_${s.actionCount}.json`,JSON.stringify(display));
        await this.journal.commit(s,this.summary({compact:true}),display,{staging,artifacts,observation:{...o,level:undefined,colored_level:undefined,records:undefined}});return;
      }
      const files = { "game-state.json": JSON.stringify(s), "summary.json": JSON.stringify(this.summary()), "display.json": JSON.stringify(display),
        "records/current_board.txt": o.level + "\n", "records/current_state.json": JSON.stringify({ ...o, level: undefined, colored_level: undefined, records: undefined }),
        "records/moves.txt": s.actions.map(a => a.action).join("\n") + "\n", "records/history.jsonl": s.actions.map(a => JSON.stringify(a)).join("\n") + "\n",
        [`records/move_history/move_${s.actionCount}.txt`]: `# move ${s.actionCount} · ${s.actions.at(-1)?.action || "initial"} · ${o.room}\n${o.level}\n`,
        [`display-history/move_${s.actionCount}.json`]: JSON.stringify(display) };
      for (const [name, value] of Object.entries(files)) await writeText(name, value);
      const signed = await signCheckpoint(this.runDirectory, { artifactsDirectory: staging });
      for (const relative of artifacts) {
        if (path.dirname(relative) !== ".") safeDirectory(this.runDirectory, path.dirname(relative), { create: true });
        await rename(path.join(staging, relative), path.join(this.runDirectory, relative));
      }
      if (signed) await rename(path.join(staging, "checkpoint.json"), path.join(this.runDirectory, "checkpoint.json"));
    } catch (error) {
      this.persistenceError = new Error(`Benchmark save failed; reopen the last verified checkpoint: ${error.message}`, { cause: error });
      throw this.persistenceError;
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
