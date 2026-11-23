import { createCommandTimeline } from "./timeline.mjs";
import { playTimeline } from "./player.mjs";

// Human ASCII keeps exact grid frames but shares the 3D presentation clock.
// Controller repeat gates therefore open at the same time in either view.
export async function animateAsciiCommand(command, { definitions, ...options } = {}) {
  if (command.signal?.aborted) return false;
  if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return {};
  const timeline = createCommandTimeline({ ...command, definitions });
  const { simulation, room, presentFrame } = command;
  const frames = simulation.animationFrames?.length ? simulation.animationFrames
    : simulation.frames.map(state => ({ state, room }));
  let displayed = 0;
  const complete = await playTimeline(timeline, time => {
    let next = displayed;
    while (next + 1 < timeline.times.length && timeline.times[next + 1] <= time) next++;
    if (next === displayed) return;
    displayed = next;
    // If a display frame arrives late, draw its latest exact state once.
    presentFrame(frames[timeline.ticks[next] - 1]);
  }, { ...options, signal: command.signal });
  return complete ? {} : false;
}
