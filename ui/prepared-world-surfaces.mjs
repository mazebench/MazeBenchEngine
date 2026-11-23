import * as THREE from "../render/vendor/three.module.min.js";
import { collectVoxelSceneV2 } from "./voxel-scene.mjs";
import { edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { joinedSurfaceMaterial } from "./joined-voxel-mesh.mjs";
import { buildWorldSurfaceBuffers } from "./world-surface-buffers.mjs";
import { addGemAsset, addTerrainAsset } from "./asset-renderers.mjs";
import { addSpecialPiece } from "../render/v1/special-piece-renderers.mjs";

const prepared = new WeakMap();
export const preparedWorldSurfaces = world => prepared.get(world);

export async function prepareWorldSurfaces(world, onProgress = () => {}) {
  const holder = { world }, data = collectVoxelSceneV2(holder);
  const scene = { floorGroups: data.floorGroups, cubeGroups: data.cubeGroups, occupied: data.occupied,
    specialPieces: data.specialPieces.filter(record => record.definition.kind === "slope") };
  const dimensions = { totalWidth: world.columns.length * world.roomWidth, totalHeight: world.rows.length * world.roomHeight };
  const surfaceProgress = (complete, total) => onProgress(0.85 * complete / Math.max(1, total), 1);
  let buffers;
  if (typeof Worker === "undefined") buffers = buildWorldSurfaceBuffers(scene, dimensions, surfaceProgress);
  else {
    const worker = new Worker(new URL("./world-surface-worker.mjs", import.meta.url), { type: "module" });
    try {
      buffers = await new Promise((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message || "Could not prepare world geometry."));
        worker.onmessage = ({ data: message }) => {
          if (message.error) reject(new Error(message.error));
          else if (message.buffers) resolve(message.buffers);
          else surfaceProgress(message.complete, message.total);
        };
        worker.postMessage({ scene, dimensions });
      });
    } finally { worker.terminate(); }
  }
  const content = new THREE.Group();
  addPreparedWorldSurfaces(content, buffers);
  const pieces = [
    ...data.terrainAssets.map(record => [record, addTerrainAsset]),
    ...data.gems.map(record => [record, addGemAsset]),
    ...data.specialPieces.filter(record => record.definition.kind !== "slope").map(record => [record, addSpecialPiece])
  ];
  let sliceStart = performance.now();
  for (let index = 0; index < pieces.length; index++) {
    const [record, add] = pieces[index];
    add(content, record, dimensions);
    if (performance.now() - sliceStart >= 6) {
      onProgress(0.85 + 0.15 * (index + 1) / pieces.length, 1);
      await new Promise(resolve => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  const objects = [...content.children];
  // Detach in one pass; removing thousands of children individually on scene
  // insertion would repeatedly shift the temporary group's entire array.
  content.clear();
  prepared.set(world, { data, cellTops: holder.cellTops, objects });
  onProgress(1, 1);
}

export function addPreparedWorldSurfaces(content, buffers) {
  for (const part of buffers) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, joinedSurfaceMaterial(part));
    mesh.castShadow = !part.floor;
    mesh.receiveShadow = true;
    if (part.joined) mesh.userData.joinedSlopes = true;
    content.add(mesh);
    if (!part.edges) continue;
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(part.edges, 3));
    edgeGeometry.computeBoundingSphere();
    const edges = new THREE.LineSegments(edgeGeometry, part.dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial());
    edges.renderOrder = 10;
    if (part.joined) edges.userData.joinedSlopes = true;
    content.add(edges);
  }
}
