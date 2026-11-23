import { WorldContextRenderer } from "./world-context-renderer.mjs";
import { createCommandTimeline, createResetTimeline, captureTimeline, ROOM_TRANSITION_MS, sampleSegments } from "../animations/v1/timeline.mjs";
import { playTimeline } from "../animations/v1/player.mjs";
import { CAMERA_CENTER_DURATION_MS } from "../render/v1/camera-transitions.mjs";
import { CommandAnimationScene } from "../animations/v1/scene.mjs";
import { addAnimatedGem, collectAnimatedGems, updateAnimatedGems } from "../animations/v1/gems.mjs";
import * as THREE from "../render/vendor/three.module.min.js";
import { JoinedMazeRenderer } from "./joined-maze-renderer.mjs";
import { collectVoxelSceneV2 } from "./voxel-scene.mjs";
import { PlayerMotionScene } from "../animations/v1/player-scene.mjs";

function playerSceneState(world) {
  const room = world.rooms.find(room => !room.renderDimmed);
  if (!room) return null;
  const players = room.objects.filter(object => world.blockDefinitions.get(object.blockId)?.roleId === "player");
  if (players.length !== 1 || players[0].engineHidden || players[0].x < 0 || players[0].y < 0 ||
      players[0].x >= world.roomWidth || players[0].y >= world.roomHeight) return null;
  return { room, player: players[0], signature: JSON.stringify([room.fileName,
    room.objects.filter(object => object !== players[0])]) };
}

