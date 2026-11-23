// Browser-only cached full-world renderer for Play and the editor. Keep the historical v1 renderer
// unchanged: its bytes are included in signed benchmark runtime manifests.
import * as THREE from "../render/vendor/three.module.min.js";
import { NumberedMazeRenderer } from "./numbered-maze-renderer.mjs";
import { BackgroundTruncation } from "./background-truncation.mjs";
import { prepareBrowserModels } from "./browser-world.mjs";
import { cutawayMaxHeight } from "../render/v1/cutaway.mjs";
import { clearPlacementPreview } from "../render/v1/placement-preview-v2.mjs";
import { roomBorderEdges, joinRoomBorderEdges } from "./room-border-edges.mjs";
import { RoomLighting } from "./room-lighting.mjs";
import { playRoomCenter } from "./play-world-context.mjs";

export class WorldContextRenderer extends NumberedMazeRenderer {
  // The base constructor calls these overrides, so initialize caches lazily.
  setWorld(world, options = {}) {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      const previousCenter = this.world && playRoomCenter(this.world);
      const center = playRoomCenter(world);
      if (previousCenter && options.preserveCamera && !options.preserveCameraPosition) {
        const dx = center.x - previousCenter.x;
        const dz = center.z - previousCenter.z;
        this.target.x += dx;
        this.target.z += dz;
        const animation = this.cameraMotion.centerAnimation;
        if (animation) {
          animation.startX += dx;
          animation.targetX += dx;
          animation.startZ += dz;
          animation.targetZ += dz;
        }
      }
      clearPlacementPreview(this.placementPreview);
      this.canvas.dataset.placementPreview = "";
      this.world = world;
      if (this.roomLighting && (this.roomLighting.columns !== world.columns.length || this.roomLighting.rows !== world.rows.length ||
          this.roomLighting.uniforms.mazeWorldSize.value.x !== world.columns.length * world.roomWidth ||
          this.roomLighting.uniforms.mazeWorldSize.value.y !== world.rows.length * world.roomHeight)) {
        this.roomLighting.dispose();
        this.roomLighting = null;
      }
      this.roomLighting ||= new RoomLighting(world);
      if (!options.preserveRoomLighting) this.roomLighting.select(world.contextActiveRoom);
      this.roomHeights ||= new WeakMap();
      this.backgroundMaxHeight = 1;
      for (const room of world.contextRooms) {
        if (!this.roomHeights.has(room)) this.roomHeights.set(room, cutawayMaxHeight({ ...world, rooms: [room] }));
        this.backgroundMaxHeight = Math.max(this.backgroundMaxHeight, this.roomHeights.get(room));
      }
      const active = world.rooms.find(room => !room.renderDimmed);
      this.cutawayMaxHeight = Math.max(this.backgroundMaxHeight,
        cutawayMaxHeight({ ...world, rooms: [active] }));
      this.totalWidth = world.columns.length * world.roomWidth;
      this.totalHeight = world.rows.length * world.roomHeight;
      this.canvas.dataset.contextRoomCount = String(world.rooms.length - 1);
      this.canvas.dataset.activeRoom = world.contextActiveRoom.fileName;
      this.configureShadows();
      this.setSelection(null);
      this.requestModels(this.rebuild());
      if (!options.preserveCamera) this.resetView();
      this.onCutawayChange?.();
    } finally {
      this.renderSuspended--;
    }
    this.render();
  }

  get cutawayHeight() {
    return this.sceneCutawayHeight !== undefined ? this.sceneCutawayHeight : super.cutawayHeight;
  }

  setCutaway(settings) {
    // Clearing the selection and rebuilding both request a render in the base
    // renderer. Present the finished update once, especially at world zoom.
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try { super.setCutaway(settings); }
    finally { this.renderSuspended--; }
    this.render();
  }

  clearBackground() {
    this.backgroundCapJob = null;
    this.backgroundJob?.resolve(false);
    this.backgroundJob = null;
    for (const entry of this.roomBackgrounds?.values() || []) this.backgroundTruncation?.disposeEntry(entry);
    this.backgroundTruncation?.dispose();
    this.backgroundTruncation = new BackgroundTruncation();
    this.roomBackgrounds = new Map();
    this.backgroundRoot?.clear();
    this.backgroundMarkers = [];
    this.seamIndex = null;
  }

  rebuild() {
    if (!this.backgroundRoot) {
      this.backgroundRoot = new THREE.Group();
      this.backgroundRoot.matrixAutoUpdate = false;
      this.scene.matrixAutoUpdate = false;
      this.scene.add(this.backgroundRoot);
    }
    const world = this.world;
    const content = this.content;
    const cutawayContent = this.cutawayContent;
    const height = this.cutawayHeight;
    if (this.backgroundSource !== world.contextRooms) {
      this.clearBackground();
      this.backgroundSource = world.contextRooms;
    }
    this.seamRooms = new Map(world.contextRooms.map(room => [room.fileName, room]));
    this.seamWorld = world;
    this.renderer.localClippingEnabled = true;
    const urls = new Set();
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    const previousPicking = this.pickVoxels;
    try {
      const cutChanged = this.backgroundTruncation.set(height, this.cutaway.opacity);
      this.updateBackgroundFrustum();
      for (const room of world.contextRooms) {
        let entry = this.roomBackgrounds.get(room.fileName);
        const active = room.fileName === world.contextActiveRoom.fileName;
        let prepared = false;
        // Edited active rooms rebuild their small foreground immediately. Their
        // hidden background snapshot only needs refreshing when we leave.
        if (entry && !active && (entry.room !== room || this.seamSources(room).some((objects, index) => objects !== entry.seamSources[index]))) {
          entry = this.buildBackground(room);
          prepared = true;
        }
        if (!entry) continue; // Initial background construction is spread across frames.
        entry.root.visible = !active;
        if (prepared || cutChanged) {
          const visible = this.backgroundRoomVisible(entry);
          this.backgroundTruncation.update(entry, { prepareCaps: visible });
          if (visible) this.prepareBackgroundCaps(entry);
        }
        entry.modelUrls.forEach(url => urls.add(url));
      }
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.world = { ...world, rooms: world.rooms.filter(room => !room.renderDimmed) };
      this.sceneCutawayHeight = height;
      this.pickVoxels = previousPicking;
      this.rebuildForeground().forEach(url => urls.add(url));
      this.canvas.dataset.cachedRoomCount = String(this.roomBackgrounds.size);
    } finally {
      this.world = world;
      this.content = content;
      this.cutawayContent = cutawayContent;
      this.sceneCutawayHeight = undefined;
      this.pickVoxels = previousPicking;
      this.renderSuspended--;
    }
    this.queueBackgrounds();
    this.queueBackgroundCaps();
    this.render();
    return urls;
  }

  rebuildForeground() { return super.rebuild(); }

  seamSources(room) {
    if (!this.seamIndex) {
      const grid = new Map(this.world.contextRooms.map(candidate => [`${candidate.columnIndex},${candidate.rowIndex}`, candidate.fileName]));
      this.seamIndex = new Map(this.world.contextRooms.map(candidate => [candidate.fileName,
        [[0,-1],[-1,0],[1,0],[0,1]].map(([x,y]) => grid.get(`${candidate.columnIndex+x},${candidate.rowIndex+y}`)).filter(Boolean)]));
    }
    // The array may keep its identity when individual room snapshots change.
    this.seamRooms ||= new Map();
    if (this.seamWorld !== this.world) {
      this.seamWorld = this.world;
      this.seamRooms = new Map(this.world.contextRooms.map(candidate => [candidate.fileName, candidate]));
    }
    return (this.seamIndex.get(room.fileName) || []).map(id => this.seamRooms.get(id)?.objects);
  }

  prepareBackgroundCaps(entry) {
    const caps = entry.activeCaps, height = this.backgroundTruncation.height;
    if (caps && !caps.userData.joinedRoomBorders) {
      const borders = roomBorderEdges(this.world, entry.room, { maxHeight: height }).map(border => {
        const positions = [];
        for (let i = 0; i < border.positions.length; i += 6) {
          const points = border.positions.slice(i, i + 6);
          if (Math.abs(points[1] - height) < 1e-5 && Math.abs(points[4] - height) < 1e-5) {
            points[1] = points[4] = height - .001;
            positions.push(...points);
          }
        }
        return { ...border, positions };
      });
      joinRoomBorderEdges([...caps.children], borders, caps);
      caps.userData.joinedRoomBorders = true;
    }
    this.assignRenderLayers(entry.capRoot);
  }

  updateBackgroundFrustum() {
    if (!this.camera) return;
    this.backgroundFrustum ||= new THREE.Frustum();
    this.backgroundProjection ||= new THREE.Matrix4();
    this.camera.updateMatrixWorld();
    this.backgroundFrustum.setFromProjectionMatrix(this.backgroundProjection.multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse));
  }

  backgroundRoomVisible(entry) {
    return !this.backgroundFrustum || this.backgroundFrustum.intersectsBox(entry.bounds);
  }

  queueBackgroundCaps() {
    if (this.backgroundCapJob) return;
    const pending = [...this.roomBackgrounds.values()].filter(entry => entry.preparedCapHeight !== this.backgroundTruncation.height);
    if (!pending.length) return;
    const schedule = callback => globalThis.requestIdleCallback
      ? requestIdleCallback(callback, { timeout: 100 }) : setTimeout(callback, 0);
    const job = this.backgroundCapJob = {};
    const step = () => {
      if (this.backgroundCapJob !== job) return;
      const start = performance.now();
      while (pending.length && performance.now() - start < 6) {
        const entry = pending.shift();
        if (this.roomBackgrounds.get(entry.room.fileName) !== entry ||
            entry.preparedCapHeight === this.backgroundTruncation.height) continue;
        this.backgroundTruncation.prepareCaps(entry);
        this.prepareBackgroundCaps(entry);
      }
      if (pending.length) schedule(step);
      else { this.backgroundCapJob = null; this.queueBackgroundCaps(); }
    };
    schedule(step);
  }

  buildBackground(room) {
    const previous = {
      world: this.world, content: this.content, cutawayContent: this.cutawayContent,
      sceneCutawayHeight: this.sceneCutawayHeight, pickVoxels: this.pickVoxels,
      pickMeshes: this.pickMeshes, cellTops: this.cellTops, modelCaps: this.modelCaps
    };
    const dataset = { ...this.canvas.dataset };
    const shadowUpdate = this.renderer.shadowMap.needsUpdate;
    const old = this.roomBackgrounds.get(room.fileName);
    if (old) this.backgroundTruncation.disposeEntry(old);
    const entry = { room, seamSources: this.seamSources(room), root: new THREE.Group(), content: new THREE.Group(), cutawayContent: new THREE.Group() };
    // Include the small authored models overhanging room boundaries.
    const x = room.columnIndex * this.world.roomWidth - this.totalWidth / 2;
    const z = room.rowIndex * this.world.roomHeight - this.totalHeight / 2;
    entry.bounds = new THREE.Box3(new THREE.Vector3(x - 4, -4, z - 4),
      new THREE.Vector3(x + this.world.roomWidth + 4, this.backgroundMaxHeight + 4, z + this.world.roomHeight + 4));
    entry.root.add(entry.content, entry.cutawayContent);
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      this.world = { ...previous.world, rooms: [{ ...room, renderDimmed: false }] };
      this.buildingBackground = true;
      this.content = entry.content;
      this.cutawayContent = entry.cutawayContent;
      this.sceneCutawayHeight = null;
      this.pickVoxels = false;
      entry.modelUrls = super.rebuild();
      entry.root.traverse(object => {
        object.layers.set(0);
        object.castShadow = false;
        object.receiveShadow = false;
      });
      this.backgroundTruncation.prepare(entry, this.world, { totalWidth: this.totalWidth, totalHeight: this.totalHeight }, this);
      const visible = this.backgroundRoomVisible(entry);
      this.backgroundTruncation.update(entry, { prepareCaps: visible });
      if (visible) this.prepareBackgroundCaps(entry);
      entry.root.updateMatrixWorld(true);
      entry.root.traverse(object => { object.matrixAutoUpdate = Boolean(object.userData.liftMarker); });
      entry.root.visible = room.fileName !== previous.world.contextActiveRoom.fileName;
      this.roomBackgrounds.set(room.fileName, entry);
      this.backgroundRoot.add(entry.root);
      entry.markers = [];
      entry.root.traverse(object => { if (object.userData.liftMarker) entry.markers.push(object); });
      this.backgroundMarkers = [...this.roomBackgrounds.values()].flatMap(entry => entry.markers || []);
      this.queueBackgroundCaps();
    } finally {
      this.buildingBackground = false;
      Object.assign(this, previous);
      Object.assign(this.canvas.dataset, dataset);
      this.renderer.shadowMap.needsUpdate = shadowUpdate;
      this.renderSuspended--;
    }
    return entry;
  }

  queueBackgrounds() {
    const active = this.world.contextActiveRoom;
    const distance = room => Math.max(Math.abs(room.columnIndex - active.columnIndex), Math.abs(room.rowIndex - active.rowIndex));
    const rooms = this.world.contextRooms.filter(room => !this.roomBackgrounds.has(room.fileName))
      .sort((a, b) => distance(a) - distance(b));
    if (this.backgroundJob) {
      this.backgroundJob.rooms = rooms;
      return;
    }
    if (!rooms.length) return;
    const job = { rooms };
    this.backgroundReady = new Promise(resolve => { job.resolve = resolve; });
    this.backgroundJob = job;
    const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
    const step = () => {
      if (this.backgroundJob !== job) return;
      const start = performance.now(), urls = new Set();
      let addedVisibleRoom = false;
      do {
        const room = job.rooms.shift();
        if (room) {
          const entry = this.buildBackground(room);
          entry.modelUrls.forEach(url => urls.add(url));
          addedVisibleRoom ||= this.backgroundRoomVisible(entry);
        }
      } while (job.rooms.length && performance.now() - start < 6);
      this.canvas.dataset.cachedRoomCount = String(this.roomBackgrounds.size);
      this.requestModels(urls);
      // Progress still advances for every batch. Offscreen room uploads do not
      // change the displayed image; draw them when the camera first sees them.
      if (addedVisibleRoom || !job.rooms.length) this.render();
      if (job.rooms.length) schedule(step);
      else {
        this.backgroundJob = null;
        job.resolve(true);
      }
    };
    schedule(step);
  }

  requestModels(urls) {
    this.requestedModels ||= new Set();
    const pending = [...urls].filter(url => !this.requestedModels.has(url));
    if (!pending.length) return;
    pending.forEach(url => this.requestedModels.add(url));
    prepareBrowserModels(pending).then(changed => {
      if (!changed) return;
      // Normally preloaded before startup. New authored model URLs can still
      // replace their fallbacks without blocking on a synchronous world build.
      this.clearBackground();
      this.rebuild();
    });
  }

  configureShadows() {
    if (!this.keyLight?.castShadow) return;
    const center = playRoomCenter(this.world);
    this.keyLight.position.set(center.x + 5, 18, center.z - 5);
    this.keyLight.target.position.set(center.x, 0, center.z);
    const span = Math.max(this.world.roomWidth, this.world.roomHeight) * 1.5;
    const camera = this.keyLight.shadow.camera;
    Object.assign(camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 3 });
    camera.updateProjectionMatrix();
  }

  updateCamera() {
    this.roomLighting?.update();
    super.updateCamera();
    this.updateBackgroundFrustum();
    for (const entry of this.roomBackgrounds?.values() || []) {
      const visible = this.backgroundRoomVisible(entry);
      entry.root.visible = visible && entry.room.fileName !== this.world.contextActiveRoom.fileName;
      if (entry.preparedCapHeight !== this.backgroundTruncation.height && visible) {
        this.backgroundTruncation.prepareCaps(entry);
        this.prepareBackgroundCaps(entry);
      }
    }
    for (const marker of this.backgroundMarkers || []) marker.rotation.y = this.yaw;
  }

  addJoinedCubes(data, content, minHeight = -Infinity) {
    const first = content.children.length;
    super.addJoinedCubes(data, content, minHeight);
    const room = this.world.rooms.length === 1 && this.world.rooms[0];
    // A command's temporary scene already joins every participating room.
    if (!room || this.buildingAnimation) return;
    const maxHeight = Number.isFinite(minHeight) ? undefined : this.cutawayHeight ?? undefined;
    joinRoomBorderEdges(content.children.slice(first), roomBorderEdges(this.world, room, {
      maxHeight, minHeight, excludePlayer: Boolean(this.joiningPlayerSeparately)
    }), content);
  }

  addEditorGrid(cells) {
    if (!this.buildingBackground) super.addEditorGrid(cells);
  }

  assignRenderLayers(root) {
    super.assignRenderLayers(root);
    this.roomLighting?.apply(root);
  }

  render() {
    if (!this.renderSuspended) super.render();
  }

  zoomLimits() { return [7, 1000]; }

  centerBoard() {
    super.centerBoard();
    const center = playRoomCenter(this.world);
    this.cameraMotion.centerAnimation.targetX = center.x;
    this.cameraMotion.centerAnimation.targetZ = center.z;
  }

  resetView() {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      super.resetView();
      const center = playRoomCenter(this.world);
      this.target.x = center.x;
      this.target.z = center.z;
    } finally { this.renderSuspended--; }
    this.render();
  }
}
