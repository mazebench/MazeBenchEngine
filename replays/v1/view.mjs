import { PlayWorldRenderer } from "../../ui/play-world-renderer.mjs";
import { WorldContextRenderer } from "../../ui/world-context-renderer.mjs";
import { FlyoverRenderer } from "../../ui/flyover-renderer.mjs";
import { installFlyoverControls } from "../../ui/flyover-controls.mjs";
import { createPlayWorldContext } from "../../ui/play-world-context.mjs";
import { CommandAnimationScene } from "../../animations/v1/scene.mjs";
import { easeInOut, sampleSegments } from "../../animations/v1/timeline.mjs";
import { locateReplay, replayCamera, unpackTimeline } from "./movie.mjs";
import { ReplaySceneCache } from "./scene-cache.mjs";
import { ReplayGemState } from "./gem-state.mjs";

export class ReplayRenderer extends PlayWorldRenderer {
  installEvents() { this.disposeFlyoverControls = installFlyoverControls(this); }
  setFreeYaw(yaw) { FlyoverRenderer.prototype.setFreeYaw.call(this, yaw); }
  recomputeContinuousDirections() { FlyoverRenderer.prototype.recomputeContinuousDirections.call(this); }
  runCameraFrame(now) { FlyoverRenderer.prototype.runCameraFrame.call(this, now); }
  cancelCameraMotion() { FlyoverRenderer.prototype.cancelCameraMotion.call(this); }
  // A paused movie owns its animation clock, including idle gems. Camera input
  // may redraw it, but must never advance the timeline or start an idle loop.
  render() { WorldContextRenderer.prototype.render.call(this); }
  centerBoard() { if (this.onReplayCenter) this.onReplayCenter(); else super.centerBoard(); }
  // The sampled command scene owns all foreground geometry. Room changes only
  // need the context, lighting and background cache, never a second hidden room.
  rebuildForeground() {
    this.canvas.dataset.cutawayHeight = this.cutawayHeight === null ? "full" : String(this.cutawayHeight);
    this.canvas.dataset.cutawayOpacity = String(this.cutaway.opacity);
    this.canvas.dataset.cutawayFollowPlayer = String(this.cutaway.followPlayer);
    return new Set();
  }
}

export class ReplayView {
  constructor(canvas, world, movie) {
    this.source = world;
    this.world = { ...world, rooms: world.rooms.map(room => ({ ...room })) };
    this.rooms = new Map(this.world.rooms.map(room => [room.fileName, room]));
    this.context = createPlayWorldContext(this.world);
    this.renderer = new ReplayRenderer(canvas, this.context(this.rooms.get(movie.startRoom)), { mode: "play" });
    this.renderer.gemMotionEnabled = true;
    this.renderer.onReplayCenter = () => this.center();
    this.setMovie(movie);
  }

  setMovie(movie) {
    this.scene?.dispose();
    this.sceneCache?.clear();
    this.sceneCache = new ReplaySceneCache();
    this.gemsReset = this.gemState?.reset() || false;
    this.gemState = new ReplayGemState(this.source, this.world, movie.gems);
    this.renderer.commandAnimation = null;
    this.scene = null;
    this.movie = movie;
    this.index = -1;
    this.lastCamera = null;
    this.renderer.cancelCameraMotion();
    this.show(0);
  }

  updateGems(time) {
    const changed = this.gemState.update(time) || this.gemsReset;
    this.gemsReset = false;
    return changed;
  }

  show(time) {
    const location = locateReplay(this.movie, time), { clip, local, index } = location, renderer = this.renderer;
    const pan = this.lastCamera ? [renderer.target.x - this.lastCamera[0], renderer.target.z - this.lastCamera[1]] : [0, 0];
    renderer.renderSuspended = (renderer.renderSuspended || 0) + 1;
    try {
      const changedGems = this.updateGems(location.time);
      const sceneKey = clip.scene ?? index;
      let cached = null;
      const previous = this.movie.clips[this.index];
      const reused = index !== this.index && !changedGems && previous?.layout === clip.layout && previous?.room === clip.room &&
        (clip.scene === undefined || (clip.playerOnly && previous.scene === clip.scene)) &&
        this.scene?.retargetPlayer(unpackTimeline(this.movie, clip, this.world));
      if (index !== this.index && !reused) {
        // Take the requested entry before parking the current one, otherwise
        // a full cache could evict the very scene we're about to show.
        cached = this.sceneCache.take(sceneKey);
        if (this.scene) this.sceneCache.park(this.sceneKey, this.scene);
        renderer.commandAnimation = null;
        this.scene = null;
      }
      if (changedGems || renderer.world.contextActiveRoom.fileName !== clip.room) {
        renderer.setWorld(this.context(this.rooms.get(clip.room)), { preserveCamera: true, preserveCameraPosition: true });
      }
      if (!this.scene) {
        // Older in-memory movie objects without interned scene IDs still work.
        this.scene = cached || this.sceneCache.take(sceneKey);
        if (this.scene && clip.playerOnly && !this.scene.retargetPlayer(unpackTimeline(this.movie, clip, this.world))) {
          this.scene.dispose();
          this.scene = null;
        }
        if (this.scene) this.scene.attach();
        else this.scene = new CommandAnimationScene(renderer, unpackTimeline(this.movie, clip, this.world));
        renderer.commandAnimation = this.scene;
      }
      this.sceneKey = sceneKey;
      this.scene.timeline.duration = clip.duration;
      this.scene.update(local);
      this.lastCamera = replayCamera(clip, local);
      renderer.target.x = this.lastCamera[0] + pan[0];
      renderer.target.z = this.lastCamera[1] + pan[1];
      if (clip.type === "room") {
        const t = easeInOut(local / clip.duration);
        if (clip.from === clip.to) renderer.roomLighting.setWeights([this.rooms.get(clip.to)], [1]);
        else renderer.roomLighting.setWeights([this.rooms.get(clip.from), this.rooms.get(clip.to)], [1 - t, t]);
      } else renderer.roomLighting.setWeights(clip.rooms.map(id => this.rooms.get(id)),
        sampleSegments(clip.lighting, clip.initialLight, local, { alwaysEase: true }));
      renderer.presentationTime = location.time;
      this.index = index;
      renderer.canvas.dataset.replayAction = String(index + 1);
      renderer.canvas.dataset.replayTime = location.time.toFixed(2);
    } finally { renderer.renderSuspended--; }
    renderer.render();
    return location;
  }

  center() {
    if (!this.lastCamera) return;
    this.renderer.cancelCameraMotion();
    this.renderer.target.x = this.lastCamera[0];
    this.renderer.target.z = this.lastCamera[1];
    this.renderer.render();
  }
}
