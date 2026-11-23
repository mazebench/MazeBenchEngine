const DEFAULT_MAX_SAMPLES = 12000;
const DEFAULT_MIN_SPACING = 4;

/**
 * Normalize a drag in either direction into a screen-space rectangle.
 *
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 */
export function marqueeRectangle(startX, startY, endX, endY) {
  const left = Math.min(startX, endX);
  const right = Math.max(startX, endX);
  const top = Math.min(startY, endY);
  const bottom = Math.max(startY, endY);

  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  };
}

/**
 * Build an even screen-space sampling grid for the MazeBench face picker.
 * Large rectangles automatically increase their spacing to cap release-time
 * work, while normal drags retain a tight grid that catches small cube faces.
 *
 * @param {{ bottom: number, height: number, left: number, right: number, top: number, width: number }} rectangle
 * @param {{ maxSamples?: number, minSpacing?: number }} [options]
 */
export function marqueeSamplePoints(rectangle, options = {}) {
  const maxSamples = Math.max(4, Math.floor(options.maxSamples ?? DEFAULT_MAX_SAMPLES));
  const minSpacing = Math.max(1, Number(options.minSpacing ?? DEFAULT_MIN_SPACING));
  const area = Math.max(1, rectangle.width * rectangle.height);
  const spacing = Math.max(minSpacing, Math.sqrt(area / maxSamples));
  const columns = Math.max(1, Math.ceil(rectangle.width / spacing));
  const rows = Math.max(1, Math.ceil(rectangle.height / spacing));
  const points = [];

  for (let row = 0; row <= rows; row += 1) {
    const y = rectangle.top + (rectangle.height * row) / rows;
    for (let column = 0; column <= columns; column += 1) {
      points.push({
        x: rectangle.left + (rectangle.width * column) / columns,
        y,
      });
    }
  }

  return points;
}
