import * as THREE from "../render/vendor/three.module.min.js";

const sections = new WeakMap();
const pointKey = point => point.map(value => Math.round(value * 1e6)).join(":");

function inside(point, polygon) {
  let contained = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
  }
  return contained;
}

// All instances of an authored model share these local-space cross sections.
// Keep a bounded CPU cache for fractional tween heights as well as fixed layers.
export function modelSection(source, height) {
  let cache = sections.get(source);
  if (!cache) sections.set(source, cache = new Map());
  const key = height.toFixed(6);
  if (cache.has(key)) return cache.get(key);
  height = Number(key);
  const points = source.attributes.position, count = source.index?.count ?? points.count;
  const nodes = new Map(), segments = new Map();
  const vertex = offset => {
    const index = source.index ? source.index.getX(offset) : offset;
    return [points.getX(index), points.getY(index), points.getZ(index)];
  };
  for (let i = 0; i < count; i += 3) {
    const triangle = [vertex(i), vertex(i + 1), vertex(i + 2)], hits = new Map();
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge], b = triangle[(edge + 1) % 3];
      if ((a[1] < height) === (b[1] < height)) continue;
      const t = (height - a[1]) / (b[1] - a[1]);
      const point = [a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t];
      hits.set(pointKey(point), point);
    }
    if (hits.size !== 2) continue;
    const [a, b] = [...hits.keys()], id = [a, b].sort().join("/");
    if (segments.has(id)) continue;
    segments.set(id, [a, b]);
    for (const [key, point] of hits) {
      if (!nodes.has(key)) nodes.set(key, { point, edges: [] });
      nodes.get(key).edges.push(id);
    }
  }
  const unused = new Set(segments.keys()), loops = [];
  while (unused.size) {
    const first = unused.values().next().value, start = segments.get(first)[0], loop = [];
    let node = start, edge = first;
    do {
      loop.push(nodes.get(node).point);
      unused.delete(edge);
      node = segments.get(edge).find(key => key !== node);
      edge = nodes.get(node).edges.find(id => unused.has(id));
    } while (node !== start && edge);
    if (node === start && loop.length >= 3) loops.push(loop);
  }
  const areas = loops.map(loop => Math.abs(loop.reduce((sum, a, i) => {
    const b = loop[(i + 1) % loop.length];
    return sum + a[0] * b[1] - a[1] * b[0];
  }, 0)));
  const parents = loops.map((loop, index) => loops.reduce((parent, candidate, j) => {
    if (areas[j] <= areas[index] + 1e-8 || !loop.every(point => inside(point, candidate))) return parent;
    return parent === -1 || areas[j] < areas[parent] ? j : parent;
  }, -1));
  const depth = index => parents[index] === -1 ? 0 : 1 + depth(parents[index]);
  const positions = [], edges = [];
  loops.forEach((loop, index) => {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      edges.push(a[0], height, a[1], b[0], height, b[1]);
    }
    if (depth(index) % 2) return;
    const holes = loops.filter((_, j) => parents[j] === index);
    const all = [loop, ...holes].flat();
    const triangles = THREE.ShapeUtils.triangulateShape(
      loop.map(p => new THREE.Vector2(...p)), holes.map(hole => hole.map(p => new THREE.Vector2(...p))));
    for (const triangle of triangles) {
      const [a, b, c] = triangle.map(i => all[i]);
      // Positive Y is the exposed top, irrespective of contour traversal order.
      const vertices = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]) > 0 ? [a,c,b] : [a,b,c];
      for (const p of vertices) positions.push(p[0], height, p[1]);
    }
  });
  const section = { positions: new Float32Array(positions), edges: new Float32Array(edges) };
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, section);
  return section;
}
