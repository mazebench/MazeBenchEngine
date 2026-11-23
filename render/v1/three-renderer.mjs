// Renderer v1 scene/controller. Geometry and piece definitions deliberately
// live in small sibling modules so alternate renderer versions can replace
// one concern without copying a monolith.

import * as THREE from "../vendor/three.module.min.js";
import { addGemAsset, addTerrainAsset, assetReady, loadAssetModels } from "./asset-renderers.mjs";
import { actorPieceDefinition, terrainPieceDefinition } from "./piece-definitions.mjs";
import {
  FLOOR_DROP,
  FLOOR_THICKNESS,
  disposeGeneratedChildren,
  edgeGeometryFromFaces,
  edgeMaterial,
  floorFaces,
  geometryFromFaces,
  renderMaterial,
  voxelFaces,
  voxelKey,
  cachedGeometry
} from "./polycube-mesh.mjs";
import { addSpecialPiece } from "./special-piece-renderers.mjs";
import { MAZE_COLORS, parseCellState } from "./world-renderer.mjs";
import { cellObjectSelectionKey } from "./cell-objects-v2.mjs";
import { collectVoxelSceneV2 } from "./voxel-scene-v2.mjs";
import { applyCutawayMaterials, cutawayMaxHeight, normalizeCutaway, playerCutawayHeight } from "./cutaway.mjs";
import { roomObjectInContext } from "./room-context.mjs";
import { V2_WORLD_FORMAT } from "./voxel-world-v2.mjs";
import {
  clearPlacementPreview,
  renderPlacementPreview
} from "./placement-preview-v2.mjs";
import {
  CAMERA_PAN_ACCEL_MULTIPLIER,
  CAMERA_PAN_DECEL_MULTIPLIER,
  CAMERA_TILT_ACCEL,
  CAMERA_TILT_DECEL,
  CAMERA_TILT_MAX_SPEED,
  CAMERA_ZOOM_ACCEL,
  CAMERA_ZOOM_DECEL,
  CAMERA_ZOOM_MAX_LOG_SPEED,
  cameraRelativePanVector,
  centerTransitionAt,
  clampCameraPitch,
  easeToward,
  panSpeedForDistance,
  yawTransitionAt,
  zoomDistanceAtVelocity,
  zoomTransitionAt
} from "./camera-transitions.mjs";
import { addGenericNumberFaces } from "./generic-labels.mjs";
import { MazeFuzzyOverlayV1 } from "./fuzzy-overlay.mjs";

const CARDINAL_STEP = Math.PI * 0.5;
const DEFAULT_HEADING = 0;
const DEFAULT_PITCH = 0.72;
const CONTEXT_VIEW_SCALE = 1.55;
const DRAG_HEADING_THRESHOLD = 48;
const OUTLINE_LAYER = 1;
const OUTLINE_PIXEL_OFFSETS = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([-1, 0]),
  Object.freeze([1, 0]),
  Object.freeze([0, -1]),
  Object.freeze([0, 1])
]);
const HEADING_DIRECTIONS = Object.freeze([
  { near: "down", far: "up" },
  { near: "right", far: "left" },
  { near: "up", far: "down" },
  { near: "left", far: "right" }
]);

function isEditableTarget(target) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));
}

function groupEntry(groups, key, settings) {
  if (!groups.has(key)) groups.set(key, { ...settings, voxels: [], voxelKeys: new Set() });
  return groups.get(key);
}

