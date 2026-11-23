import * as THREE from "../render/vendor/three.module.min.js";

// Batch only immutable background geometry. Foreground picking, moving gems,
// and camera-facing lift markers retain their individual scene objects.
export function batchStaticRoom(root, retainedSources = new Set()) {
  root.updateWorldMatrix(true, true);
  const groups = new Map(), retired = [];
  const inverse = root.matrixWorld.clone().invert();
  root.traverse(object => {
    if (!object.isMesh || !object.visible || Array.isArray(object.material) ||
        object.isInstancedMesh || object.geometry.groups.length || object.userData.truncateCap) return;
    for (let parent = object; parent && parent !== root; parent = parent.parent) {
      if (!parent.visible || parent.userData.gemMotion || parent.userData.liftMarker) return;
    }
    const geometry = object.geometry;
    if (geometry.drawRange.start || Number.isFinite(geometry.drawRange.count)) return;
    const attributes = Object.keys(geometry.attributes).sort();
    if (attributes.some(name => geometry.attributes[name].isInterleavedBufferAttribute)) return;
    const key = JSON.stringify([object.material.uuid, object.layers.mask, object.renderOrder,
      object.castShadow, object.receiveShadow, attributes.map(name => {
        const a = geometry.attributes[name]; return [name, a.itemSize, a.normalized, a.array.constructor.name];
      })]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  });
  for (const objects of groups.values()) {
    if (objects.length < 2) continue;
    const attributes = Object.keys(objects[0].geometry.attributes);
    const chunks = objects.map(object => {
      const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
      const matrix = inverse.clone().multiply(object.matrixWorld);
      geometry.applyMatrix4(matrix);
      // Outline endpoints must undergo exactly the same transform as positions.
      geometry.attributes.lineOther?.applyMatrix4(matrix);
      return geometry;
    });
    const merged = new THREE.BufferGeometry();
    for (const name of attributes) {
      const first = chunks[0].attributes[name];
      const values = new first.array.constructor(chunks.reduce((n, geometry) => n + geometry.attributes[name].array.length, 0));
      let offset = 0;
      for (const chunk of chunks) { const a = chunk.attributes[name].array; values.set(a, offset); offset += a.length; }
      merged.setAttribute(name, new THREE.BufferAttribute(values, first.itemSize, first.normalized));
    }
    merged.computeBoundingBox(); merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, objects[0].material);
    mesh.userData = { ...objects[0].userData, staticRoomBatch: true };
    delete mesh.userData.truncateModel;
    mesh.layers.mask = objects[0].layers.mask;
    mesh.renderOrder = objects[0].renderOrder;
    mesh.castShadow = objects[0].castShadow; mesh.receiveShadow = objects[0].receiveShadow;
    root.add(mesh);
    for (const object of objects) {
      // Model caps retain the original local geometry and world transform.
      // Detached sources are CPU-only and are disposed with this room's cache.
      const worldMatrix = object.matrixWorld.clone();
      object.removeFromParent();
      object.matrix.copy(worldMatrix); object.matrixAutoUpdate = false;
      object.matrixWorld.copy(worldMatrix);
      if (retainedSources.has(object)) retired.push(object);
      else if (!object.geometry.userData.persistentGeometry) object.geometry.dispose();
    }
    chunks.forEach(geometry => geometry.dispose());
  }
  return retired;
}
