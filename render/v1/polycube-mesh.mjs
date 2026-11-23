// Connected voxel/component geometry adapted from MazeBenchEngine's
// componentCuboidGeometry, polycubeGeometry, and boundary-edge builders.

import * as THREE from "../vendor/three.module.min.js";
import { MAZE_COLORS } from "./world-renderer.mjs";

export const FLOOR_THICKNESS = 22 / 64;
export const FLOOR_DROP = 4 / 64;

const materialCache = new Map();
const lineMaterialCache = new Map();
const geometryCache = new Map();
const CONTEXT_DIM_FACTOR = 0.38;

export function persistentGeometry(geometry) {
  geometry.userData.persistentGeometry = true;
  return geometry;
}

export function cachedGeometry(key, create) {
  if (!geometryCache.has(key)) geometryCache.set(key, persistentGeometry(create()));
  return geometryCache.get(key);
}

export function renderMaterial(color, dimmed = false) {
  const key = `${color}:${dimmed ? "dimmed" : "active"}`;
  if (!materialCache.has(key)) {
    const renderedColor = new THREE.Color(color);
    if (dimmed) renderedColor.multiplyScalar(CONTEXT_DIM_FACTOR);
    materialCache.set(key, new THREE.MeshLambertMaterial({
      color: renderedColor,
      emissive: renderedColor,
      emissiveIntensity: dimmed ? 0.035 : color === MAZE_COLORS.orange ? 0.28 : 0.12,
      flatShading: true
    }));
  }
  return materialCache.get(key);
}

export function edgeMaterial(color = 0x000000, opacity = 1) {
  const key = `${color}:${opacity}`;
  if (!lineMaterialCache.has(key)) {
    const material = new THREE.LineBasicMaterial({
      color,
      depthTest: true,
      depthWrite: false,
      opacity,
      transparent: opacity < 1
    });
    material.userData.mazeOutline = (color === 0x000000 || color === "#000000") && opacity >= 0.999;
    if (material.userData.mazeOutline) {
      // MazeBenchEngine pulls edge vertices toward the eye along their view
      // ray so outlines win the depth test without sliding across the model.
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
          "#include <project_vertex>",
          [
            "vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );",
            "float edgePullBias = 0.024;",
            "if ( isPerspectiveMatrix( projectionMatrix ) ) {",
            "  float edgeViewDistance = max( length( mvPosition.xyz ), 0.0001 );",
            "  float edgePull = max( edgePullBias, edgeViewDistance * 0.0015 );",
            "  mvPosition.xyz *= max( edgeViewDistance - edgePull, 0.0 ) / edgeViewDistance;",
            "} else {",
            "  mvPosition.z += edgePullBias;",
            "}",
            "gl_Position = projectionMatrix * mvPosition;"
          ].join("\n")
        );
      };
      material.customProgramCacheKey = () => "maze-outline-depth-bias-v1";
    }
    lineMaterialCache.set(key, material);
  }
  return lineMaterialCache.get(key);
}

function pushQuad(positions, corners) {
  const [a, b, c, d] = corners;
  positions.push(...a, ...b, ...c, ...a, ...c, ...d);
}

