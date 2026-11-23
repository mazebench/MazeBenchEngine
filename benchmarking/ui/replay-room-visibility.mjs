import { Plane, Vector3 } from '../../render/vendor/three.module.min.js';
import { sampleTimelinePlayer } from '../../animations/v1/timeline.mjs';

// A crossing scene can contain several rooms in one joined mesh. Hiding the
// background alone would still reveal those neighbours during the transition.
export class ReplayRoomVisibility {
  constructor(renderer) {
    this.renderer = renderer;
    this.originalPlanes = renderer.renderer.clippingPlanes;
    this.planes = [new Plane(new Vector3(1, 0, 0)), new Plane(new Vector3(-1, 0, 0)),
      new Plane(new Vector3(0, 0, 1)), new Plane(new Vector3(0, 0, -1))];
    this.clippingPlanes = [...this.originalPlanes, ...this.planes];
  }

  update(showNeighbors, scene, { clip, local }) {
    const renderer = this.renderer;
    renderer.backgroundRoot.visible = showNeighbors;
    renderer.canvas.dataset.replayNeighbors = String(showNeighbors);
    const fallback = local >= clip.settledAt ? clip.to : clip.room;
    const player = sampleTimelinePlayer(scene.timeline, local);
    const rooms = scene.timeline.rooms;
    const room = (player?.opacity > 0 && rooms.find(room =>
      room.columnIndex === Math.floor((player.x + .5) / renderer.world.roomWidth) &&
      room.rowIndex === Math.floor((player.y + .5) / renderer.world.roomHeight))) ||
      rooms.find(room => room.fileName === fallback) || rooms[0];
    renderer.canvas.dataset.replayVisibleRoom = room.fileName;
    if (showNeighbors || rooms.length < 2) {
      renderer.renderer.clippingPlanes = this.originalPlanes;
      return;
    }
    const width = renderer.world.roomWidth, height = renderer.world.roomHeight;
    const x = (room.columnIndex - renderer.world.columns.length / 2) * width;
    const z = (room.rowIndex - renderer.world.rows.length / 2) * height;
    this.planes[0].constant = -x;
    this.planes[1].constant = x + width;
    this.planes[2].constant = -z;
    this.planes[3].constant = z + height;
    renderer.renderer.clippingPlanes = this.clippingPlanes;
  }
}
