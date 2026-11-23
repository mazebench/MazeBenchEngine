const DIRECTIONS = ["up", "right", "down", "left"];
const MIN_CAMERA_ZOOM = 0.55;
const MAX_CAMERA_ZOOM = 10;
const CAMERA_ZOOM_STEP = 1.12;

/**
 * Convert a free camera yaw to the nearest normalized quarter turn.
 *
 * @param {number} yaw
 */
export function cameraYawQuarterTurns(yaw) {
  const turns = Math.round((Number(yaw) || 0) / (Math.PI / 2));
  return ((turns % 4) + 4) % 4;
}

/**
 * Map a screen arrow to the world direction that visually matches the current
 * camera quarter turn.
 *
 * @param {"up" | "right" | "down" | "left"} screenDirection
 * @param {number} cameraQuarterTurns
 */
export function cameraRelativeDirection(screenDirection, cameraQuarterTurns) {
  const screenIndex = DIRECTIONS.indexOf(screenDirection);
  if (screenIndex < 0) return screenDirection;
  const turns = ((Math.round(cameraQuarterTurns) % 4) + 4) % 4;
  return DIRECTIONS[(screenIndex - turns + 4) % 4];
}

// MazeBench slope authoring always points the ramp toward the far side of the
// current camera view. This is deliberately independent of the painted face.
export function cameraFacingSlopeDirection(cameraQuarterTurns) {
  return cameraRelativeDirection("up", cameraQuarterTurns);
}

/**
 * Apply one keyboard zoom step. Positive direction zooms in, negative zooms
 * out. Keeping this discrete makes keyboard zoom deterministic across
 * browsers and avoids trackpad wheel deltas changing the editor camera.
 *
 * @param {number} zoom
 * @param {-1 | 1} direction
 */
export function stepCameraZoom(zoom, direction) {
  const current = Number.isFinite(Number(zoom)) ? Number(zoom) : 1;
  const next = current * (direction > 0 ? CAMERA_ZOOM_STEP : 1 / CAMERA_ZOOM_STEP);
  return Math.max(MIN_CAMERA_ZOOM, Math.min(MAX_CAMERA_ZOOM, next));
}
