import { clonePlayState as cloneState } from "./presentation-identity.mjs";
import { countActiveRoleV1, engineStatesEqualV1 } from "../../engine/current/adapter.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MOVE_LETTERS = { up: "U", down: "D", left: "L", right: "R" };

export const DEFAULT_PLAY_FRAME_DELAY_MS = 20;

export class PlaySessionV1 {
  constructor(engine, definitions, callbacks = {}) {
    this.engine = engine;
    this.definitions = definitions;
    this.onFrame = callbacks.onFrame || (() => {});
    this.onChange = callbacks.onChange || (() => {});
    this.onRoomChange = callbacks.onRoomChange || (() => {});
    this.animateCommand = callbacks.animateCommand;
    this.animateReset = callbacks.animateReset;
    this.capturePresentation = callbacks.capturePresentation;
    this.resolveCommand = callbacks.resolveCommand || ((state, room, direction) =>
      this.engine.simulateCommand(state, direction, this.definitions));
    this.setFrameDelay(callbacks.frameDelay ?? DEFAULT_PLAY_FRAME_DELAY_MS);
    this.room = null;
    this.state = null;
    this.initialState = null;
    this.moves = 0;
    this.roomMoves = "";
    this.history = [];
    this.queue = [];
    this.running = false;
    this.generation = 0;
  }

  open(room) {
    this.animationController?.abort();
    this.pendingMove = null;
    this.generation += 1;
    this.room = room;
    this.initialState = this.engine.createState(room);
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.roomMoves = "";
    this.history.length = 0;
    this.queue.length = 0;
    this.running = false;
    this.publish();
    this.onFrame(this.state, this.room);
  }

  async reset() {
    if (!this.initialState) return;
    const state = this.state;
    const snapshot = this.capturePresentation?.();
    this.animationController?.abort();
    this.pendingMove = null;
    const generation = ++this.generation;
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.roomMoves = "";
    this.history.length = 0;
    this.queue.length = 0;
    this.running = Boolean(this.animateReset && this.frameDelay > 0);
    this.publish({ reset: true });
    try {
      if (this.running) {
        this.animationController = new AbortController();
        await this.animateReset({ state, resetState: this.state, room: this.room,
          snapshot, signal: this.animationController.signal });
      }
    } catch (error) {
      if (generation === this.generation) this.publish({ error: error.message });
    } finally {
      if (generation === this.generation) {
        this.animationController = null;
        this.running = false;
        this.onFrame(this.state, this.room);
        this.publish();
        if (this.queue.length) void this.drain();
      }
    }
  }

  undo() {
    if (!this.state) return false;
    // A command being presented has not entered history yet. Undo cancels it
    // and restores the exact pre-command snapshot, including on the first move.
    const pending = this.pendingMove;
    if (!pending && !this.history.length) return false;
    this.animationController?.abort();
    this.generation += 1;
    const previous = pending || this.history.pop();
    this.pendingMove = null;
    this.state = cloneState(previous.state);
    this.initialState = cloneState(previous.initialState);
    this.moves = previous.moves;
    this.roomMoves = previous.roomMoves;
    this.queue.length = 0;
    this.running = false;
    if (previous.room !== this.room) {
      this.room = previous.room;
      this.onRoomChange(this.room);
    }
    this.publish({ undone: true });
    this.onFrame(this.state, this.room);
    return true;
  }

  move(direction) {
    if (!this.state || this.queue.length >= 8 || this.playerCount < 1) return;
    this.queue.push(direction);
    return this.drain();
  }

  setFrameDelay(milliseconds) {
    const delay = Number(milliseconds);
    if (!Number.isFinite(delay) || delay < 0) {
      throw new RangeError("Animation frame delay must be a non-negative number.");
    }
    this.frameDelay = delay;
    return this.frameDelay;
  }

  get gemCount() {
    return this.state ? countActiveRoleV1(this.state, this.definitions, "goal") : 0;
  }

  get playerCount() {
    return this.state ? countActiveRoleV1(this.state, this.definitions, "player") : 0;
  }

  publish(extra = {}) {
    this.onChange({
      busy: this.running,
      gems: this.gemCount,
      moves: this.moves,
      roomMoves: this.roomMoves,
      playerActive: this.playerCount > 0,
      queued: this.queue.length,
      canUndo: Boolean(this.pendingMove) || this.history.length > 0,
      ...extra
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    const runGeneration = this.generation;
    this.publish();
    try {
      while (this.queue.length && runGeneration === this.generation) {
        const direction = this.queue.shift();
        const previous = {
          state: cloneState(this.state),
          initialState: cloneState(this.initialState),
          moves: this.moves,
          roomMoves: this.roomMoves,
          room: this.room
        };
        this.publish();
        const commandRoom = this.room;
        const simulation = await this.resolveCommand(
          this.state,
          this.room,
          direction,
          this.definitions
        );
        if (runGeneration !== this.generation) return;
        const instant = this.frameDelay === 0;
        const finalRoom = simulation.room || commandRoom;
        if (!instant) {
          this.pendingMove = previous;
          this.publish();
        }
        const presentFrame = frame => {
          if (runGeneration !== this.generation) return;
          if (frame.room !== this.room) {
            this.room = frame.room;
            this.onRoomChange(this.room);
          }
          this.state = frame.state;
          this.onFrame(this.state, this.room);
        };
        let animated = false;
        if (!instant && this.animateCommand) {
          this.animationController = new AbortController();
          animated = await this.animateCommand({
            state: previous.state, room: commandRoom, simulation,
            stepMs: this.frameDelay, signal: this.animationController.signal, presentFrame
          });
          if (runGeneration !== this.generation) return;
          this.animationController = null;
        }
        const frames = instant
          ? [{ state: simulation.final, room: finalRoom }]
          : simulation.animationFrames?.length
            ? simulation.animationFrames
            : (simulation.frames.length ? simulation.frames : [simulation.final])
              .map((state) => ({ state, room: commandRoom }));
        for (const frame of animated ? [] : frames) {
          if (runGeneration !== this.generation) return;
          presentFrame(frame);
          if (!instant) await wait(this.frameDelay);
        }
        if (runGeneration !== this.generation) return;
        this.pendingMove = null;
        this.state = simulation.final;
        if (finalRoom !== this.room) {
          this.room = finalRoom;
          this.onRoomChange(this.room);
        }
        if (finalRoom !== commandRoom) {
          this.initialState = cloneState(simulation.final);
        }
        if (animated) this.onFrame(this.state, this.room, {
          animated: true, preserveCameraPosition: Boolean(animated.preserveCameraPosition)
        });
        if (finalRoom !== commandRoom ||
            !engineStatesEqualV1(previous.state, simulation.final, this.definitions)) {
          this.history.push(previous);
          if (this.history.length > 256) this.history.shift();
          this.moves += 1;
          // A crossing establishes a new visit's starting state. Its command
          // belongs to the room we left, not the new room's replayable sequence.
          this.roomMoves = finalRoom === commandRoom ? previous.roomMoves + MOVE_LETTERS[direction] : "";
        }
        this.publish({ cycle: simulation.cycle });
        if (this.playerCount < 1) this.queue.length = 0;
      }
    } catch (error) {
      if (runGeneration !== this.generation) return;
      this.queue.length = 0;
      this.publish({ error: error?.message || "engine/v1 command failed." });
    } finally {
      if (runGeneration === this.generation) {
        this.pendingMove = null;
        this.animationController = null;
        this.running = false;
        this.publish();
      }
    }
  }
}
