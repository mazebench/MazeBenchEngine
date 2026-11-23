import { decodeVoxelRoom } from "../../render/v1/voxel-world-v2.mjs";

// One stop per collecting move: a single move can collect multiple gems.
// The chart's final plateau is an endpoint, not another collection.
export function gemReplayFrames(value, maximum = Infinity) {
  const frames = [{ move: 0, gems: 0 }];
  if (!value?.available) return frames;
  let collected = 0;
  for (const point of value.points || []) {
    if (!Number.isSafeInteger(point.move) || point.move < 0 || point.move > maximum
      || !Number.isSafeInteger(point.gems) || point.gems <= collected
      || point.move < frames.at(-1).move) continue;
    const frame = { move: point.move, gems: point.gems };
    if (point.move === frames.at(-1).move) frames[frames.length - 1] = frame;
    else frames.push(frame);
    collected = point.gems;
  }
  return frames;
}

export function gemFrameIndex(frames, move) {
  let low = 0, high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].move <= move) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

// The existing read-only history API records collection counts and player paths.
// Resolve only unambiguous locations; do not guess a nearest gem or treat a
// visit as collection. Edited maps cannot be matched to historic identities.
export function gemCollectionLocations(locations, run) {
  const gems = locations.map(gem => ({ ...gem, status: "remaining" }));
  let unresolved = 0;
  for (const action of run.actions || []) {
    const count = action.gemsCollected || 0;
    if (count <= 0) continue;
    const path = [action.player, ...(action.traversedPositions || [])].filter(Boolean);
    const candidates = gems.filter(gem => gem.status !== "collected" && path.some(point =>
      point.worldX === gem.worldX && point.worldY === gem.worldY &&
      (point.z === undefined || point.z === gem.z)));
    const roomGems = action.roomBefore === action.roomAfter
      ? gems.filter(gem => gem.status !== "collected" && gem.room === action.roomAfter) : [];
    const matched = candidates.length === count ? candidates : roomGems.length === count ? roomGems : [];
    if (matched.length) for (const gem of matched) gem.status = "collected";
    else {
      unresolved += count;
    }
  }
  const mapped = gems.filter(gem => gem.status === "collected").length;
  const incomplete = mapped + unresolved !== (run.gems_collected || 0);
  for (const gem of gems) {
    if (run.world_revision > 0 || incomplete || (gem.status !== "collected" && unresolved > 0)) gem.status = "unknown";
  }
  return gems;
}

export function roomGemLocations(payload, coordinates, blocks) {
  const room = decodeVoxelRoom(payload);
  const [column, row] = coordinates;
  if (!/^[A-P]$/.test(column) || !/^[A-P]$/.test(row)) throw new Error("Invalid world room coordinates.");
  const goals = new Set(blocks.filter(block => block.roleId === "goal").map(block => block.id));
  return room.objects.filter(object => goals.has(object.blockId)).map(object => ({
    worldX: (column.charCodeAt(0) - 65) * room.width + object.x,
    worldY: (row.charCodeAt(0) - 65) * room.height + object.y,
    room: `${column}x${row}`, z: object.z
  }));
}

export async function loadWorldGemLocations(fetchJson) {
  const root = "/level-data/v2/main-world/";
  const manifest = await fetchJson(`${root}world.json`);
  const rooms = Object.entries(manifest.rooms), locations = [];
  let next = 0;
  // Read static map assets only, with bounded concurrency; never open a runner.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < rooms.length) {
      const [file, coordinates] = rooms[next++];
      const payload = await fetchJson(root + encodeURIComponent(file));
      locations.push(...roomGemLocations(payload, coordinates, manifest.blocks));
    }
  }));
  return locations;
}
