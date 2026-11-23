// Engine snapshots are immutable, but readback gives their objects new identities.
// Compare an object's small record before serializing anything; almost every
// stationary track is identical to the previous command's version.
function equal(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && equal(a[key], b[key]));
}

export class TimelinePool {
  templates = []; layouts = [];
  byIdentity = new Map(); layoutKeys = new Map(); sceneKeys = new Map(); motionKeys = new Map();

  stationary(track) {
    let entry = this.byIdentity.get(track.key);
    const matches = id => {
      const prior = this.templates[id];
      return prior.block === track.block.id && prior.initialOpacity === track.initialOpacity &&
        prior.initialPhase === track.initialPhase &&
        prior.positions[0].every((value, axis) => value === track.positions[0][axis]) && equal(prior.object, track.object);
    };
    if (entry && matches(entry.last)) return entry.last;
    // Serialize only a changed version. A map avoids scanning an object's
    // entire positional history when it settles somewhere new or resets.
    if (!entry) this.byIdentity.set(track.key, entry = { versions: new Map() });
    const key = JSON.stringify([track.block.id, track.object, track.positions[0], track.initialOpacity, track.initialPhase]);
    let id = entry.versions.get(key);
    if (id === undefined) {
      id = this.templates.length;
      this.templates.push({ ...track, block: track.block.id, positions: [track.positions[0]] });
      entry.versions.set(key, id);
    }
    entry.last = id;
    return id;
  }

  pack(timeline) {
    const stationary = [], moving = [];
    for (const track of timeline.tracks) {
      // A blocked command still has a player actor. Keeping it out of the
      // stationary layout lets playback reuse the preceding walking scene.
      if (track.changed || track.block.roleId === "player") {
        moving.push({ ...track, block: track.block.id, changed: true });
      } else stationary.push(this.stationary(track));
    }
    const layoutKey = stationary.join(",");
    let layout = this.layoutKeys.get(layoutKey);
    if (layout === undefined) {
      layout = this.layouts.length;
      this.layouts.push(new Uint32Array(stationary));
      this.layoutKeys.set(layoutKey, layout);
    }
    const rooms = timeline.rooms.map(room => room.fileName);
    // Repeated routes share their curves as well as their scenery. These keys
    // exist only during compilation; the movie keeps compact numeric scene IDs.
    const motionKey = JSON.stringify(moving);
    if (!this.motionKeys.has(motionKey)) this.motionKeys.set(motionKey, moving);
    const player = timeline.tracks.find(track => track.block.roleId === "player");
    const playerOnly = moving.length === 1 && player && moving[0].key === player.key &&
      !player.fades.length && !player.phases.length && player.positions.every(p => p[2] === player.positions[0][2]);
    let geometry = moving;
    if (playerOnly) {
      const { x, y, ...object } = player.object;
      geometry = ["player", player.key, player.block.id, object, player.positions[0][2], player.initialOpacity, player.initialPhase];
    }
    const sceneKey = JSON.stringify([layout, rooms, geometry]);
    let scene = this.sceneKeys.get(sceneKey);
    if (scene === undefined) { scene = this.sceneKeys.size; this.sceneKeys.set(sceneKey, scene); }
    return { layout, moving: this.motionKeys.get(motionKey), scene, playerOnly: Boolean(playerOnly), rooms,
      camera: timeline.camera, lighting: timeline.lighting, initialLight: timeline.initialLight };
  }
}
