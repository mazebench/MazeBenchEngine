// GLB loading and rendering for the small authored renderer-only asset set.

import * as THREE from "../vendor/three.module.min.js";
import { GLTFLoader } from "../vendor/examples/jsm/loaders/GLTFLoader.js";
import {
  cachedGeometry,
  edgeMaterial,
  persistentGeometry,
  renderMaterial
} from "./polycube-mesh.mjs";
import { colorForDefinition } from "./world-renderer.mjs";

const TREE_MODEL_SCALE = 6 / 5.516;
const SHRUB_MODEL_SCALE = TREE_MODEL_SCALE * 0.5;
const BLOCK_MODEL_SCALE = 0.5;
const GEM_WORLD_SIZE = 0.87;
const modelCache = new Map();
const gltfLoader = new GLTFLoader();

function seededRotation(x, z, elevation, url) {
  const seed = `${x}:${z}:${Math.floor(elevation || 0)}:${url || ""}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

async function loadModel(url) {
  const cached = modelCache.get(url);
  if (cached?.status === "ready" || cached?.status === "failed") return cached.model || null;
  if (cached?.status === "loading") return cached.promise;
  const promise = gltfLoader.loadAsync(url).then((gltf) => {
    const root = gltf.scene || gltf.scenes?.[0];
    if (!root) return null;
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((child) => {
      if (!child.isMesh || !child.geometry?.attributes?.position) return;
      const geometry = persistentGeometry(child.geometry.clone());
      geometry.applyMatrix4(child.matrixWorld);
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const sourceMaterial = Array.isArray(child.material) ? child.material[0] : child.material;
      parts.push({
        geometry,
        color: sourceMaterial?.color
          ? `#${sourceMaterial.color.getHexString(THREE.LinearSRGBColorSpace)}`
          : null
      });
    });
    if (!parts.length) return null;
    const bounds = new THREE.Box3();
    parts.forEach((part) => bounds.union(part.geometry.boundingBox));
    return { bounds, parts };
  }).then((model) => {
    modelCache.set(url, { status: model ? "ready" : "failed", model });
    return model;
  }).catch((error) => {
    console.warn(`Model load failed for ${url}`, error);
    modelCache.set(url, { status: "failed", model: null });
    return null;
  });
  modelCache.set(url, { status: "loading", promise });
  return promise;
}

export function assetReady(url) {
  return modelCache.get(url)?.status === "ready";
}

export function loadAssetModels(urls) {
  return Promise.all([...urls].map(loadModel));
}

function terrainModelScale(type) {
  if (type === "block_asset") return BLOCK_MODEL_SCALE;
  if (type === "shrub") return SHRUB_MODEL_SCALE;
  return TREE_MODEL_SCALE;
}

function addPartWithEdges(content, part, color, transform, threshold = 28, dimmed = false) {
  const mesh = new THREE.Mesh(part.geometry, renderMaterial(part.color || color, dimmed));
  mesh.position.copy(transform.position);
  mesh.scale.copy(transform.scale);
  mesh.rotation.copy(transform.rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  content.add(mesh);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(part.geometry, threshold),
    dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial()
  );
  edges.position.copy(transform.position);
  edges.scale.copy(transform.scale);
  edges.rotation.copy(transform.rotation);
  edges.renderOrder = 10;
  content.add(edges);
}

export function addTerrainAsset(content, record, dimensions) {
  const model = modelCache.get(record.source.modelUrl)?.model;
  if (!model) return;
  const scaleValue = terrainModelScale(record.source.type);
  const transform = {
    position: new THREE.Vector3(
      record.x - dimensions.totalWidth / 2 + 0.5,
      record.source.type === "block_asset"
        ? record.definition.top - model.bounds.max.y * scaleValue
        : record.definition.bottom - model.bounds.min.y * scaleValue,
      record.z - dimensions.totalHeight / 2 + 0.5
    ),
    scale: new THREE.Vector3(scaleValue, scaleValue, scaleValue),
    rotation: new THREE.Euler(
      0,
      ["tree", "shrub"].includes(record.source.type)
        ? seededRotation(record.localX, record.localZ, record.source.elevation, record.source.modelUrl)
        : 0,
      0
    )
  };
  model.parts.forEach((part) =>
    addPartWithEdges(content, part, colorForDefinition(record.source), transform, 28, record.dimmed));
}

// Exact authored gem silhouette extracted from gem.glb: eleven unique points,
// eighteen flat faces. It is used only until/if the GLB cannot be loaded.
function authoredGemFallbackGeometry() {
  return cachedGeometry("authored-gem-fallback", () => {
    const points = [
      [0,-0.6308,0],[-0.1448,0.5590,0.4437],[0.2156,0.2100,0.6635],
      [-0.4668,0.5590,-0.0006],[-0.5644,0.2100,0.4100],[-0.1437,0.5590,-0.4441],
      [-0.5644,0.2100,-0.4100],[0.3780,0.5590,-0.2739],[0.2156,0.2100,-0.6635],
      [0.3773,0.5590,0.2749],[0.6976,0.2100,0]
    ];
    const faces = [
      [8,0,6],[0,8,10],[1,9,7],[7,5,3],[7,3,1],[0,10,2],
      [4,6,0],[4,3,6],[2,1,4],[10,9,2],[8,7,10],[6,5,8],
      [4,0,2],[5,6,3],[7,8,5],[10,7,9],[1,2,9],[3,4,1]
    ];
    const positions = faces.flatMap((face) => face.flatMap((index) => points[index]));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  });
}

export function addGemAsset(content, record, dimensions) {
  const loaded = modelCache.get(record.source.modelUrl)?.model;
  const fallbackGeometry = authoredGemFallbackGeometry();
  const model = loaded || {
    bounds: fallbackGeometry.boundingBox,
    parts: [{ geometry: fallbackGeometry, color: "#00e7e6" }]
  };
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  model.bounds.getSize(size);
  model.bounds.getCenter(center);
  const scale = GEM_WORLD_SIZE / Math.max(size.x, size.y, size.z, 0.001);
  const group = new THREE.Group();
  group.position.set(
    record.x - dimensions.totalWidth / 2 + 0.5,
    record.definition.bottom + 0.14,
    record.z - dimensions.totalHeight / 2 + 0.5
  );
  group.scale.setScalar(scale);
  group.rotation.y = seededRotation(record.x, record.z, record.definition.bottom, record.source.modelUrl);
  model.parts.forEach((part) => {
    const mesh = new THREE.Mesh(part.geometry, renderMaterial(part.color || "#00e7e6", record.dimmed));
    mesh.position.set(-center.x, -model.bounds.min.y, -center.z);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    group.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(part.geometry, 28),
      record.dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial()
    );
    edges.position.copy(mesh.position);
    edges.renderOrder = 10;
    group.add(edges);
  });
  content.add(group);
}
