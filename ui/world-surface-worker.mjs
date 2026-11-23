import { buildWorldSurfaceBuffers } from "./world-surface-buffers.mjs";

self.onmessage = ({ data: { scene, dimensions } }) => {
  try {
    const buffers = buildWorldSurfaceBuffers(scene, dimensions, (complete, total) =>
      self.postMessage({ complete, total }));
    const transfer = buffers.flatMap(part => [part.positions.buffer, part.normals.buffer, ...(part.edges ? [part.edges.buffer] : [])]);
    self.postMessage({ buffers }, transfer);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
