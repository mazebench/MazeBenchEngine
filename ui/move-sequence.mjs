const directions = { U: "up", D: "down", L: "left", R: "right" };

export function parseMoveSequence(text) {
  const result = [];
  for (const character of String(text).toUpperCase()) {
    if (/[\s,]/u.test(character)) continue;
    const direction = directions[character];
    if (!direction) throw new Error(`Unknown character “${character}”. Use U, D, L and R, with optional spaces or commas.`);
    result.push(direction);
  }
  if (!result.length) throw new Error("Paste a UDLR sequence first.");
  return result;
}

export class MoveSequencePlayer {
  constructor(getSession, onChange, yieldControl = () => new Promise(resolve => setTimeout(resolve, 0))) {
    this.getSession = getSession;
    this.onChange = onChange;
    this.yieldControl = yieldControl;
    this.running = false;
    this.completed = 0;
    this.total = 0;
    this.reason = "";
    this.failed = false;
  }

  publish(message) {
    this.onChange({ running: this.running, completed: this.completed, total: this.total, message });
  }

  stop(reason = "Stopped", failed = false) {
    if (!this.running) return;
    this.reason = reason;
    this.failed ||= failed;
    this.publish("Stopping after the current move…");
  }

  async run(text) {
    if (this.running) return;
    const sequence = parseMoveSequence(text);
    const session = this.getSession();
    if (!session?.state) throw new Error("Wait for the room to finish loading.");
    if (session.running) throw new Error("Wait for the current move to finish.");
    if (session.playerCount < 1) throw new Error("Undo or reset before running a sequence.");
    const generation = session.generation;
    this.running = true;
    this.completed = 0;
    this.total = sequence.length;
    this.reason = "";
    this.failed = false;
    this.publish(`Playing 0 / ${this.total} moves…`);
    try {
      for (const direction of sequence) {
        if (this.reason) break;
        if (session !== this.getSession() || session.generation !== generation) {
          this.reason = "Stopped: game state changed";
          break;
        }
        // Solver routes use world directions, independent of the camera.
        // Await each command so long sequences never overflow Play's input queue.
        await session.move(direction);
        if (session.generation !== generation) {
          this.reason ||= "Stopped: game state changed";
          break;
        }
        if (this.failed) break;
        this.completed++;
        if (session.playerCount < 1) this.reason = "Stopped: player fell; undo or reset to recover";
        this.publish(this.reason ? `${this.reason}.` : `Playing ${this.completed} / ${this.total} moves…`);
        await this.yieldControl();
      }
    } catch (error) {
      this.reason = error.message || "Sequence failed";
    } finally {
      this.running = false;
      this.publish(this.reason
        ? `${this.reason} · ${this.completed} / ${this.total} moves.`
        : `Finished ${this.total} moves.`);
    }
  }
}
