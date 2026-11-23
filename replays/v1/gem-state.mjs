// Walk only events crossed by a seek, then refresh the affected room arrays.
// Most frames do no work; collecting one gem never scans the full world.
export class ReplayGemState {
  constructor(source, world, gems) {
    this.sources = new Map(source.rooms.map(room => [room.fileName, room]));
    this.rooms = new Map(world.rooms.map(room => [room.fileName, room]));
    this.gems = gems;
    this.cursor = 0;
    this.removed = new Map();
  }

  update(time) {
    let low = 0, high = this.gems.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.gems[mid].at <= time) low = mid + 1;
      else high = mid;
    }
    const affected = new Set(), adding = low > this.cursor;
    for (let i = Math.min(low, this.cursor); i < Math.max(low, this.cursor); i++) {
      const gem = this.gems[i], split = gem.id.lastIndexOf(":"), room = gem.id.slice(0, split);
      let removed = this.removed.get(room);
      if (!removed) this.removed.set(room, removed = new Set());
      if (adding) removed.add(Number(gem.id.slice(split + 1)));
      else removed.delete(Number(gem.id.slice(split + 1)));
      affected.add(room);
    }
    this.cursor = low;
    for (const id of affected) {
      const removed = this.removed.get(id), source = this.sources.get(id);
      this.rooms.get(id).objects = removed.size ? source.objects.filter((_, index) => !removed.has(index)) : source.objects;
    }
    return affected.size > 0;
  }

  reset() { return this.update(-Infinity); }
}
