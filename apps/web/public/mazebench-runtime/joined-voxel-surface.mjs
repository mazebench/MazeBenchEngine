// Canonical cube/wedge surface kernel for the test lab and MazeBench browser UI.
// Both applications import this file in this repository; no Three.js dependency.
const EPS = 1e-8;
// Ground floors support objects at elevation zero. Recessing their surface
// leaves a visible gap beneath walls, ramps and actors at low camera angles.
export const floorSlabBounds = thickness => ({ bottom: -thickness, top: 0 });
const FAMILY = {
  "ice-floor": "ice-block", "ice-slope": "ice-block",
  "wall-slope": "wall", "orange-slope": "orange-wall",
  "weightless-slope": "weightless-box", "clone-slope": "clone"
};
export const slopeMeshFamily = id => FAMILY[id] || id;
// Animated rigid bodies can translate the whole integer grid by a fraction.
const cellKey = p => p.map(v => Math.round(v * 1e6)).join(",");
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const normalOf = points => {
  const n = cross(sub(points[1], points[0]), sub(points[2], points[0]));
  const length = Math.hypot(...n);
  return n.map(v => v / length);
};
const normalKey = n => n.map(v => Math.round(v * 1e6)).join(",");

// A cube of another material/body can still hide faces beneath a ramp. Keep
// those groups independent, but send every group touching a wedge through
// contact clipping; otherwise the old cube outline cuts across the ramp.
export function slopeContactGroups(groups) {
  const contacts = new Set();
  for (const group of groups) for (const shape of group.shapes) {
    if (!shape.direction) continue;
    contacts.add(cellKey(shape.position));
    for (let axis = 0; axis < 3; axis++) for (const step of [-1, 1]) {
      const neighbor = [...shape.position];
      neighbor[axis] += step;
      contacts.add(cellKey(neighbor));
    }
  }
  return new Set(groups.filter(group =>
    group.shapes.some(shape => contacts.has(cellKey(shape.position)))));
}

const CUBE = [
  [[1,0,0],[1,1,0],[1,1,1],[1,0,1]],
  [[0,0,0],[0,0,1],[0,1,1],[0,1,0]],
  [[0,0,1],[1,0,1],[1,1,1],[0,1,1]],
  [[0,0,0],[0,1,0],[1,1,0],[1,0,0]],
  [[0,1,0],[0,1,1],[1,1,1],[1,1,0]],
  [[0,0,0],[1,0,0],[1,0,1],[0,0,1]]
];
const WEDGE = [
  [[0,0,0],[0,0,1],[1,1,1],[1,1,0]],
  CUBE[0], [[0,0,0],[1,1,0],[1,0,0]],
  [[0,0,1],[1,0,1],[1,1,1]], CUBE[5]
];
const shapeFaces = new Map();
function localFaces(direction) {
  const key = direction || "cube";
  if (shapeFaces.has(key)) return shapeFaces.get(key);
  const rotate = ([x,y,z]) => direction === "left" ? [1-x,y,1-z]
    : direction === "up" ? [z,y,1-x] : direction === "down" ? [1-z,y,x] : [x,y,z];
  const faces = (direction ? WEDGE : CUBE).map(points => {
    points = points.map(rotate);
    const normal = normalOf(points);
    const axis = normal.findIndex(v => Math.abs(v) > 1 - EPS);
    return { points, normal, axis, sign: axis < 0 ? 0 : normal[axis] };
  });
  shapeFaces.set(key, faces);
  return faces;
}

function clipPolygon(points, distance, inside) {
  const result = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = distance(a), db = distance(b);
    const keepA = inside ? da >= -EPS : da <= EPS;
    const keepB = inside ? db >= -EPS : db <= EPS;
    if (keepA) result.push(a);
    if (keepA !== keepB) {
      const t = da / (da - db);
      result.push(a.map((v, axis) => v + (b[axis] - v) * t));
    }
  }
  return result.filter((p, i) => Math.hypot(...sub(p, result[(i + result.length - 1) % result.length])) > EPS);
}

function hasArea(points) {
  if (points.length < 3) return false;
  return points.slice(1, -1).some((p, i) =>
    Math.hypot(...cross(sub(p, points[0]), sub(points[i + 2], points[0]))) > EPS);
}

// A neighboring wedge may cover only half of a cube face. Subtract the actual
// convex contact polygon, retaining the exposed triangle instead of a hole.
function subtractPolygon(points, cover, normal) {
  const centroid = cover[0].map((_, i) => cover.reduce((sum, p) => sum + p[i], 0) / cover.length);
  let remaining = points;
  const pieces = [];
  for (let i = 0; i < cover.length && hasArea(remaining); i++) {
    const a = cover[i], edge = sub(cover[(i + 1) % cover.length], a);
    const sign = Math.sign(dot(cross(edge, sub(centroid, a)), normal));
    const distance = point => sign * dot(cross(edge, sub(point, a)), normal);
    const outside = clipPolygon(remaining, distance, false);
    if (hasArea(outside)) pieces.push(outside);
    remaining = clipPolygon(remaining, distance, true);
  }
  return pieces;
}

