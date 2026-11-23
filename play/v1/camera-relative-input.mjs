const DIRECTIONS = Object.freeze(["up", "right", "down", "left"]);

function normalizeHeading(value) {
  const heading = Number.isInteger(value) ? value : 0;
  return ((heading % DIRECTIONS.length) + DIRECTIONS.length) % DIRECTIONS.length;
}

// Matches MazeBench's screenMoveVector convention: a screen direction rotates
// back into world space by the camera's current cardinal heading.
export function cameraRelativeMoveDirection(direction, heading = 0) {
  const screenIndex = DIRECTIONS.indexOf(String(direction || "").toLowerCase());
  if (screenIndex < 0) return null;
  return DIRECTIONS[(screenIndex - normalizeHeading(heading) + DIRECTIONS.length) % DIRECTIONS.length];
}
