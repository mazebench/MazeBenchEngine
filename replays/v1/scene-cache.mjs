// Only detached scenes live here. Bound both entry count and owned vertex data;
// a long movie or a large mechanism room must not retain unlimited GPU buffers.
export class ReplaySceneCache {
  constructor({ maxEntries = 32, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }

  take(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    return entry.scene;
  }

  park(key, scene) {
    scene.detach();
    const previous = this.take(key);
    previous?.dispose();
    const buffers = new Set();
    scene.root.traverse(object => {
      const geometry = object.geometry;
      if (!geometry || geometry.userData.persistentGeometry) return;
      for (const attribute of Object.values(geometry.attributes).concat(geometry.index || [])) {
        buffers.add((attribute.isInterleavedBufferAttribute ? attribute.data : attribute).array.buffer);
      }
    });
    const bytes = [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
    this.entries.set(key, { scene, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.take(this.entries.keys().next().value).dispose();
    }
  }

  clear() {
    for (const { scene } of this.entries.values()) scene.dispose();
    this.entries.clear();
    this.bytes = 0;
  }
}