export class ThreeMazeRendererV1 {
  constructor(canvas, world, options = {}) {
    this.canvas = canvas;
    this.mode = options.mode || "world";
    this.pickVoxels = this.mode === "editor" || options.pickVoxels === true;
    this.onInspect = options.onInspect || null;
    this.onViewChange = options.onViewChange || null;
    this.onSelect = options.onSelect || null;
    this.onPaint = options.onPaint || null;
    this.cutaway = normalizeCutaway();
    this.cutawayMaxHeight = 1;
    this.onCutawayChange = null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(MAZE_COLORS.empty);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 1600);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = this.mode !== "world";
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.fuzzyOverlay = new MazeFuzzyOverlayV1(canvas, this.mode !== "world");
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.target = new THREE.Vector3();
    this.heading = DEFAULT_HEADING;
    this.yaw = this.heading * CARDINAL_STEP;
    this.pitch = DEFAULT_PITCH;
    this.distance = 30;
    this.cameraMotion = {
      frameId: 0,
      heldKeys: new Set(),
      lastMs: 0,
      panHorizontal: 0,
      panForward: 0,
      panVelocityX: 0,
      panVelocityZ: 0,
      tiltDirection: 0,
      tiltVelocity: 0,
      zoomDirection: 0,
      zoomVelocity: 0,
      centerAnimation: null,
      yawAnimation: null,
      zoomAnimation: null
    };
    this.runCameraFrame = this.runCameraFrame.bind(this);
    this.content = new THREE.Group();
    this.cutawayContent = new THREE.Group();
    this.placementPreview = new THREE.Group();
    this.placementPreview.renderOrder = 30;
    this.scene.add(this.content, this.cutawayContent, this.placementPreview);
    this.pickMeshes = [];
    this.cellTops = new Map();
    this.pointer = null;
    this.painting = false;
    this.lastPaintKey = "";
    this.modelLoadGeneration = 0;
    this.installScene();
    this.installEvents();
    this.setWorld(world);
    this.resize();
  }

  installScene() {
    this.scene.add(new THREE.AmbientLight("#ffffff", 1.45));
    const key = new THREE.DirectionalLight("#ffffff", 1.2);
    key.position.set(5, 18, -5);
    key.target.position.set(0, 0, 0);
    key.castShadow = this.mode !== "world";
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.006;
    key.shadow.radius = 4;
    this.keyLight = key;
    this.scene.add(key, key.target);
  }

  configureShadows() {
    if (!this.keyLight?.castShadow) return;
    const span = Math.max(this.totalWidth, this.totalHeight, 8);
    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = -span;
    shadowCamera.right = span;
    shadowCamera.top = span;
    shadowCamera.bottom = -span;
    shadowCamera.near = 1;
    shadowCamera.far = span * 3;
    shadowCamera.updateProjectionMatrix();
  }

  installEvents() {
    this.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      if (this.mode === "editor" && event.button === 0 && !event.altKey) {
        this.painting = true;
        this.lastPaintKey = "";
        this.paintAt(event, true);
        return;
      }
      this.cancelCameraMotion();
      this.onInspect?.(null);
      this.pointer = { x: event.clientX, y: event.clientY, moved: false, headingDrag: 0 };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.painting) return this.paintAt(event, false);
      if (this.pointer) {
        const dx = event.clientX - this.pointer.x;
        const dy = event.clientY - this.pointer.y;
        this.pointer.moved ||= Math.abs(dx) + Math.abs(dy) > 3;
        this.pointer.x = event.clientX;
        this.pointer.y = event.clientY;
        this.pointer.headingDrag += dx;
        while (Math.abs(this.pointer.headingDrag) >= DRAG_HEADING_THRESHOLD) {
          this.rotateCardinal(this.pointer.headingDrag > 0 ? -1 : 1, false);
          this.pointer.headingDrag += this.pointer.headingDrag > 0
            ? -DRAG_HEADING_THRESHOLD
            : DRAG_HEADING_THRESHOLD;
        }
        this.pitch = this.clampPitch(this.pitch + dy * 0.004);
        return this.render();
      }
      this.onInspect?.(this.hitTest(event));
    });
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.painting && !this.pointer) this.onInspect?.(null);
    });
    const finishPointer = (event) => {
      if (this.painting) {
        this.painting = false;
        this.lastPaintKey = "";
        return;
      }
      if (event.type === "pointerup" && event.button === 0 && this.pointer && !this.pointer.moved) {
        this.onSelect?.(this.hitTest(event));
      }
      this.pointer = null;
    };
    this.canvas.addEventListener("pointerup", finishPointer);
    this.canvas.addEventListener("pointercancel", finishPointer);
    window.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      const continuousKeys = ["w", "s", "q", "e", "arrowleft", "arrowright", "arrowup", "arrowdown"];
      if (!["a", "d", "/", ...continuousKeys].includes(key)) return;
      event.preventDefault();
      if (continuousKeys.includes(key)) {
        this.cameraMotion.heldKeys.add(key);
        if (key === "q" || key === "e") this.cameraMotion.zoomAnimation = null;
        this.recomputeContinuousDirections();
      } else if ((key === "a" || key === "d") && !event.repeat) {
        this.rotateCardinal(key === "a" ? -1 : 1);
      } else if (!event.repeat) {
        this.centerBoard();
      }
    });
    window.addEventListener("keyup", (event) => {
      const key = event.key.toLowerCase();
      if (!this.cameraMotion.heldKeys.has(key)) return;
      this.cameraMotion.heldKeys.delete(key);
      this.recomputeContinuousDirections();
    });
    window.addEventListener("blur", () => {
      this.cameraMotion.heldKeys.clear();
      this.recomputeContinuousDirections();
    });
  }

  rotateCardinal(direction, animate = true) {
    const motion = this.cameraMotion;
    this.heading = (this.heading + direction + 4) % 4;
    const fromYaw = motion.yawAnimation?.targetYaw ?? this.yaw;
    const targetYaw = fromYaw + direction * CARDINAL_STEP;
    if (!animate) {
      motion.yawAnimation = null;
      this.yaw = targetYaw;
      return;
    }
    motion.yawAnimation = {
      startMs: performance.now(),
      startYaw: this.yaw,
      targetYaw
    };
    this.scheduleCameraFrame();
  }

  setCameraControl(key, active) {
    // Keep touch controls separate from physical keys held at the same time.
    const control = `control:${key}`;
    if (active) this.cameraMotion.heldKeys.add(control);
    else this.cameraMotion.heldKeys.delete(control);
    if (active && (key === "q" || key === "e")) this.cameraMotion.zoomAnimation = null;
    this.recomputeContinuousDirections();
  }

  recomputeContinuousDirections() {
    const motion = this.cameraMotion;
    const held = (key) => motion.heldKeys.has(key) || motion.heldKeys.has(`control:${key}`);
    motion.tiltDirection = Number(held("w")) - Number(held("s"));
    motion.zoomDirection = Number(held("e")) - Number(held("q"));
    motion.panHorizontal = Number(held("arrowright")) - Number(held("arrowleft"));
    motion.panForward = Number(held("arrowup")) - Number(held("arrowdown"));
    if (motion.panHorizontal || motion.panForward) motion.centerAnimation = null;
    if (
      motion.tiltDirection || motion.tiltVelocity ||
      motion.zoomDirection || motion.zoomVelocity ||
      motion.panHorizontal || motion.panForward || motion.panVelocityX || motion.panVelocityZ
    ) this.scheduleCameraFrame();
  }

  clampPitch(pitch) {
    return clampCameraPitch(pitch, this.mode === "editor");
  }

  scheduleCameraFrame() {
    if (!this.cameraMotion.frameId) {
      this.cameraMotion.frameId = requestAnimationFrame(this.runCameraFrame);
    }
  }

  runCameraFrame(now) {
    const motion = this.cameraMotion;
    motion.frameId = 0;
    const deltaSeconds = motion.lastMs
      ? Math.min(0.05, Math.max(0.001, (now - motion.lastMs) / 1000))
      : 1 / 60;
    motion.lastMs = now;
    let continueLoop = false;

    if (motion.yawAnimation) {
      const transition = yawTransitionAt(motion.yawAnimation, now);
      this.yaw = transition.yaw;
      if (transition.complete) {
        this.yaw = motion.yawAnimation.targetYaw;
        motion.yawAnimation = null;
      } else {
        continueLoop = true;
      }
    }

    if (motion.zoomAnimation) {
      const transition = zoomTransitionAt(motion.zoomAnimation, now);
      this.distance = transition.distance;
      if (transition.complete) {
        this.distance = motion.zoomAnimation.targetDistance;
        motion.zoomAnimation = null;
      } else {
        continueLoop = true;
      }
    }

    if (motion.centerAnimation) {
      const transition = centerTransitionAt(motion.centerAnimation, now);
      this.target.x = transition.x;
      this.target.z = transition.z;
      if (transition.complete) {
        this.target.x = motion.centerAnimation.targetX;
        this.target.z = motion.centerAnimation.targetZ;
        motion.centerAnimation = null;
      } else {
        continueLoop = true;
      }
    }

    if (motion.tiltDirection || motion.tiltVelocity) {
      const targetVelocity = motion.tiltDirection * CAMERA_TILT_MAX_SPEED;
      const rate = motion.tiltDirection ? CAMERA_TILT_ACCEL : CAMERA_TILT_DECEL;
      motion.tiltVelocity = easeToward(motion.tiltVelocity, targetVelocity, rate * deltaSeconds);
      if (!motion.tiltDirection && Math.abs(motion.tiltVelocity) < 0.002) motion.tiltVelocity = 0;
      const previousPitch = this.pitch;
      this.pitch = this.clampPitch(previousPitch + motion.tiltVelocity * deltaSeconds);
      if (this.pitch === previousPitch && !motion.tiltDirection) motion.tiltVelocity = 0;
      if (motion.tiltDirection || motion.tiltVelocity) continueLoop = true;
    }

    if (motion.zoomDirection || motion.zoomVelocity) {
      const targetVelocity = motion.zoomDirection * CAMERA_ZOOM_MAX_LOG_SPEED;
      const rate = motion.zoomDirection ? CAMERA_ZOOM_ACCEL : CAMERA_ZOOM_DECEL;
      motion.zoomVelocity = easeToward(motion.zoomVelocity, targetVelocity, rate * deltaSeconds);
      if (!motion.zoomDirection && Math.abs(motion.zoomVelocity) < 0.002) motion.zoomVelocity = 0;
      const limits = this.zoomLimits();
      const previousDistance = this.distance;
      this.distance = zoomDistanceAtVelocity(this.distance, motion.zoomVelocity, deltaSeconds, limits);
      if (this.distance === previousDistance && motion.zoomDirection) motion.zoomVelocity = 0;
      if (motion.zoomDirection || motion.zoomVelocity) continueLoop = true;
    }

    if (motion.panHorizontal || motion.panForward || motion.panVelocityX || motion.panVelocityZ) {
      const input = cameraRelativePanVector(this.yaw, motion.panHorizontal, motion.panForward);
      const speed = panSpeedForDistance(this.distance);
      const hasInput = Boolean(motion.panHorizontal || motion.panForward);
      const rate = speed * (hasInput ? CAMERA_PAN_ACCEL_MULTIPLIER : CAMERA_PAN_DECEL_MULTIPLIER);
      motion.panVelocityX = easeToward(motion.panVelocityX, input.x * speed, rate * deltaSeconds);
      motion.panVelocityZ = easeToward(motion.panVelocityZ, input.z * speed, rate * deltaSeconds);
      if (!hasInput && Math.hypot(motion.panVelocityX, motion.panVelocityZ) < 0.01) {
        motion.panVelocityX = 0;
        motion.panVelocityZ = 0;
      }
      const limitX = Math.max(0, this.totalWidth / 2);
      const limitZ = Math.max(0, this.totalHeight / 2);
      const previousX = this.target.x;
      const previousZ = this.target.z;
      this.target.x = Math.max(-limitX, Math.min(limitX, previousX + motion.panVelocityX * deltaSeconds));
      this.target.z = Math.max(-limitZ, Math.min(limitZ, previousZ + motion.panVelocityZ * deltaSeconds));
      if (this.target.x === previousX && Math.sign(motion.panVelocityX) === Math.sign(this.target.x)) motion.panVelocityX = 0;
      if (this.target.z === previousZ && Math.sign(motion.panVelocityZ) === Math.sign(this.target.z)) motion.panVelocityZ = 0;
      if (hasInput || motion.panVelocityX || motion.panVelocityZ) continueLoop = true;
    }

    this.render();
    if (continueLoop) this.scheduleCameraFrame();
    else motion.lastMs = 0;
  }

  cancelCameraMotion() {
    const motion = this.cameraMotion;
    if (motion.frameId) cancelAnimationFrame(motion.frameId);
    if (motion.yawAnimation) this.yaw = motion.yawAnimation.targetYaw;
    if (motion.zoomAnimation) this.distance = motion.zoomAnimation.targetDistance;
    motion.frameId = 0;
    motion.lastMs = 0;
    motion.tiltDirection = 0;
    motion.tiltVelocity = 0;
    motion.zoomDirection = 0;
    motion.zoomVelocity = 0;
    motion.panHorizontal = 0;
    motion.panForward = 0;
    motion.panVelocityX = 0;
    motion.panVelocityZ = 0;
    motion.centerAnimation = null;
    motion.yawAnimation = null;
    motion.zoomAnimation = null;
    motion.heldKeys.clear();
  }

  cameraDirections() {
    const quarterTurns = ((Math.round(this.yaw / CARDINAL_STEP) % 4) + 4) % 4;
    return HEADING_DIRECTIONS[quarterTurns];
  }

  paintAt(event, start) {
    const hit = this.hitTest(event);
    if (!hit) return;
    const key = this.world.storageFormat === V2_WORLD_FORMAT
      ? `${hit.room.fileName}:${hit.sourceX}:${hit.sourceY}:${hit.sourceZ}:${hit.face}`
      : `${hit.room.fileName}:${hit.cellX}:${hit.cellY}`;
    if (key === this.lastPaintKey) return;
    this.lastPaintKey = key;
    this.onPaint?.(hit, { start });
  }

  setWorld(world, options = {}) {
    clearPlacementPreview(this.placementPreview);
    this.canvas.dataset.placementPreview = "";
    this.world = world;
    if (this.mode !== "world" && world.storageFormat === V2_WORLD_FORMAT) {
      this.cutawayMaxHeight = cutawayMaxHeight(world);
    }
    this.totalWidth = world.columns.length * world.roomWidth;
    this.totalHeight = world.rows.length * world.roomHeight;
    this.canvas.dataset.contextRoomCount = String(world.rooms.filter((room) => room.renderDimmed).length);
    this.canvas.dataset.activeRoom = world.contextActiveRoom?.fileName || "";
    this.configureShadows();
    this.setSelection(null);
    const modelUrls = this.rebuild();
    this.requestModels(modelUrls);
    if (!options.preserveCamera) this.resetView();
    this.onCutawayChange?.();
  }

  get cutawayHeight() {
    return this.cutaway.followPlayer
      ? playerCutawayHeight(this.world) ?? this.cutaway.height
      : this.cutaway.height;
  }

  setCutaway(settings) {
    this.cutaway = normalizeCutaway({ ...this.cutaway, ...settings });
    clearPlacementPreview(this.placementPreview);
    this.canvas.dataset.placementPreview = "";
    this.setSelection(null);
    this.requestModels(this.rebuild());
    this.onCutawayChange?.();
  }

  setRoom(room, options = {}) {
    const previousWorld = this.world;
    this.setWorld({
      storageFormat: previousWorld?.storageFormat,
      schemaVersion: previousWorld?.schemaVersion,
      coordinateSystem: previousWorld?.coordinateSystem,
      blocks: previousWorld?.blocks,
      blockDefinitions: previousWorld?.blockDefinitions,
      columns: [room.position[0]],
      rows: [room.position[1]],
      roomWidth: room.width || room.cells?.[0]?.length || 16,
      roomHeight: room.height || room.cells?.length || 16,
      rooms: [{ ...room, columnIndex: 0, rowIndex: 0 }]
    }, options);
  }

  requestModels(urls) {
    const generation = ++this.modelLoadGeneration;
    if (!urls.size) return;
    loadAssetModels(urls).then(() => {
      if (generation !== this.modelLoadGeneration) return;
      this.rebuild();
      this.render();
    });
  }

  setPlacementPreview(object) {
    const block = object ? this.world.blockDefinitions?.get(object.blockId) : null;
    this.canvas.dataset.placementPreview = object ? JSON.stringify(object) : "";
    renderPlacementPreview(this.placementPreview, roomObjectInContext(this.world, object), block, {
      totalWidth: this.totalWidth,
      totalHeight: this.totalHeight
    });
    this.assignRenderLayers(this.placementPreview);
    this.render();
  }

  clearPlacementPreview() {
    this.canvas.dataset.placementPreview = "";
    clearPlacementPreview(this.placementPreview);
    this.render();
  }

  collectScene() {
    if (this.world.storageFormat === V2_WORLD_FORMAT) return collectVoxelSceneV2(this);
    const floorGroups = new Map();
    const cubeGroups = new Map();
    const occupied = new Set();
    const specialPieces = [];
    const terrainAssets = [];
    const gems = [];
    const genericLabels = [];
    const modelUrls = new Set();
    const editorGridCells = [];
    const cellMetadata = [];
    this.cellTops = new Map();

    const recordTop = (x, z, top) => {
      const key = `${x},${z}`;
      this.cellTops.set(key, Math.max(this.cellTops.get(key) ?? -Infinity, top));
    };
    const addVoxelColumn = (groupKey, settings, x, z, bottom, height) => {
      const group = groupEntry(cubeGroups, groupKey, settings);
      for (let offset = 0; offset < height; offset += 1) {
        const voxel = { x, z, y: bottom + offset };
        const key = voxelKey(voxel.x, voxel.z, voxel.y);
        if (!group.voxelKeys.has(key)) {
          group.voxels.push(voxel);
          group.voxelKeys.add(key);
        }
        occupied.add(key);
      }
      recordTop(x, z, bottom + height);
    };

    this.world.rooms.forEach((room) => {
      room.cells.forEach((row, cellY) => row.forEach((rawCell, cellX) => {
        const x = room.columnIndex * this.world.roomWidth + cellX;
        const z = room.rowIndex * this.world.roomHeight + cellY;
        const state = parseCellState(rawCell);
        cellMetadata.push({ x, z, room, cellX, cellY, cell: rawCell });

        state.layers.forEach((layer) => {
          const definition = terrainPieceDefinition(layer);
          recordTop(x, z, definition.top);
          if (definition.kind === "floor") {
            const key = `floor:${layer.type}:${definition.color}`;
            if (!floorGroups.has(key)) floorGroups.set(key, { color: definition.color, cells: [] });
            const floor = { x, z, bottom: definition.bottom, top: definition.top };
            floorGroups.get(key).cells.push(floor);
            if (definition.editorGrid) editorGridCells.push(floor);
            if (definition.exitMarker) {
              specialPieces.push({
                x,
                z,
                source: layer,
                definition: { kind: "exit_marker", bottom: definition.top + 0.02, top: definition.top + 0.36 }
              });
              recordTop(x, z, definition.top + 0.36);
            }
            return;
          }
          if (definition.kind === "terrain_asset") {
            modelUrls.add(layer.modelUrl);
            if (assetReady(layer.modelUrl)) {
              terrainAssets.push({ x, z, localX: cellX, localZ: cellY, source: layer, definition });
            } else {
              addVoxelColumn(
                `asset-fallback:${layer.type}:${definition.color}`,
                { color: definition.color },
                x,
                z,
                definition.bottom,
                definition.fallbackHeight
              );
            }
            return;
          }
          if (definition.kind === "cube") {
            addVoxelColumn(
              `terrain:${layer.type}:${layer.styleKey || ""}:${definition.color}`,
              { color: definition.color },
              x,
              z,
              definition.bottom,
              definition.height
            );
            return;
          }
          specialPieces.push({ x, z, source: layer, definition });
        });

        state.actors.forEach((actor) => {
          const definition = actorPieceDefinition(actor);
          recordTop(x, z, definition.top);
          if (definition.kind === "gem_asset") {
            modelUrls.add(actor.modelUrl);
            gems.push({ x, z, source: actor, definition });
            return;
          }
          if (definition.kind === "cube") {
            const identity = actor.groupId || actor.type;
            addVoxelColumn(
              `actor:${actor.type}:${identity}:${definition.color}`,
              { color: definition.color },
              x,
              z,
              definition.bottom,
              definition.height
            );
            return;
          }
          specialPieces.push({ x, z, source: actor, definition });
        });
      }));
    });

    return {
      cellMetadata,
      cubeGroups,
      editorGridCells,
      floorGroups,
      gems,
      genericLabels,
      modelUrls,
      occupied,
      specialPieces,
      terrainAssets
    };
  }

  addFloorGroups(groups, content = this.content) {
    const halfWidth = this.totalWidth / 2;
    const halfHeight = this.totalHeight / 2;
    groups.forEach((group) => {
      const geometry = geometryFromFaces(floorFaces(group.cells, halfWidth, halfHeight));
      const mesh = new THREE.Mesh(geometry, renderMaterial(group.color, group.dimmed));
      mesh.receiveShadow = true;
      content.add(mesh);
    });
  }

  addCubeGroups(groups, occupied, content = this.content, minHeight = -Infinity) {
    const halfWidth = this.totalWidth / 2;
    const halfHeight = this.totalHeight / 2;
    groups.forEach((group) => {
      const rawFaces = voxelFaces(group.voxels, occupied, halfWidth, halfHeight);
      const faces = Number.isFinite(minHeight) ? rawFaces.filter(face =>
        !(face.normal === "y-" && face.corners.every(corner => corner[1] === minHeight))) : rawFaces;
      if (!faces.length) return;
      const geometry = geometryFromFaces(faces);
      const mesh = new THREE.Mesh(geometry, renderMaterial(group.color, group.dimmed));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      content.add(mesh);
      const edges = new THREE.LineSegments(
        edgeGeometryFromFaces(faces),
        group.dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial()
      );
      edges.renderOrder = 10;
      content.add(edges);
    });
  }

  addEditorGrid(cells) {
    if (this.mode === "world") return;
    const positions = [];
    const seen = new Set();
    const add = (from, to, y) => {
      const key = `${y}:${[from.join(","), to.join(",")].sort().join(":")}`;
      if (seen.has(key)) return;
      seen.add(key);
      positions.push(
        from[0] - this.totalWidth / 2, y + 0.006, from[1] - this.totalHeight / 2,
        to[0] - this.totalWidth / 2, y + 0.006, to[1] - this.totalHeight / 2
      );
    };
    cells.forEach((cell) => {
      add([cell.x, cell.z], [cell.x + 1, cell.z], cell.top);
      add([cell.x + 1, cell.z], [cell.x + 1, cell.z + 1], cell.top);
      add([cell.x + 1, cell.z + 1], [cell.x, cell.z + 1], cell.top);
      add([cell.x, cell.z + 1], [cell.x, cell.z], cell.top);
    });
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const opacity = this.mode === "editor" ? 0.34 : 0.2;
    this.content.add(new THREE.LineSegments(geometry, edgeMaterial(0x715c3d, opacity)));
  }

  addEditorPickMesh(metadata) {
    if (!this.pickVoxels || !metadata.length) return;
    const geometry = cachedGeometry("editor-pick-box", () => new THREE.BoxGeometry(1, 1, 1));
    const pickMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      colorWrite: false,
      depthWrite: false,
      opacity: 0,
      transparent: true
    });
    const mesh = new THREE.InstancedMesh(geometry, pickMaterial, metadata.length);
    mesh.userData.transientMaterial = true;
    const dummy = new THREE.Object3D();
    metadata.forEach((record, index) => {
      const bottom = -FLOOR_DROP - FLOOR_THICKNESS;
      const top = Math.max(0.02, this.cellTops.get(`${record.x},${record.z}`) ?? 0.02);
      dummy.position.set(
        record.x - this.totalWidth / 2 + 0.5,
        (bottom + top) / 2,
        record.z - this.totalHeight / 2 + 0.5
      );
      dummy.scale.set(1, top - bottom, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.instances = metadata;
    this.content.add(mesh);
    this.pickMeshes.push(mesh);
  }

  addEditorVoxelPickMesh(records) {
    if (!this.pickVoxels || !records?.length) return;
    const geometry = cachedGeometry("editor-v2-pick-box", () => new THREE.BoxGeometry(1, 1, 1));
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      colorWrite: false,
      depthWrite: false,
      opacity: 0,
      transparent: true
    });
    const mesh = new THREE.InstancedMesh(geometry, material, records.length);
    mesh.userData.transientMaterial = true;
    const dummy = new THREE.Object3D();
    records.forEach((record, index) => {
      const height = Math.max(0.04, record.top - record.bottom);
      dummy.position.set(
        record.globalX - this.totalWidth / 2 + 0.5,
        record.bottom + height / 2,
        record.globalY - this.totalHeight / 2 + 0.5
      );
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.voxelInstances = records;
    this.content.add(mesh);
    this.pickMeshes.push(mesh);
  }

  rebuild() {
    disposeGeneratedChildren(this.content);
    disposeGeneratedChildren(this.cutawayContent);
    this.pickMeshes = [];
    const height = this.cutawayHeight;
    const isCutaway = this.world.storageFormat === V2_WORLD_FORMAT && height !== null;
    const data = isCutaway ? collectVoxelSceneV2(this, { maxHeight: height }) : this.collectScene();
    const dimensions = { totalWidth: this.totalWidth, totalHeight: this.totalHeight };
    const addPiece = (content, record, add) => {
      const first = content.children.length;
      add(content, record, dimensions);
      if (isCutaway && record.definition.bottom < height && record.definition.top > height) {
        content.children.slice(first).forEach(child => child.traverse(object => {
          object.userData.cutawayClip = true;
        }));
      }
    };
    this.addFloorGroups(data.floorGroups);
    this.addCubeGroups(data.cubeGroups, data.occupied);
    data.terrainAssets.forEach((record) => addPiece(this.content, record, addTerrainAsset));
    data.gems.forEach((record) => addPiece(this.content, record, addGemAsset));
    data.specialPieces.forEach((record) => addPiece(this.content, record, addSpecialPiece));
    if (this.pickVoxels) {
      data.genericLabels?.forEach((record) => addGenericNumberFaces(this.content, record, dimensions));
    }
    this.addEditorGrid(data.editorGridCells);
    if (data.pickRecords) this.addEditorVoxelPickMesh(data.pickRecords);
    else this.addEditorPickMesh(data.cellMetadata);
    if (isCutaway) {
      applyCutawayMaterials(this.content, { height, clip: false });
      if (this.mode === "play" && this.cutaway.opacity > 0) {
        const upper = collectVoxelSceneV2({ world: this.world }, { minHeight: height });
        this.addFloorGroups(upper.floorGroups, this.cutawayContent);
        this.addCubeGroups(upper.cubeGroups, upper.occupied, this.cutawayContent, height);
        upper.terrainAssets.forEach((record) => addPiece(this.cutawayContent, record, addTerrainAsset));
        upper.gems.forEach((record) => addPiece(this.cutawayContent, record, addGemAsset));
        upper.specialPieces.forEach((record) => addPiece(this.cutawayContent, record, addSpecialPiece));
        applyCutawayMaterials(this.cutawayContent, { height, upper: true, opacity: this.cutaway.opacity, clip: false });
        upper.modelUrls.forEach((url) => data.modelUrls.add(url));
      }
    }
    this.canvas.dataset.cutawayHeight = height === null ? "full" : String(height);
    this.canvas.dataset.cutawayOpacity = String(this.cutaway.opacity);
    this.canvas.dataset.cutawayFollowPlayer = String(this.cutaway.followPlayer);
    this.canvas.dataset.visiblePickCount = String(data.pickRecords?.length || 0);
    this.assignRenderLayers(this.content);
    this.assignRenderLayers(this.cutawayContent);
    if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
    this.render();
    return data.modelUrls;
  }

  resize() {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.fuzzyOverlay.resize();
    this.render();
  }

  fitDistance() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const contextScale = this.world.contextActiveRoom ? CONTEXT_VIEW_SCALE : 1;
    const viewWidth = this.world.contextActiveRoom
      ? this.world.roomWidth * contextScale
      : this.totalWidth;
    const viewHeight = this.world.contextActiveRoom
      ? this.world.roomHeight * contextScale
      : this.totalHeight;
    const vertical = (viewHeight / 2) / Math.tan(fov / 2);
    const horizontal = (viewWidth / 2) / (Math.tan(fov / 2) * Math.max(this.camera.aspect, 0.1));
    return Math.max(vertical, horizontal, Math.max(viewWidth, viewHeight) * 1.15) * 1.18;
  }

  updateCamera() {
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horizontal,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * horizontal
    );
    this.camera.lookAt(this.target);
    this.canvas.dataset.cameraHeading = String(this.heading * 90);
    this.canvas.dataset.cameraPitch = String(Math.round(THREE.MathUtils.radToDeg(this.pitch)));
    this.canvas.dataset.cameraYawDegrees = THREE.MathUtils.radToDeg(this.yaw).toFixed(3);
    this.canvas.dataset.cameraDistance = this.distance.toFixed(3);
    this.canvas.dataset.cameraTargetX = this.target.x.toFixed(3);
    this.canvas.dataset.cameraTargetZ = this.target.z.toFixed(3);
    this.content.traverse((object) => {
      if (object.userData.liftMarker) object.rotation.y = this.yaw;
    });
    this.cutawayContent.traverse((object) => {
      if (object.userData.liftMarker) object.rotation.y = this.yaw;
    });
  }

  assignRenderLayers(root) {
    root.traverse((object) => {
      if (object.isLineSegments && object.material?.userData?.mazeOutline) {
        // The full world remains a single combined render pass. Splitting its
        // 94k-object scene into face and outline passes made camera movement
        // needlessly expensive.
        object.layers.set(this.mode === "world" ? 0 : OUTLINE_LAYER);
      }
    });
  }

  renderThickOutlines() {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    // The world map can contain thousands of meshes. Keep its edge pass to one
    // draw; the five screen-space stamps are reserved for single-room views.
    const pixelOffsets = this.mode === "world"
      ? OUTLINE_PIXEL_OFFSETS.slice(0, 1)
      : OUTLINE_PIXEL_OFFSETS;
    const previousAutoClear = this.renderer.autoClear;
    const previousBackground = this.scene.background;
    this.renderer.autoClear = false;
    this.scene.background = null;
    this.camera.layers.set(OUTLINE_LAYER);
    try {
      pixelOffsets.forEach(([x, y]) => {
        this.camera.setViewOffset(width, height, x, y, width, height);
        this.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, this.camera);
      });
    } finally {
      this.scene.background = previousBackground;
      this.camera.clearViewOffset();
      this.camera.updateProjectionMatrix();
      this.camera.layers.set(0);
      this.renderer.autoClear = previousAutoClear;
    }
  }

  render() {
    this.updateCamera();
    this.camera.layers.set(0);
    this.renderer.render(this.scene, this.camera);
    if (this.mode !== "world") this.renderThickOutlines();
    this.onViewChange?.(this);
  }

  projectRoomOutline(room) {
    const left = room.columnIndex * this.world.roomWidth - this.totalWidth / 2;
    const top = room.rowIndex * this.world.roomHeight - this.totalHeight / 2;
    const corners = [
      [left, top], [left + this.world.roomWidth, top],
      [left + this.world.roomWidth, top + this.world.roomHeight], [left, top + this.world.roomHeight]
    ].map(([x, z]) => new THREE.Vector3(x, 0.05, z).applyMatrix4(this.camera.matrixWorldInverse));
    // Clip against the near plane before projection, including at close zoom.
    const clipped = [];
    const nearZ = -this.camera.near;
    for (let index = 0; index < corners.length; index++) {
      const start = corners[index];
      const end = corners[(index + 1) % corners.length];
      const startInside = start.z <= nearZ;
      const endInside = end.z <= nearZ;
      if (startInside) clipped.push(start.clone());
      if (startInside !== endInside) {
        clipped.push(start.clone().lerp(end, (nearZ - start.z) / (end.z - start.z)));
      }
    }
    return clipped.map((point) => {
      point.applyMatrix4(this.camera.projectionMatrix);
      return { x: (point.x + 1) * this.canvas.clientWidth / 2, y: (1 - point.y) * this.canvas.clientHeight / 2 };
    });
  }

  zoomBy(factor) {
    const limits = this.zoomLimits();
    const fromDistance = this.cameraMotion.zoomAnimation?.targetDistance ?? this.distance;
    const targetDistance = Math.max(limits[0], Math.min(limits[1], fromDistance * factor));
    this.cameraMotion.zoomVelocity = 0;
    this.cameraMotion.zoomAnimation = {
      startMs: performance.now(),
      startDistance: this.distance,
      targetDistance
    };
    this.scheduleCameraFrame();
  }

  zoomLimits() {
    return this.mode === "world" ? [22, 1000] : [7, 110];
  }

  centerBoard() {
    const motion = this.cameraMotion;
    for (const key of ["arrowleft", "arrowright", "arrowup", "arrowdown"]) {
      motion.heldKeys.delete(key);
    }
    motion.panHorizontal = 0;
    motion.panForward = 0;
    motion.panVelocityX = 0;
    motion.panVelocityZ = 0;
    motion.centerAnimation = {
      startMs: performance.now(),
      startX: this.target.x,
      startZ: this.target.z,
      targetX: 0,
      targetZ: 0
    };
    this.scheduleCameraFrame();
  }

  resetView() {
    this.cancelCameraMotion();
    this.target.set(0, this.mode === "world" ? 1.5 : 1.2, 0);
    this.heading = DEFAULT_HEADING;
    this.yaw = this.heading * CARDINAL_STEP;
    this.pitch = DEFAULT_PITCH;
    this.distance = this.fitDistance();
    this.render();
  }

  focusRoom(room) {
    if (!room || this.mode !== "world") return;
    this.cameraMotion.centerAnimation = null;
    this.cameraMotion.zoomAnimation = null;
    this.cameraMotion.panVelocityX = 0;
    this.cameraMotion.panVelocityZ = 0;
    this.target.set(
      room.columnIndex * this.world.roomWidth - this.totalWidth / 2 + this.world.roomWidth / 2,
      1.5,
      room.rowIndex * this.world.roomHeight - this.totalHeight / 2 + this.world.roomHeight / 2
    );
    this.distance = 33;
    this.render();
  }

  hitTest(event) {
    const bounds = this.canvas.getBoundingClientRect();
    this.mouse.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1
    );
    this.raycaster.setFromCamera(this.mouse, this.camera);
    if (this.pickVoxels) {
      const intersections = this.raycaster.intersectObjects(this.pickMeshes, false);
      const intersection = intersections.find((entry) => Number.isInteger(entry.instanceId));
      const voxelRecord = intersection?.object?.userData?.voxelInstances?.[intersection.instanceId];
      if (voxelRecord) return this.voxelHit(voxelRecord, intersection);
      const metadata = intersection?.object?.userData?.instances?.[intersection.instanceId];
      if (metadata) return metadata;
    }
    const point = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return null;
    const globalX = Math.floor(point.x + this.totalWidth / 2);
    const globalY = Math.floor(point.z + this.totalHeight / 2);
    if (globalX < 0 || globalY < 0 || globalX >= this.totalWidth || globalY >= this.totalHeight) return null;
    const columnIndex = Math.floor(globalX / this.world.roomWidth);
    const rowIndex = Math.floor(globalY / this.world.roomHeight);
    const room = this.world.rooms.find((candidate) =>
      candidate.columnIndex === columnIndex && candidate.rowIndex === rowIndex);
    if (!room || (this.pickVoxels && room.renderDimmed)) return null;
    const cellX = globalX % this.world.roomWidth;
    const cellY = globalY % this.world.roomHeight;
    if (this.world.storageFormat === V2_WORLD_FORMAT) {
      return {
        room,
        kind: "ground",
        cellX,
        cellY,
        sourceX: cellX,
        sourceY: cellY,
        sourceZ: 0,
        paintX: cellX,
        paintY: cellY,
        paintZ: 0,
        dx: 0,
        dy: 0,
        dz: 1,
        face: "top"
      };
    }
    return { room, cellX, cellY, cell: room.cells[cellY]?.[cellX] ?? "" };
  }

  voxelHit(record, intersection) {
    const normal = intersection.face?.normal || new THREE.Vector3(0, 1, 0);
    const dx = Math.round(normal.x);
    const dy = Math.round(normal.z);
    const dz = Math.round(normal.y);
    const object = record.object;
    const objectTopLayer = object.z + Math.max(1, record.height) - 1;
    let sourceZ = object.z;
    let paintZ = object.z;
    if (dz > 0) {
      sourceZ = objectTopLayer;
      paintZ = record.surfaceFloor ? object.z : objectTopLayer + 1;
    } else if (dz < 0) {
      paintZ = object.z - 1;
    } else {
      sourceZ = Math.max(object.z, Math.min(objectTopLayer, Math.floor(intersection.point.y)));
      paintZ = sourceZ;
    }
    return {
      room: record.room,
      object,
      block: record.block,
      kind: record.block.category || "terrain",
      sourceX: object.x,
      sourceY: object.y,
      sourceZ,
      paintX: object.x + dx,
      paintY: object.y + dy,
      paintZ,
      dx,
      dy,
      dz,
      face: dz > 0 ? "top" : dz < 0 ? "bottom-face" : "side-face",
      selectionKey: cellObjectSelectionKey(object)
    };
  }

  selectRoom(room) {
    this.setSelection(room ? { room } : null);
  }

  selectCell(room, cellX, cellY, cellZ) {
    this.setSelection({ room, cellX, cellY, cellZ });
  }

  setSelection(selection) {
    if (this.selection) {
      this.scene.remove(this.selection);
      this.selection.geometry.dispose();
      this.selection.material.dispose();
      this.selection = null;
    }
    if (!selection?.room) return this.render();
    const isCell = Number.isInteger(selection.cellX) && Number.isInteger(selection.cellY);
    const width = isCell ? 1 : this.world.roomWidth;
    const depth = isCell ? 1 : this.world.roomHeight;
    const baseX = selection.room.columnIndex * this.world.roomWidth - this.totalWidth / 2;
    const baseZ = selection.room.rowIndex * this.world.roomHeight - this.totalHeight / 2;
    const isVoxel = isCell && Number.isInteger(selection.cellZ);
    const geometry = new THREE.BoxGeometry(width, isVoxel ? 1.02 : 0.04, depth);
    const selectionMaterial = new THREE.MeshBasicMaterial({ color: MAZE_COLORS.gem, wireframe: true });
    this.selection = new THREE.Mesh(geometry, selectionMaterial);
    const globalX = selection.room.columnIndex * this.world.roomWidth + (selection.cellX || 0);
    const globalZ = selection.room.rowIndex * this.world.roomHeight + (selection.cellY || 0);
    const top = isCell ? Math.max(0.02, this.cellTops.get(`${globalX},${globalZ}`) ?? 0.02) : 0.02;
    this.selection.position.set(
      baseX + (isCell ? selection.cellX + 0.5 : width / 2),
      isVoxel ? selection.cellZ + 0.5 : top + 0.025,
      baseZ + (isCell ? selection.cellY + 0.5 : depth / 2)
    );
    this.scene.add(this.selection);
    this.render();
  }
}
