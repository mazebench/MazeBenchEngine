import * as THREE from "../vendor/three.module.min.js";
import { cachedGeometry } from "./polycube-mesh.mjs";

// Cut actual triangles, including their normals/UVs. Shader clipping shared
// with the shadow/outline passes can leave bands across otherwise solid faces.
export function cutGeometryAtPlane(source, plane) {
  const key = `cutaway:${source.uuid}:${[...plane.normal.toArray(), plane.constant].map(value => value.toFixed(6)).join(":")}`;
  return cachedGeometry(key, () => {
    const attributes = Object.entries(source.attributes);
    const values = Object.fromEntries(attributes.map(([name]) => [name, []]));
    const vertex = (offset) => {
      const index = source.index ? source.index.getX(offset) : offset;
      return Object.fromEntries(attributes.map(([name, attribute]) => [name,
        Array.from({ length: attribute.itemSize }, (_, component) => attribute.getComponent(index, component))]));
    };
    const distance = (point) => plane.normal.dot(new THREE.Vector3(...point.position)) + plane.constant;
    const intersection = (from, to, fromDistance, toDistance) => {
      const t = fromDistance / (fromDistance - toDistance);
      return Object.fromEntries(attributes.map(([name]) => [name,
        from[name].map((value, component) => value + (to[name][component] - value) * t)]));
    };
    const emit = (point) => attributes.forEach(([name]) => values[name].push(...point[name]));
    const result = new THREE.BufferGeometry();
    const count = source.index?.count ?? source.attributes.position.count;
    const groups = source.groups.length ? source.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const group of groups) {
      const start = values.position.length / 3;
      for (let offset = group.start; offset < Math.min(count, group.start + group.count); offset += 3) {
        const triangle = [vertex(offset), vertex(offset + 1), vertex(offset + 2)];
        const polygon = [];
        for (let edge = 0; edge < 3; edge += 1) {
          const from = triangle[edge];
          const to = triangle[(edge + 1) % 3];
          const fromDistance = distance(from);
          const toDistance = distance(to);
          if (fromDistance >= 0) polygon.push(from);
          if ((fromDistance >= 0) !== (toDistance >= 0)) {
            polygon.push(intersection(from, to, fromDistance, toDistance));
          }
        }
        for (let index = 1; index < polygon.length - 1; index += 1) {
          emit(polygon[0]); emit(polygon[index]); emit(polygon[index + 1]);
        }
      }
      if (source.groups.length) result.addGroup(start, values.position.length / 3 - start, group.materialIndex);
    }
    attributes.forEach(([name, attribute]) => {
      result.setAttribute(name, new THREE.Float32BufferAttribute(values[name], attribute.itemSize));
    });
    result.computeBoundingBox();
    result.computeBoundingSphere();
    return result;
  });
}
