const DIRECTIONS = { u: "up", d: "down", l: "left", r: "right", up: "up", down: "down", left: "left", right: "right" };
const MAX_COMMANDS = 250000;

export function roomName(value) {
  if (Array.isArray(value)) value = value.join("x");
  if (value && typeof value === "object") value = value.room ?? value.roomId ?? value.fileName ?? value.position;
  if (Array.isArray(value)) value = value.join("x");
  if (typeof value !== "string" || !value.trim()) return null;
  const label = value.trim().match(/^([a-p])\s*[x×]\s*([a-p])$/i);
  return label ? `${label[1].toUpperCase()}x${label[2].toUpperCase()}` : value.trim();
}

function textCommands(text, output) {
  // Parse complete tokens; never mine direction letters from prose/metadata.
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [lineIndex, raw] of lines.entries()) {
    let line = raw.replace(/(?:#|\/\/).*$/, "").trim();
    if (!line) continue;
    const start = line.match(/^start(?:ing)?(?:\s+room)?\s*[:=]\s*(.+)$/i);
    if (start) { output.start = roomName(start[1]); continue; }
    line = line.replace(/^\d+[.)]\s+/, "");
    const tokens = line.split(/[\s,;]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      if (token === "room") {
        const room = roomName(tokens[++i]);
        if (!room) throw new Error(`Missing room after “room” on line ${lineIndex + 1}.`);
        output.commands.push({ type: "room", room });
      } else if (DIRECTIONS[token]) output.commands.push({ type: "move", direction: DIRECTIONS[token] });
      else if (/^[udlr]+$/i.test(token)) {
        if (output.commands.length + token.length > MAX_COMMANDS) throw new Error("This replay exceeds 250,000 commands. Import a shorter sequence.");
        for (const letter of token) output.commands.push({ type: "move", direction: DIRECTIONS[letter] });
      } else throw new Error(`Unknown command “${tokens[i]}” on line ${lineIndex + 1}. Use UDLR or room HxI.`);
      if (output.commands.length > MAX_COMMANDS) throw new Error("This replay exceeds 250,000 commands. Import a shorter sequence.");
    }
  }
}

function jsonCommands(value, output) {
  if (typeof value === "string") return textCommands(value, output);
  if (!Array.isArray(value)) throw new Error("The JSON needs a commands or actions list.");
  for (const [index, action] of value.entries()) {
    if (typeof action === "string") { textCommands(action, output); continue; }
    if (!action || typeof action !== "object") throw new Error(`Invalid action ${index + 1}.`);
    const kind = String(action.type ?? action.kind ?? action.action ?? "").toLowerCase();
    if (kind === "room" || kind === "room_switch" || kind === "switch_room") {
      const room = roomName(action.room ?? action.roomId ?? action.target ?? action.destination ?? action.value ?? action.args?.room);
      if (!room) throw new Error(`Action ${index + 1} has no room.`);
      output.commands.push({ type: "room", room });
    } else {
      const command = action.command ?? action.direction ?? action.move ?? action.actions ?? action.moves ?? action.action;
      if (typeof command !== "string" && !Array.isArray(command)) throw new Error(`Action ${index + 1} has no move command.`);
      jsonCommands(command, output);
    }
    if (output.commands.length > MAX_COMMANDS) throw new Error("This replay exceeds 250,000 commands. Import a shorter sequence.");
  }
}

export function parseReplay(text, { start = "HxI", name = "Untitled replay" } = {}) {
  const output = { name, start: roomName(start) || "HxI", commands: [] };
  const source = String(text).replace(/^\uFEFF/, "").trim();
  if (!source) throw new Error("Choose a file or paste a move sequence first.");
  if (source.length > 20 * 1024 * 1024) throw new Error("Choose a replay smaller than 20 MB.");
  if (/^[\[{]/.test(source)) {
    let saved;
    try { saved = JSON.parse(source); } catch { throw new Error("This file is not valid JSON."); }
    const full = saved.fullSolution ?? saved.solution ?? saved;
    output.start = roomName(full.startRoom ?? full.startingRoom ?? full.start ?? saved.startRoom ?? saved.startingRoom ?? saved.start) || output.start;
    output.name = saved.title || saved.name || name;
    const commands = Array.isArray(full) ? full : full.commands ?? full.actions ?? full.moves ?? full.sequence;
    if (commands !== undefined) jsonCommands(commands, output);
    else if (saved.format === "mazebench-solutions-v1" && Array.isArray(saved.routes)) return { ...output, saved };
    else throw new Error("No commands found. Choose a full-solution or verbose Solutions export.");
    if (full.complete === false) output.notice = "This export contains a partial solution. Only its included commands will play.";
  } else textCommands(source, output);
  if (!output.commands.length) throw new Error("This replay has no moves or room commands.");
  return output;
}

export function resolveRoom(world, value) {
  const name = roomName(value);
  const room = world.rooms.find(room => room.fileName === name || room.position?.join("x") === name);
  if (!room) throw new Error(`Room “${value}” does not exist in this world.`);
  return room;
}
