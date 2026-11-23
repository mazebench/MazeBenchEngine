import { voxelPieceDefinition } from "./voxel-scene.mjs";

import { mountedNumberFaces, numberFaceKey } from "./joined-voxel-surface.mjs";

export function attachedNumberFaces(world, ceiling = Infinity) {
  const fixtures = [];
  for (const room of world.rooms) {
    if (room.renderDimmed) continue;
    for (const object of room.objects) {
      if (object.engineHidden) continue;
      const block = world.blockDefinitions.get(object.blockId);
      const kind = block?.visual?.kind;
      if (!["lift", "button", "gate", "puncher"].includes(kind)) continue;
      const definition = voxelPieceDefinition(object, block);
      if (definition.bottom >= ceiling) continue;
      // Fixtures occupy the voxel outside the supporting block. Their
      // orientation names the outward face of that supporting block.
      let face = kind === "gate" ? "top" : object.orientation || "top";
      if (kind === "puncher") {
        face = { up: "north", right: "east", down: "south", left: "west" }[face] || face;
      }
      fixtures.push({
        x: room.columnIndex * world.roomWidth + object.x,
        y: room.rowIndex * world.roomHeight + object.y,
        z: object.z, face
      });
    }
  }
  return mountedNumberFaces(fixtures);
}

export function numberFaceCovered(covered, record, face) {
  return covered.has(numberFaceKey(record.x, record.z, record.object.z, face));
}

// Three.js uses Y for elevation and Z for the room's vertical screen axis.
export function numberFaceDirection(normal) {
  if (normal.y > 0.5) return "top";
  if (normal.y < -0.5) return "bottom";
  if (normal.x > 0.5) return "east";
  if (normal.x < -0.5) return "west";
  return normal.z > 0 ? "south" : "north";
}
