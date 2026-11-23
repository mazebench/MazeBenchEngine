// Pure game rules shared by human play and the authoritative benchmark runtime.
// No search, hint, solution, teleport, or state-setting action is exposed.
const directions = { U: [0, -1], R: [1, 0], D: [0, 1], L: [-1, 0] };
export const MAX_SEQUENCE = 1000;

export function expandSlotskiSequence(input) {
  const parts = Array.isArray(input) ? input : [input];
  if (!parts.length || parts.length > MAX_SEQUENCE) throw new Error("Supply 1–1000 Slotski actions.");
  const actions = [];
  for (const part of parts) {
    if (typeof part !== "string" || !part.trim() || part.length > 32_000) throw new Error("Supply a Slotski action string.");
    let rest = part.trim();
    while (rest) {
      const special = /^(undo|reset)(?=[\s,]|$)/i.exec(rest);
      const move = special ? null : /^(?:block\s+)?([a-z])\s*(?:move\s+)?(up|down|left|right|[udlr])(?:\s*(\d+)(?:\s+times?)?)?(?=[\s,]|$)/i.exec(rest);
      if (!special && !move) throw new Error('Use a block and direction, such as "AU", "block A move up", or "a up 3 times".');
      const count = move?.[3] === undefined ? 1 : Number(move[3]);
      if (!Number.isSafeInteger(count) || count < 1 || actions.length + count > MAX_SEQUENCE) throw new Error("A sequence must expand to 1–1000 one-cell actions.");
      const action = special ? special[1].toLowerCase() : move[1].toUpperCase() + move[2][0].toUpperCase();
      actions.push(...Array(count).fill(action));
      rest = rest.slice((special || move)[0].length).replace(/^[\s,]+/, "");
    }
  }
  return actions;
}

export function normalizeSlotskiAction(input) {
  const actions = expandSlotskiSequence(input);
  if (actions.length !== 1) throw new Error("maze_action accepts one one-cell move; use maze_sequence for repeats or multiple moves.");
  return actions[0];
}

export function validateBlocks(level, blocks) {
  if (!Array.isArray(blocks) || blocks.length !== level.blocks.length) throw new Error("Invalid Slotski block count.");
  const occupied = new Set(), ids = new Set();
  for (const block of blocks) {
    const authored = level.blocks.find(b => b.id === block.id);
    if (!authored || ids.has(block.id) || block.width !== authored.width || block.height !== authored.height ||
        !Number.isInteger(block.x) || !Number.isInteger(block.y) || block.x < 0 || block.y < 0 ||
        block.x + block.width > level.width || block.y + block.height > level.height) throw new Error("Invalid Slotski block position or shape.");
    ids.add(block.id);
    for (let y = block.y; y < block.y + block.height; y++) for (let x = block.x; x < block.x + block.width; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) throw new Error("Slotski blocks overlap.");
      occupied.add(key);
    }
  }
}

export function parseSlotskiLevel(source) {
  const level = structuredClone(source);
  if (!Number.isInteger(level.width) || !Number.isInteger(level.height) || level.width < 2 || level.height < 2 ||
      level.width > 26 || level.height > 26 || !Array.isArray(level.blocks) || !level.blocks.length || level.blocks.length > 26 ||
      level.blocks.some(b => !/^[A-Z]$/.test(b.id) || !Number.isInteger(b.width) || !Number.isInteger(b.height) || b.width < 1 || b.height < 1)) throw new Error("Invalid Slotski level.");
  const target = level.blocks.find(b => b.id === level.target);
  if (!target || target.width !== 2 || target.height !== 2 || !Number.isInteger(level.exit_x) || level.exit_x < 0 || level.exit_x + 2 > level.width) throw new Error("Invalid Slotski target or exit.");
  validateBlocks(level, level.blocks);
  return level;
}

export function validateSlotskiAction(level, action) {
  if (["undo", "reset"].includes(action)) return;
  if (!/^[A-Z][URDL]$/.test(action) || !level.blocks.some(b => b.id === action[0])) throw new Error(`Unknown Slotski block or direction: ${action}.`);
}

export function moveSlotski(level, blocks, input) {
  const action = normalizeSlotskiAction(input);
  validateSlotskiAction(level, action);
  if (["undo", "reset"].includes(action)) throw new Error("Undo and reset are handled by move history.");
  validateBlocks(level, blocks);
  const next = structuredClone(blocks), block = next.find(b => b.id === action[0]);
  const [dx, dy] = directions[action[1]], x = block.x + dx, y = block.y + dy;
  const blocked = x < 0 || y < 0 || x + block.width > level.width || y + block.height > level.height ||
    next.some(b => b.id !== block.id && x < b.x + b.width && x + block.width > b.x && y < b.y + b.height && y + block.height > b.y);
  if (!blocked) { block.x = x; block.y = y; }
  return { blocks: next, changed: !blocked };
}

export function slotskiSolved(level, blocks) {
  const target = blocks.find(b => b.id === level.target);
  return target.x === level.exit_x && target.y === level.height - target.height;
}

export function slotskiAscii(level, blocks) {
  const grid = Array.from({ length: level.height }, () => Array(level.width).fill("."));
  for (const b of blocks) for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) grid[y][x] = b.id;
  const bottom = Array(level.width + 2).fill("#");
  bottom[level.exit_x + 1] = bottom[level.exit_x + 2] = "v";
  return ["#".repeat(level.width + 2), ...grid.map(row => `#${row.join("")}#`), bottom.join("")].join("\n");
}
