// Ice Maze uses its original 2D rules, independently of the voxel engine.
export const ICE_WORLD_ID = "ice-maze";
const directions = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const key = point => `${point.x},${point.y}`;

export function parseIceLevel(level) {
  const board = level.board;
  if (!Array.isArray(board) || board.length < 2 || board.length > 100 || !board.every(row => typeof row === "string" && row.length === board[0].length && /^[#.aeb]+$/.test(row)) || board[0].length < 2 || board[0].length > 100) throw new Error("Invalid Ice Maze board.");
  const players = [], goals = [];
  const terrain = board.map((row, y) => [...row].map((cell, x) => {
    if (cell === "a" || cell === "b") players.push({ x, y });
    if (cell === "e" || cell === "b") goals.push({ x, y });
    return cell === "#" ? "#" : ".";
  }));
  if (!players.length || !goals.length || goals.length > players.length) throw new Error("Ice Maze needs players and coverable goals.");
  return { id: level.id, width: board[0].length, height: board.length, terrain, players, goals };
}

export function goalsCovered(level, players) {
  const occupied = new Set(players.map(key));
  return level.goals.filter(goal => occupied.has(key(goal))).length;
}
export const iceSolved = (level, players) => goalsCovered(level, players) === level.goals.length;
export function validatePlayers(level, players) {
  if (!Array.isArray(players) || players.length !== level.players.length || new Set(players.map(key)).size !== players.length || players.some(p => !Number.isInteger(p.x) || !Number.isInteger(p.y) || level.terrain[p.y]?.[p.x] !== ".")) throw new Error("Invalid Ice Maze player state.");
}
export function normalizeIceAction(value) {
  const action = String(value || "").trim().toLowerCase();
  const aliases = { u: "up", r: "right", d: "down", l: "left" };
  if (aliases[action]) return aliases[action];
  if (directions[action] || ["undo", "reset", "next"].includes(action)) return action;
  throw new Error(`Unknown Ice Maze action: ${action}`);
}

export function slideIce(level, players, direction) {
  validatePlayers(level, players);
  const [dx, dy] = directions[normalizeIceAction(direction)] || [];
  if (dx === undefined) throw new Error("A slide needs up, right, down or left.");
  // Move the leading player first. All players receive the same command;
  // followers stop behind the leading players' final positions.
  const order = players.map((p, index) => ({ ...p, index })).sort((a, b) =>
    dx ? -dx * (a.x - b.x) || a.y - b.y : -dy * (a.y - b.y) || a.x - b.x);
  const occupied = new Set(), result = players.map(p => ({ ...p })), paths = players.map(p => [{ ...p }]);
  for (const start of order) {
    let x = start.x, y = start.y;
    while (level.terrain[y + dy]?.[x + dx] === "." && !occupied.has(`${x + dx},${y + dy}`)) {
      x += dx; y += dy;
      paths[start.index].push({ x, y });
    }
    result[start.index] = { x, y }; occupied.add(`${x},${y}`);
  }
  return { players: result, paths, changed: paths.some(p => p.length > 1), solved: iceSolved(level, result) };
}

export function iceAscii(level, players) {
  const board = level.terrain.map(row => [...row]);
  for (const p of level.goals) board[p.y][p.x] = "o";
  for (const p of players) board[p.y][p.x] = board[p.y][p.x] === "o" ? "@" : "P";
  return board.map(row => row.join("")).join("\n");
}

export class IceSession {
  constructor(level) { this.level = parseIceLevel(level); this.reset(); }
  reset() { this.players = this.level.players.map(p => ({ ...p })); this.history = []; this.moves = 0; }
  get solved() { return iceSolved(this.level, this.players); }
  move(direction) {
    if (this.solved) return { changed: false, solved: true, players: this.players, paths: this.players.map(p => [p]) };
    const result = slideIce(this.level, this.players, direction);
    if (result.changed) { this.history.push(this.players); this.players = result.players; this.moves++; }
    return result;
  }
  undo() {
    if (!this.history.length) return false;
    this.players = this.history.pop(); this.moves--; return true;
  }
}
