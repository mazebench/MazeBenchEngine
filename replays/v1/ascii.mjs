import { unpackTimeline } from "./movie.mjs";
import { sampleTrack } from "../../animations/v1/timeline.mjs";
import { AsciiMazeRendererV2 } from "../../render-ascii/v2/ascii-renderer.mjs";
import { glyphCatalogForRoom } from "../../render-ascii/v2/ascii-scene.mjs";

export function replayAsciiFrame(clip, local) {
  return clip.asciiFrames.findLast(frame => frame.at <= local) || clip.asciiFrames[0];
}

// Sample only exact physics ticks, never rounded positions halfway through a
// 3D tween. The compact movie already owns all positions and mechanism states.
export function replayAsciiRoom(movie, world, clip, frame) {
  const room = world.rooms.find(room => room.fileName === frame.room);
  const timeline = unpackTimeline(movie, clip, world);
  const objects = timeline.tracks.flatMap(track => {
    const pose = sampleTrack(track, frame.at);
    const x = Math.round(pose.x - room.columnIndex * world.roomWidth);
    const y = Math.round(pose.y - room.rowIndex * world.roomHeight);
    if (pose.opacity < .999 || x < 0 || y < 0 || x >= room.width || y >= room.height) return [];
    return [{ ...track.object, x, y, z: Math.round(pose.z), engineHidden: false,
      ...(["gate", "lift", "puncher"].includes(track.block.visual?.kind) ? { stateId: Math.round(pose.phase) } : {}) }];
  });
  return { ...room, objects };
}

export class ReplayAsciiView {
  constructor(board, world) {
    this.board = board;
    this.world = world;
    this.catalogs = new Map(world.rooms.map(room => [room.fileName, glyphCatalogForRoom(room)]));
    this.renderer = new AsciiMazeRendererV2(board, null, world.blocks);
    this.zoom = 1;
  }

  async show(movie, location) {
    const frame = replayAsciiFrame(location.clip, location.local);
    const key = `${location.index}:${frame.at}:${this.renderer.yaw}:${this.renderer.pitch}`;
    if (this.movie === movie && this.key === key) return;
    this.movie = movie;
    this.key = key;
    const room = replayAsciiRoom(movie, this.world, location.clip, frame);
    // Keep IDs stable when a body disappears or a collected gem is removed.
    this.renderer.room = room;
    this.renderer.catalog = this.catalogs.get(frame.room);
    await this.renderer.render();
    if (this.key !== key || this.movie !== movie) return;
    this.board.dataset.replayAction = String(location.index + 1);
    this.board.dataset.replayRoom = frame.room;
  }

  zoomBy(factor) {
    this.zoom = Math.max(.5, Math.min(3, this.zoom * factor));
    this.board.style.setProperty("--ascii-zoom", this.zoom);
  }
}
