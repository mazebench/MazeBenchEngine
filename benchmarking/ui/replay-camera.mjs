import { easeInOut } from '../../animations/v1/timeline.mjs';

// Match the discrete angles in the signed vision renderer. The presentation
// interpolates between recorded poses without changing any agent observation.
export const VISION_PITCHES = [Math.PI / 2 - .001, 3 * Math.PI / 8, Math.PI / 4, Math.PI / 8, 0];
export function sampleAgentCamera(clip, local) {
  const camera = clip.agentCamera;
  if (!camera) return null;
  const t = easeInOut(Math.max(0, Math.min(1, local / camera.duration)));
  const turn = ((camera.to.yaw - camera.from.yaw + 6) % 4) - 2;
  const yaw = ((camera.from.yaw + turn * t) % 4 + 4) % 4;
  const fromPitch = VISION_PITCHES[camera.from.pitch], toPitch = VISION_PITCHES[camera.to.pitch];
  return { yaw: yaw * Math.PI / 2, pitch: fromPitch + (toPitch - fromPitch) * t,
    top: camera.from.top + (camera.to.top - camera.from.top) * t };
}

export function applyAgentCamera(renderer, pose) {
  if (!pose) return;
  renderer.yaw = pose.yaw; renderer.heading = pose.yaw / (Math.PI / 2); renderer.pitch = pose.pitch;
  renderer.target.y = pose.top / 3;
  const width = renderer.world.roomWidth, height = renderer.world.roomHeight;
  const tan = Math.tan(renderer.camera.fov * Math.PI / 360);
  const fit = Math.max(height / 2 / tan, width / 2 / tan / Math.max(renderer.camera.aspect, .1), Math.max(width, height) * 1.15) * 1.18;
  // Room framing follows the vision renderer's base fit, adapted to the player
  // viewport. World context and presentation tweens remain available here.
  renderer.distance = Math.max(fit, (Math.max(width, height) + pose.top) * 1.65);
}