export class PlayWorldRenderer extends WorldContextRenderer {
  constructor(canvas, world, options) {
    super(canvas, world, options);
    this.gemMotionPreference = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    this.gemMotionPreference?.addEventListener("change", () => this.render());
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.render();
    });
  }

  addGemAsset(content, record, dimensions) {
    addAnimatedGem(content, record, dimensions);
  }

  buildBackground(room) {
    const entry = super.buildBackground(room);
    entry.gems = collectAnimatedGems(entry.content);
    return entry;
  }

  rebuild() {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    let urls;
    try {
      this.playPlayerRoot = null;
      urls = super.rebuild();
      this.gems = collectAnimatedGems(this.content, this.cutawayContent);
      this.playerScene = playerSceneState(this.world);
      if (this.playerScene) {
        this.playerScene.height = this.cutawayHeight;
        this.playerScene.context = this.world.contextRooms.slice();
      }
    } finally { this.renderSuspended--; }
    this.render();
    return urls;
  }

  addJoinedCubes(data, content, minHeight = -Infinity) {
    if (this.buildingBackground || this.buildingAnimation || content !== this.content || this.pickVoxels) {
      return super.addJoinedCubes(data, content, minHeight);
    }
    const players = new Map(), terrain = new Map(data.cubeGroups), occupied = new Set(data.occupied), playerCells = new Set();
    for (const [key, group] of terrain) {
      if (this.world.blockDefinitions.get(key.split(":")[2])?.roleId !== "player") continue;
      players.set(key, group); terrain.delete(key);
      for (const voxel of group.voxels) {
        const cell = `${voxel.x},${voxel.z},${voxel.y}`;
        occupied.delete(cell); playerCells.add(cell);
      }
    }
    // A player must not punch a temporary hole in an adjacent static face.
    this.joiningPlayerSeparately = true;
    try { super.addJoinedCubes({ ...data, cubeGroups: terrain, occupied }, content, minHeight); }
    finally { this.joiningPlayerSeparately = false; }
    if (!players.size) return;
    const root = new THREE.Group();
    JoinedMazeRenderer.prototype.addJoinedCubes.call(this,
      { ...data, cubeGroups: players, specialPieces: [], occupied: playerCells }, root, minHeight);
    content.add(root);
    this.playPlayerRoot = root;
  }

  setGemMotionEnabled(enabled) {
    this.gemMotionEnabled = enabled;
    this.render();
  }

  render() {
    if (this.renderSuspended) return;
    super.render();
    // Reuse the camera's display loop. Command tweens already draw each frame.
    if (this.gemMotionEnabled && !this.gemMotionPreference?.matches &&
        !globalThis.document?.hidden && !this.commandAnimation) this.scheduleCameraFrame();
  }

  setWorld(world, options = {}) {
    const previous = this.playerScene, next = previous && playerSceneState(world);
    const height = this.cutaway?.followPlayer && next ? Math.max(1, Math.round(next.player.z) + 1) : this.cutaway?.height;
    if (options.preserveCamera && this.playPlayerRoot && next && previous.signature === next.signature &&
        previous.height === height && previous.player.blockId === next.player.blockId &&
        this.world.blockDefinitions === world.blockDefinitions &&
        previous.context.length === world.contextRooms.length &&
        previous.context.every((room, index) => room === world.contextRooms[index])) {
      this.world = world;
      this.playPlayerRoot.position.set(next.player.x - previous.player.x, next.player.z - previous.player.z,
        next.player.y - previous.player.y);
      const collector = { world: { ...world, rooms: [next.room] } };
      collectVoxelSceneV2(collector);
      this.cellTops = collector.cellTops;
      this.render();
      return;
    }
    const changeRoom = options.animateCamera && options.preserveCamera && !options.preserveCameraPosition &&
      this.world?.contextActiveRoom.fileName !== world.contextActiveRoom.fileName &&
      !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!changeRoom || !this.target) return super.setWorld(world, options);
    const startX = this.target.x, startZ = this.target.z;
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try {
      super.setWorld(world, { ...options, preserveRoomLighting: true });
      this.roomLighting?.select(world.contextActiveRoom, ROOM_TRANSITION_MS);
      const pending = this.cameraMotion.centerAnimation;
      this.cameraMotion.centerAnimation = {
        startMs: performance.now(), roomStartMs: performance.now(), startX, startZ,
        targetX: pending?.targetX ?? this.target.x,
        targetZ: pending?.targetZ ?? this.target.z
      };
      this.target.x = startX;
      this.target.z = startZ;
    } finally { this.renderSuspended--; }
    this.scheduleCameraFrame();
    this.render();
  }

  runCameraFrame(now) {
    const animation = this.cameraMotion.centerAnimation;
    if (animation?.roomStartMs !== undefined) {
      // The signed base camera retains its historical duration. Adapt only
      // human room transitions to the shorter presentation clock.
      animation.startMs = now - (now - animation.roomStartMs) * CAMERA_CENTER_DURATION_MS / ROOM_TRANSITION_MS;
    }
    super.runCameraFrame(now);
  }

  finishRoomTransition() {
    const pending = this.cameraMotion.centerAnimation;
    if (pending?.roomStartMs !== undefined) {
      this.target.x = pending.targetX;
      this.target.z = pending.targetZ;
      this.cameraMotion.centerAnimation = null;
    }
    this.roomLighting?.select(this.world.contextActiveRoom);
    this.render();
  }

  capturePresentation() {
    const scene = this.commandAnimation;
    return scene ? captureTimeline(scene.timeline, scene.time) : undefined;
  }

  animateReset(reset, options) {
    return this.animateCommand(reset, { ...options, reset: true });
  }

  async animateCommand(command, { finish = () => false, reset = false } = {}) {
    if (command.signal?.aborted) return false;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return {};
    const timeline = (reset ? createResetTimeline : createCommandTimeline)({ ...command, definitions: this.world.blockDefinitions });
    if (!timeline.duration) return {};
    if (timeline.camera.length) {
      const pending = this.cameraMotion.centerAnimation;
      if (pending) {
        const remaining = [pending.targetX - this.target.x, pending.targetZ - this.target.z];
        timeline.camera.forEach((segment, index) => {
          segment.to = segment.to.map((value, axis) => value + remaining[axis]);
          segment.from = sampleSegments(timeline.camera.slice(0, index), [0, 0], segment.start, { alwaysEase: true });
        });
      }
      this.cameraMotion.centerAnimation = null;
    }
    const scene = PlayerMotionScene.supports(this, timeline)
      ? new PlayerMotionScene(this, timeline) : new CommandAnimationScene(this, timeline, { reuseBackgrounds: true });
    this.commandAnimation = scene;
    let disposed = false;
    const cleanup = restoreCamera => {
      if (disposed) return;
      disposed = true;
      scene.dispose({ restoreCamera });
      if (this.commandAnimation === scene) this.commandAnimation = null;
    };
    const abort = () => cleanup(true);
    command.signal?.addEventListener("abort", abort, { once: true });
    let complete = false;
    try {
      complete = await playTimeline(timeline, time => {
        scene.update(time);
        this.render();
      }, { signal: command.signal, finish });
      return complete ? { preserveCameraPosition: !command.simulation?.cycle } : false;
    } finally {
      command.signal?.removeEventListener("abort", abort);
      cleanup(!complete || Boolean(command.simulation?.cycle));
    }
  }

  updateCamera() {
    const now = this.presentationTime ?? performance.now();
    const enabled = Boolean(this.gemMotionEnabled && !this.gemMotionPreference?.matches);
    updateAnimatedGems(this.gems, now, enabled);
    for (const entry of this.roomBackgrounds?.values() || []) {
      // Ghosts are created lazily when upper-tile visibility first becomes nonzero.
      const ghost = entry.cutawayContent.children[0];
      if (entry.gemGhost !== ghost) {
        entry.gemGhost = ghost;
        entry.ghostGems = collectAnimatedGems(ghost);
      }
      updateAnimatedGems(entry.gems, now, enabled);
      updateAnimatedGems(entry.ghostGems, now, enabled);
    }
    updateAnimatedGems(this.commandAnimation?.gems, now, enabled);
    if (this.renderer.shadowMap.enabled && (this.gems?.length || this.commandAnimation?.gems.length)) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    super.updateCamera();
    this.commandAnimation?.beforeRender();
  }

  setGamepadCameraInput({ tilt = 0, zoom = 0 }) {
    if (this.gamepadTilt === tilt && this.gamepadZoom === zoom) return;
    this.gamepadTilt = tilt;
    this.gamepadZoom = zoom;
    if (zoom) this.cameraMotion.zoomAnimation = null;
    this.recomputeContinuousDirections();
  }

  recomputeContinuousDirections() {
    super.recomputeContinuousDirections();
    const motion = this.cameraMotion;
    // Combine independent input sources so releasing a trigger cannot release a key.
    motion.tiltDirection = Math.max(-1, Math.min(1, motion.tiltDirection + (this.gamepadTilt || 0)));
    motion.zoomDirection = Math.max(-1, Math.min(1, motion.zoomDirection + (this.gamepadZoom || 0)));
    if (motion.tiltDirection || motion.zoomDirection) this.scheduleCameraFrame();
  }

  cancelCameraMotion() {
    this.gamepadTilt = this.gamepadZoom = 0;
    super.cancelCameraMotion();
  }
}
