// Camera motion values and easing copied from MazeBenchEngineUnitTest's
// MazeBenchCanvas so renderer v1 has the same keyboard feel without React.

export const CAMERA_TILT_MAX_SPEED = Math.PI * 0.72;
export const CAMERA_TILT_ACCEL = Math.PI * 3.4;
export const CAMERA_TILT_DECEL = Math.PI * 4.2;
export const CAMERA_PAN_ACCEL_MULTIPLIER = 5;
export const CAMERA_PAN_DECEL_MULTIPLIER = 7;
export const CAMERA_ZOOM_MAX_LOG_SPEED = 1.1;
export const CAMERA_ZOOM_ACCEL = 3.8;
export const CAMERA_ZOOM_DECEL = 5.2;
export const CAMERA_YAW_DURATION_MS = 400;
export const CAMERA_ZOOM_DURATION_MS = 320;
export const CAMERA_CENTER_DURATION_MS = 420;
export const CAMERA_MIN_ABOVE_PITCH = 0.18;
export const CAMERA_MAX_PITCH = 1.48;

export function clampCameraPitch(pitch, allowUnder = false) {
  const minimum = allowUnder ? -CAMERA_MAX_PITCH : CAMERA_MIN_ABOVE_PITCH;
  return Math.max(minimum, Math.min(CAMERA_MAX_PITCH, pitch));
}

export function easeInOutQuad(progress) {
  const value = Math.max(0, Math.min(1, progress));
  return value < 0.5
    ? 2 * value * value
    : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

export function easeToward(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}

export function cameraRelativePanVector(yaw, horizontal, forward) {
  const x = Math.cos(yaw) * horizontal - Math.sin(yaw) * forward;
  const z = -Math.sin(yaw) * horizontal - Math.cos(yaw) * forward;
  const length = Math.hypot(x, z);
  const normalizedX = length > 1 ? x / length : x;
  const normalizedZ = length > 1 ? z / length : z;
  return {
    x: Math.abs(normalizedX) < 1e-12 ? 0 : normalizedX,
    z: Math.abs(normalizedZ) < 1e-12 ? 0 : normalizedZ
  };
}

export function panSpeedForDistance(distance) {
  return Math.max(5, Math.min(80, distance * 0.42));
}

export function zoomDistanceAtVelocity(distance, logVelocity, deltaSeconds, limits) {
  const next = distance * Math.exp(logVelocity * deltaSeconds);
  return Math.max(limits[0], Math.min(limits[1], next));
}

export function yawTransitionAt(animation, now) {
  const progress = Math.min(1, (now - animation.startMs) / CAMERA_YAW_DURATION_MS);
  return {
    complete: progress >= 1,
    yaw: animation.startYaw +
      (animation.targetYaw - animation.startYaw) * easeInOutQuad(progress)
  };
}

export function zoomTransitionAt(animation, now) {
  const progress = Math.min(1, (now - animation.startMs) / CAMERA_ZOOM_DURATION_MS);
  if (progress >= 1) return { complete: true, distance: animation.targetDistance };
  const eased = easeInOutQuad(progress);
  const start = Math.max(0.001, animation.startDistance);
  const target = Math.max(0.001, animation.targetDistance);
  return {
    complete: false,
    distance: Math.exp(Math.log(start) + (Math.log(target) - Math.log(start)) * eased)
  };
}

export function centerTransitionAt(animation, now) {
  const progress = Math.min(1, (now - animation.startMs) / CAMERA_CENTER_DURATION_MS);
  const eased = easeInOutQuad(progress);
  return {
    complete: progress >= 1,
    x: animation.startX + (animation.targetX - animation.startX) * eased,
    z: animation.startZ + (animation.targetZ - animation.startZ) * eased
  };
}
