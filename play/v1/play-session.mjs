import { countActiveRoleV1, engineStatesEqualV1 } from "../../engine/v1/adapter.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const DEFAULT_PLAY_FRAME_DELAY_MS = 20;

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    objects: state.objects.map((object) => ({ ...object }))
  };
}

export class PlaySessionV1 {
  constructor(engine, definitions, callbacks = {}) {
    this.engine = engine;
    this.definitions = definitions;
    this.onFrame = callbacks.onFrame || (() => {});
    this.onChange = callbacks.onChange || (() => {});
    this.onRoomChange = callbacks.onRoomChange || (() => {});
    this.resolveCommand = callbacks.resolveCommand || ((state, room, direction) =>
      this.engine.simulateCommand(state, direction, this.definitions));
    this.setFrameDelay(callbacks.frameDelay ?? DEFAULT_PLAY_FRAME_DELAY_MS);
    this.room = null;
    this.state = null;
    this.initialState = null;
    this.moves = 0;
    this.history = [];
    this.queue = [];
    this.running = false;
    this.generation = 0;
  }

  open(room) {
    this.generation += 1;
    this.room = room;
    this.initialState = this.engine.createState(room);
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.history.length = 0;
    this.queue.length = 0;
    this.running = false;
    this.publish();
    this.onFrame(this.state, this.room);
  }

  reset() {
    if (!this.initialState) return;
    this.generation += 1;
    this.state = cloneState(this.initialState);
    this.moves = 0;
    this.history.length = 0;
    this.queue.length = 0;
    this.running = false;
    this.publish({ reset: true });
    this.onFrame(this.state, this.room);
  }

  undo() {
    if (!this.state || !this.history.length) return false;
    this.generation += 1;
    const previous = this.history.pop();
    this.state = cloneState(previous.state);
    this.initialState = cloneState(previous.initialState);
    this.moves = previous.moves;
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
      playerActive: this.playerCount > 0,
      queued: this.queue.length,
      canUndo: this.history.length > 0,
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
        const instant = this.frameDelay === 0;
        const finalRoom = simulation.room || commandRoom;
        const frames = instant
          ? [{ state: simulation.final, room: finalRoom }]
          : simulation.animationFrames?.length
            ? simulation.animationFrames
            : (simulation.frames.length ? simulation.frames : [simulation.final])
              .map((state) => ({ state, room: commandRoom }));
        for (const frame of frames) {
          if (runGeneration !== this.generation) return;
          if (frame.room !== this.room) {
            this.room = frame.room;
            this.onRoomChange(this.room);
          }
          this.state = frame.state;
          this.onFrame(this.state, this.room);
          if (!instant) await wait(this.frameDelay);
        }
        this.state = simulation.final;
        if (finalRoom !== this.room) {
          this.room = finalRoom;
          this.onRoomChange(this.room);
        }
        if (finalRoom !== commandRoom) {
          this.initialState = cloneState(simulation.final);
        }
        if (finalRoom !== commandRoom ||
            !engineStatesEqualV1(previous.state, simulation.final, this.definitions)) {
          this.history.push(previous);
          if (this.history.length > 256) this.history.shift();
          this.moves += 1;
        }
        this.publish({ cycle: simulation.cycle });
        if (this.playerCount < 1) this.queue.length = 0;
      }
    } catch (error) {
      this.queue.length = 0;
      this.publish({ error: error?.message || "engine/v1 command failed." });
    } finally {
      if (runGeneration === this.generation) {
        this.running = false;
        this.publish();
      }
    }
  }
}