export function geometryFromFaces(faces) {
  const positions = [];
  faces.forEach((face) => pushQuad(positions, face.corners));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function roundedPointKey(point) {
  return point.map((value) => Math.round(value * 10000)).join(",");
}

function segmentKey(from, to) {
  return [roundedPointKey(from), roundedPointKey(to)].sort().join(":");
}

// Same rule as the source renderer: coplanar shared edges disappear, while
// outer boundaries and face-normal changes remain.
export function edgeGeometryFromFaces(faces) {
  const edges = new Map();
  faces.forEach((face) => {
    face.corners.forEach((from, index) => {
      const to = face.corners[(index + 1) % face.corners.length];
      const key = segmentKey(from, to);
      if (!edges.has(key)) edges.set(key, { from, to, normals: new Set(), total: 0 });
      const edge = edges.get(key);
      edge.normals.add(face.normal);
      edge.total += 1;
    });
  });

  const positions = [];
  edges.forEach((edge) => {
    if (edge.normals.size === 1 && edge.total > 1) return;
    positions.push(...edge.from, ...edge.to);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function voxelKey(x, z, y) {
  return `${x},${z},${y}`;
}

export function voxelFaces(voxels, occupied, halfWidth, halfHeight) {
  const faces = [];
  const has = (x, z, y) => occupied.has(voxelKey(x, z, y));
  voxels.forEach((voxel) => {
    const x0 = voxel.x - halfWidth;
    const x1 = x0 + 1;
    const z0 = voxel.z - halfHeight;
    const z1 = z0 + 1;
    const y0 = voxel.y;
    const y1 = y0 + 1;
    if (!has(voxel.x + 1, voxel.z, voxel.y)) {
      faces.push({ normal: "x+", corners: [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]] });
    }
    if (!has(voxel.x - 1, voxel.z, voxel.y)) {
      faces.push({ normal: "x-", corners: [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]] });
    }
    if (!has(voxel.x, voxel.z + 1, voxel.y)) {
      faces.push({ normal: "z+", corners: [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]] });
    }
    if (!has(voxel.x, voxel.z - 1, voxel.y)) {
      faces.push({ normal: "z-", corners: [[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]] });
    }
    if (!has(voxel.x, voxel.z, voxel.y + 1)) {
      faces.push({ normal: "y+", corners: [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]] });
    }
    if (!has(voxel.x, voxel.z, voxel.y - 1)) {
      faces.push({ normal: "y-", corners: [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]] });
    }
  });
  return faces;
}

export function floorFaces(cells, halfWidth, halfHeight) {
  const cellSet = new Set(cells.map((cell) => `${cell.x},${cell.z}`));
  const faces = [];
  cells.forEach((cell) => {
    const x0 = cell.x - halfWidth;
    const x1 = x0 + 1;
    const z0 = cell.z - halfHeight;
    const z1 = z0 + 1;
    const y1 = cell.top;
    const y0 = cell.bottom;
    faces.push({ normal: "y+", corners: [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]] });
    faces.push({ normal: "y-", corners: [[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]] });
    if (!cellSet.has(`${cell.x + 1},${cell.z}`)) {
      faces.push({ normal: "x+", corners: [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]] });
    }
    if (!cellSet.has(`${cell.x - 1},${cell.z}`)) {
      faces.push({ normal: "x-", corners: [[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]] });
    }
    if (!cellSet.has(`${cell.x},${cell.z + 1}`)) {
      faces.push({ normal: "z+", corners: [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]] });
    }
    if (!cellSet.has(`${cell.x},${cell.z - 1}`)) {
      faces.push({ normal: "z-", corners: [[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]] });
    }
  });
  return faces;
}

export function addOutlinedMesh(content, geometry, color, transform = {}, threshold = 18, options = {}) {
  const dimmed = options.dimmed === true;
  const mesh = new THREE.Mesh(geometry, renderMaterial(color, dimmed));
  if (transform.position) mesh.position.copy(transform.position);
  if (transform.rotation) mesh.rotation.copy(transform.rotation);
  if (transform.scale) mesh.scale.copy(transform.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  content.add(mesh);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, threshold),
    dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial()
  );
  if (transform.position) edges.position.copy(transform.position);
  if (transform.rotation) edges.rotation.copy(transform.rotation);
  if (transform.scale) edges.scale.copy(transform.scale);
  edges.renderOrder = 10;
  content.add(edges);
  return mesh;
}

export function disposeGeneratedChildren(group) {
  group.userData.cutawayMaterials?.forEach((material) => material.dispose());
  delete group.userData.cutawayMaterials;
  group.traverse((object) => {
    if (object.geometry && !object.geometry.userData?.persistentGeometry) object.geometry.dispose();
    if (object.userData?.transientMaterial) object.material?.dispose?.();
  });
  group.clear();
}
