import { sampleTrack, sampleSegments } from "./timeline.mjs";

// Ordinary walking keeps the already-rendered room (and its exact cut faces).
// Only the separate player group moves; no meshes, materials or GPU uploads.
export class PlayerMotionScene {
  static supports(renderer, timeline) {
    const changed = timeline.tracks.filter(track => track.changed);
    return renderer.playPlayerRoot && timeline.rooms.every(room =>
      room.fileName === renderer.world.contextActiveRoom.fileName || renderer.roomBackgrounds?.has(room.fileName)) && changed.length === 1 &&
      changed[0].block.roleId === "player" && !changed[0].fades.length && !changed[0].phases.length &&
      changed[0].positions.every(position => position[2] === changed[0].positions[0][2]);
  }

  constructor(renderer, timeline) {
    this.renderer = renderer;
    this.timeline = timeline;
    this.track = timeline.tracks.find(track => track.changed);
    this.root = renderer.playPlayerRoot;
    this.original = this.root.position.clone();
    this.gems = [];
    this.offset = [0, 0];
    this.initialLighting = renderer.roomLighting && Array.from(renderer.roomLighting.values);
    this.lighting = [];
    if (this.initialLighting) for (const transition of timeline.lighting) {
      const to = this.initialLighting.map(() => 0);
      timeline.rooms.forEach((room, index) => { to[renderer.roomLighting.index(room)] = transition.to[index]; });
      this.lighting.push({ ...transition, to,
        from: sampleSegments(this.lighting, this.initialLighting, transition.start, { alwaysEase: true }) });
    }
    this.update(0);
  }

  update(time) {
    this.time = time;
    const renderer = this.renderer;
    // Truncate controls or an asynchronously loaded model can rebuild the
    // settled scene during a move. Continue on its replacement player group.
    if (this.root !== renderer.playPlayerRoot) {
      this.root = renderer.playPlayerRoot;
      this.original = this.root?.position.clone();
    }
    const pose = sampleTrack(this.track, time), origin = this.track.positions[0];
    this.root?.position.set(this.original.x + pose.x - origin[0], this.original.y + pose.z - origin[2],
      this.original.z + pose.y - origin[1]);
    const offset = sampleSegments(this.timeline.camera, [0, 0], time, { alwaysEase: true });
    renderer.target.x += offset[0] - this.offset[0];
    renderer.target.z += offset[1] - this.offset[1];
    this.offset = offset;
    if (this.lighting.length) {
      renderer.roomLighting.transition = null;
      renderer.roomLighting.values.set(sampleSegments(this.lighting, this.initialLighting, time, { alwaysEase: true }));
      renderer.roomLighting.upload();
    }
    if (renderer.renderer.shadowMap.enabled) renderer.renderer.shadowMap.needsUpdate = true;
    renderer.canvas.dataset.motionTime = time.toFixed(1);
    renderer.canvas.dataset.motionDuration = String(this.timeline.duration);
    renderer.canvas.dataset.motionPlayer = JSON.stringify(pose);
  }

  beforeRender() {
    if (this.root !== this.renderer.playPlayerRoot) this.update(this.time);
  }

  dispose({ restoreCamera = false } = {}) {
    if (restoreCamera && this.root) this.root.position.copy(this.original);
    if (restoreCamera) {
      this.renderer.target.x -= this.offset[0];
      this.renderer.target.z -= this.offset[1];
      if (this.initialLighting) {
        this.renderer.roomLighting.transition = null;
        this.renderer.roomLighting.values.set(this.initialLighting);
        this.renderer.roomLighting.upload();
      }
    }
    for (const key of ["motionTime", "motionDuration", "motionPlayer"]) delete this.renderer.canvas.dataset[key];
  }
}
