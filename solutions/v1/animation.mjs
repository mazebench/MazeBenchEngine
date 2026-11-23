import { DEFAULT_PLAY_FRAME_DELAY_MS } from '../../play/current/play-session.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function playSolutionFrames(frames, onFrame, {cancelled=()=>false, delay=wait}={}) {
  for (const frame of frames) {
    if (cancelled()) return false;
    onFrame(frame);
    await delay(DEFAULT_PLAY_FRAME_DELAY_MS);
  }
  return !cancelled();
}
