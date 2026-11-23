// Independent expected geometry for the audit regressions. These constructors
// never call the engine or accept its output as the expected answer.
const boxId = "weightless-pushbox-1826";
const floor = (width, height, ice = new Set()) => Array.from({ length: width * height }, (_, i) => ({ x: i % width, y: Math.floor(i / width), z: 0, blockId: ice.has(i) ? "ice-9679" : "floor" }));
const box = (x, y, z, genericId = 0) => ({ x, y, z, blockId: boxId, genericId });
const player = (x, y, z = 1) => ({ x, y, z, blockId: "player" });
const frame = voxels => ({ voxels });
function fixture(id, name, description, frames, group = "support") {
  return { id: `audit-${id}`, name, description, folderId: "engine-regressions", tagIds: [`engine-regressions-${group}`], locked: false, hidden: false, input: "up", world: { width: 6, height: 6, floorLayer: 0 }, start: frame(frames[0]), intermediate: frames.slice(1, -1).map(frame), expected: frame(frames.at(-1)) };
}

export function auditRegressions() {
  const cases = [];
  for (const [width, height] of [[1, 1], [1, 4], [2, 1], [2, 4], [4, 1], [4, 7]]) {
    for (const blocked of [false, true]) {
      const terrain = [...floor(6, 6),
        { x: 0, y: 3, z: 1, blockId: "ice-slope", orientation: "up" },
        { x: 0, y: 2, z: 1, blockId: "ice-9679" },
        { x: 0, y: 2, z: 2, blockId: "ice-slope", orientation: "up" }];
      if (blocked) terrain.push({ x: width - 1, y: 3, z: height + 1, blockId: "wall" });
      const make = (y, z, playerY) => [...terrain, player(0, playerY), ...Array.from({ length: width * height }, (_, i) => box(i % width, y, z + Math.floor(i / width), 17))];
      const frames = blocked ? [make(4, 1, 5), make(4, 1, 5)]
        : [make(4, 1, 5), make(3, 2, 4), make(2, 3, 4), make(1, 3, 4), make(1, 2, 4), make(1, 1, 4)];
      cases.push(fixture(`slope-${width}x${height}${blocked ? "-blocked" : ""}`,
        `${width}×${height} box: ${blocked ? "remote ceiling blocks the entire ramp ascent" : "one ramp contact lifts every cell"}`,
        blocked ? "A wall over the far edge intersects the ascending box's destination. The transaction must refuse the complete push: no box cell and no player cell may move."
          : "Only the leftmost foot touches the ramp. The whole box rises for two ticks, advances once past the crest, and falls twice onto Floor. Flat support under the remaining feet cannot veto ascent; all cells preserve their relative offsets. The player moves north once.", frames, "slopes"));
    }
  }
  for (const width of [1, 2, 4]) {
    for (const slippery of [false, true]) {
      const terrain = floor(6, 6, slippery ? new Set(Array.from({ length: width }, (_, i) => 3 * 6 + i + 1)) : new Set());
      const pedestal = Array.from({ length: width }, (_, i) => box(i + 1, 3, 1, 81));
      const bridge = y => Array.from({ length: width + 1 }, (_, x) => box(x, y, 2, 5));
      cases.push(fixture(`pedestal-${width}${slippery ? "-ice" : "-floor"}`,
        `${width}-cell pedestal on ${slippery ? "Ice: the player carries the bridge" : "Floor: the bridge stays put"}`,
        slippery ? "The bridge shares support between the player and an independently stationary box whose whole base is on Ice. That pedestal has no non-Ice foothold, so the player's move carries the bridge north while the pedestal stays put."
          : "The bridge rests on both the player's head and a separate grounded pedestal. The player walks north; the bridge and pedestal retain every coordinate. Changing pedestal size or numbered ID must not change this rule.",
        [[...terrain, player(0, 3), ...pedestal, ...bridge(3)], [...terrain, player(0, 2), ...pedestal, ...bridge(slippery ? 2 : 3)]]));
    }
  }
  return cases;
}
