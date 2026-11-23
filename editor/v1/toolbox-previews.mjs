// Static toolbox thumbnails rendered from the same v1 definitions as the
// editor. One temporary WebGL context draws every preview, then releases it.

import * as THREE from "../../render/vendor/three.module.min.js";
import {
  addGemAsset,
  addTerrainAsset,
  assetReady,
  loadAssetModels
} from "../../render/v1/asset-renderers.mjs";
import {
  actorPieceDefinition,
  terrainPieceDefinition
} from "../../render/v1/piece-definitions.mjs";
import {
  addOutlinedMesh,
  cachedGeometry,
  disposeGeneratedChildren
} from "../../render/v1/polycube-mesh.mjs";
import { addSpecialPiece } from "../../render/v1/special-piece-renderers.mjs";
import {
  addGenericNumberFaces,
  genericNumberLabel
} from "../../render/v1/generic-labels.mjs";
import { cellForTool, parseCellState } from "../../render/v1/world-renderer.mjs";

const PREVIEW_SIZE = 96;
const DIMENSIONS = Object.freeze({ totalWidth: 1, totalHeight: 1 });
const CAMERA_DIRECTION = new THREE.Vector3(1.5, 1.2, 1.8).normalize();

function recordFor(source, definition) {
  return { x: 0, z: 0, localX: 0, localZ: 0, source, definition };
}

function addCuboid(content, definition) {
  const height = definition.top - definition.bottom;
  const geometry = cachedGeometry(`toolbox-cuboid:${height.toFixed(5)}`, () =>
    new THREE.BoxGeometry(1, height, 1));
  addOutlinedMesh(content, geometry, definition.color, {
    position: new THREE.Vector3(0, definition.bottom + height / 2, 0)
  });
}

function addTerrain(content, layer) {
  const definition = terrainPieceDefinition(layer);
  const record = recordFor(layer, definition);
  if (definition.kind === "floor" || definition.kind === "cube") {
    addCuboid(content, definition);
    if (definition.exitMarker) {
      addSpecialPiece(content, {
        ...record,
        definition: {
          kind: "exit_marker",
          bottom: definition.top + 0.02,
          top: definition.top + 0.36
        }
      }, DIMENSIONS);
    }
    return;
  }
  if (definition.kind === "terrain_asset") {
    if (assetReady(layer.modelUrl)) addTerrainAsset(content, record, DIMENSIONS);
    else addCuboid(content, definition);
    return;
  }
  addSpecialPiece(content, record, DIMENSIONS);
}

function addActor(content, actor) {
  const definition = actorPieceDefinition(actor);
  const record = recordFor(actor, definition);
  if (definition.kind === "cube") {
    addCuboid(content, definition);
  } else if (definition.kind === "gem_asset") {
    addGemAsset(content, record, DIMENSIONS);
  } else {
    addSpecialPiece(content, record, DIMENSIONS);
  }
  const label = genericNumberLabel(actor);
  if (label !== null) {
    addGenericNumberFaces(content, {
      bottom: definition.bottom,
      label,
      source: actor,
      top: definition.top,
      x: 0,
      z: 0
    }, DIMENSIONS);
  }
}

function buildPreview(content, token) {
  const state = parseCellState(cellForTool(token));
  state.layers.forEach((layer) => addTerrain(content, layer));
  state.actors.forEach((actor) => addActor(content, actor));
}

function fitCamera(camera, content) {
  content.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(content);
  if (bounds.isEmpty()) return false;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 0.44);
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const distance = radius / Math.sin(halfFov) * 1.12;
  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, distance);
  camera.near = Math.max(0.01, distance - radius * 2.2);
  camera.far = distance + radius * 2.2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  return true;
}

function modelUrlsFor(entries) {
  const urls = new Set();
  entries.forEach(({ token }) => {
    const state = parseCellState(cellForTool(token));
    state.layers.forEach((layer) => {
      if (layer.modelUrl) urls.add(layer.modelUrl);
    });
    state.actors.forEach((actor) => {
      if (actor.modelUrl) urls.add(actor.modelUrl);
    });
  });
  return urls;
}

export async function renderToolboxPreviews(entries) {
  await loadAssetModels(modelUrlsFor(entries));

  const sourceCanvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas: sourceCanvas,
    powerPreference: "low-power",
    preserveDrawingBuffer: true
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false);

  const scene = new THREE.Scene();
  const content = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 30);
  scene.add(content, new THREE.AmbientLight("#ffffff", 1.7));
  const key = new THREE.DirectionalLight("#ffffff", 1.35);
  key.position.set(3, 6, 4);
  scene.add(key);

  for (let index = 0; index < entries.length; index += 1) {
    const { button, canvas, token } = entries[index];
    disposeGeneratedChildren(content);
    buildPreview(content, token);
    if (fitCamera(camera, content)) {
      renderer.render(scene, camera);
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
      button.classList.add("has-preview");
    }
    if (index > 0 && index % 12 === 0) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  disposeGeneratedChildren(content);
  renderer.dispose();
  renderer.forceContextLoss();
}