export function joinedSurfaceFaces(shapes, occupants = shapes, { minHeight = -Infinity } = {}) {
  const cells = new Map();
  for (const shape of occupants) {
    const key = cellKey(shape.position);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(shape);
  }
  const faces = [], seen = new Set();
  for (const shape of shapes) {
    const identity = `${cellKey(shape.position)}:${shape.direction || "cube"}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (shape.direction && cells.get(cellKey(shape.position)).some(other => !other.direction)) continue;
    for (const face of localFaces(shape.direction)) {
      const points = face.points.map(p => p.map((v, i) => v + shape.position[i]));
      if (face.axis === 1 && face.sign === -1 && points[0][1] === minHeight) continue;
      let pieces = [points];
      if (face.axis >= 0) {
        const neighbor = [...shape.position];
        neighbor[face.axis] += face.sign;
        for (const other of cells.get(cellKey(neighbor)) || []) {
          const contact = localFaces(other.direction).find(candidate =>
            candidate.axis === face.axis && candidate.sign === -face.sign);
          if (!contact) continue;
          // Full square contacts cover the complete unit face.
          if (contact.points.length === 4) { pieces = []; break; }
          const cover = contact.points.map(p => p.map((v, i) => v + other.position[i]));
          pieces = pieces.flatMap(piece => subtractPolygon(piece, cover, face.normal));
        }
      }
      for (const corners of pieces) faces.push({ corners, normal: normalKey(face.normal) });
    }
  }
  return faces;
}

export function joinedTrianglePositions(faces, halfWidth = 0, halfHeight = 0) {
  const positions = [];
  for (const { corners } of faces) {
    for (let i = 1; i < corners.length - 1; i++) {
      for (const p of [corners[0], corners[i], corners[i + 1]]) positions.push(p[0] - halfWidth, p[1], p[2] - halfHeight);
    }
  }
  return positions;
}

// Split collinear edges at every endpoint before cancelling shared coplanar
// intervals. This also handles triangle/quad T-junctions along stepped ramps.
export function joinedEdgePositions(faces, halfWidth = 0, halfHeight = 0) {
  const scale = 1e6, lines = new Map();
  const keyFor = v => v.map(n => Math.round(n * scale)).join(",");
  for (const face of faces) for (let i = 0; i < face.corners.length; i++) {
    const a = face.corners[i], b = face.corners[(i + 1) % face.corners.length];
    const vector = sub(b, a), length = Math.hypot(...vector);
    if (length < EPS) continue;
    const sign = Math.sign(vector.find(v => Math.abs(v) > EPS));
    const direction = vector.map(v => sign * v / length);
    const key = `${keyFor(direction)}:${keyFor(cross(a, direction))}`;
    if (!lines.has(key)) lines.set(key, { origin: a, direction, t: dot(a, direction), events: new Map() });
    const line = lines.get(key);
    const [start, end] = [dot(a, direction), dot(b, direction)].map(t => Math.round(t * scale)).sort((a,b) => a-b);
    for (const [at, delta] of [[start, 1], [end, -1]]) {
      if (!line.events.has(at)) line.events.set(at, new Map());
      const event = line.events.get(at);
      event.set(face.normal, (event.get(face.normal) || 0) + delta);
    }
  }
  const positions = [];
  for (const { origin, direction, t, events } of lines.values()) {
    const points = [...events.keys()].sort((a,b) => a-b), normals = new Map();
    for (let i = 0; i < points.length - 1; i++) {
      for (const [normal, delta] of events.get(points[i])) {
        const count = (normals.get(normal) || 0) + delta;
        if (count) normals.set(normal, count); else normals.delete(normal);
      }
      if (!normals.size || (normals.size === 1 && [...normals.values()][0] > 1)) continue;
      for (const at of [points[i], points[i + 1]]) {
        const p = origin.map((v, axis) => v + direction[axis] * (at / scale - t));
        positions.push(p[0] - halfWidth, p[1], p[2] - halfHeight);
      }
    }
  }
  return positions;
}

// Cross sections where a moving solid enters another surface are not edges
// of either original mesh. Find those intersections in tile coordinates so
// the settled renderer and fractional human tweens use identical outlines.
function segmentInsidePlanes(origin, direction, planes, low = 0, high = 1) {
  for (const plane of planes) {
    const distance = dot(plane.normal, origin) - plane.constant;
    const speed = dot(plane.normal, direction);
    if (Math.abs(speed) < EPS) {
      if (distance > EPS) return null;
    } else if (speed > 0) high = Math.min(high, -distance / speed);
    else low = Math.max(low, -distance / speed);
    if (high - low < EPS) return null;
  }
  return [low, high];
}

export function surfaceContactEdges(shapes, supports, halfWidth = 0, halfHeight = 0) {
  if (!shapes.length || !supports.length) return [];
  const columns = new Map(), supportFaces = new Map(), supportNeighbors = new Map();
  for (const shape of supports) {
    const size = shape.size || [1, 1, 1];
    for (let x = Math.floor(shape.position[0]); x <= Math.floor(shape.position[0] + size[0] + EPS); x++) {
      for (let z = Math.floor(shape.position[2]); z <= Math.floor(shape.position[2] + size[2] + EPS); z++) {
        const key = `${x},${z}`;
        if (!columns.has(key)) columns.set(key, new Set());
        columns.get(key).add(shape);
      }
    }
  }
  const planesFor = shape => {
    if (!supportFaces.has(shape)) supportFaces.set(shape, localFaces(shape.direction).map(face => {
      const points = face.points.map(p => p.map((v, i) => shape.position[i] + v * (shape.size?.[i] ?? 1)));
      const normal = normalOf(points);
      return { normal, constant: dot(normal, points[0]) };
    }));
    return supportFaces.get(shape);
  };
  const neighborsFor = shape => {
    if (!supportNeighbors.has(shape)) {
      const neighbors = new Set(), size = shape.size || [1, 1, 1];
      for (let x = Math.floor(shape.position[0]); x <= Math.floor(shape.position[0] + size[0] + EPS); x++) {
        for (let z = Math.floor(shape.position[2]); z <= Math.floor(shape.position[2] + size[2] + EPS); z++) {
          for (const other of columns.get(`${x},${z}`) || []) if (other !== shape) neighbors.add(other);
        }
      }
      supportNeighbors.set(shape, neighbors);
    }
    return supportNeighbors.get(shape);
  };
  const positions = [], seen = new Set();
  for (const { corners } of joinedSurfaceFaces(shapes)) {
    const center = corners[0].map((_, axis) => corners.reduce((sum, p) => sum + p[axis], 0) / corners.length);
    for (const shape of columns.get(`${Math.floor(center[0])},${Math.floor(center[2])}`) || []) {
      const faces = planesFor(shape);
      for (const plane of faces) {
        const distances = corners.map(p => dot(plane.normal, p) - plane.constant);
        // Coplanar faces already have their normal mesh outline.
        if (distances.every(d => Math.abs(d) < EPS)) continue;
        const points = [];
        for (let i = 0; i < corners.length; i++) {
          const a = corners[i], b = corners[(i + 1) % corners.length];
          const da = distances[i], db = distances[(i + 1) % corners.length];
          if (Math.abs(da) < EPS) points.push(a);
          if (da * db < -EPS * EPS) points.push(a.map((v, axis) => v + (b[axis] - v) * da / (da - db)));
        }
        if (points.length < 2) continue;
        const a = points[0], b = points.reduce((farthest, p) =>
          dot(sub(p, a), sub(p, a)) > dot(sub(farthest, a), sub(farthest, a)) ? p : farthest, a);
        const direction = sub(b, a);
        if (Math.hypot(...direction) < EPS) continue;
        const interval = segmentInsidePlanes(a, direction, faces);
        if (!interval) continue;
        let exposed = [interval];
        // Treat the supports as one surface. A floor tile's side inside the
        // next tile is not a contact edge, even when a lowered wall's top is
        // exactly flush with the floor. Keep partially exposed ledges/slopes.
        const outside = a.map((v, axis) => v + plane.normal[axis] * EPS * 16);
        for (const other of neighborsFor(shape)) {
          const covered = segmentInsidePlanes(outside, direction, planesFor(other), ...interval);
          if (!covered) continue;
          exposed = exposed.flatMap(([start, end]) => {
            if (covered[1] <= start || covered[0] >= end) return [[start, end]];
            const pieces = [];
            if (covered[0] - start > EPS) pieces.push([start, covered[0]]);
            if (end - covered[1] > EPS) pieces.push([covered[1], end]);
            return pieces;
          });
          if (!exposed.length) break;
        }
        for (const [low, high] of exposed) {
          const from = a.map((v, axis) => v + direction[axis] * low);
          const to = a.map((v, axis) => v + direction[axis] * high);
          const key = [cellKey(from), cellKey(to)].sort().join(":");
          if (seen.has(key)) continue;
          seen.add(key);
          for (const p of [from, to]) positions.push(p[0] - halfWidth, p[1], p[2] - halfHeight);
        }
      }
    }
  }
  return positions;
}

const FACE_NORMALS = {
  top: [0, 0, 1], bottom: [0, 0, -1],
  north: [0, -1, 0], east: [1, 0, 0], south: [0, 1, 0], west: [-1, 0, 0]
};
export const numberFaceKey = (x, y, z, face) => `${x},${y},${z}:${face}`;

// Fixtures occupy the cell outside their supporting block. Coordinates here
// are logical x/y/z (z is elevation), unlike the Three.js surface coordinates.
export function mountedNumberFaces(fixtures) {
  const covered = new Set();
  for (const { x, y, z, face } of fixtures) {
    const normal = FACE_NORMALS[face];
    if (normal) covered.add(numberFaceKey(x - normal[0], y - normal[1], z - normal[2], face));
  }
  return covered;
}

// A fixed tiny near plane loses enough distant depth precision for a 0.012-cell
// device plate to compete with its support. Preserve close editor views, then
// grow the near plane gradually with camera distance (in either app's units).
export function perspectiveNearForDistance(distance, unit = 1, minimum = unit * 0.05) {
  return Math.max(minimum, (distance - 64 * unit) / 32);
}
