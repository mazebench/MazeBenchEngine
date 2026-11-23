export const ROOM_CONTEXT_RADIUS = 1;

export function roomObjectInContext(world, object) {
  if (!object || !world?.contextActiveRoom) return object;
  return {
    ...object,
    x: object.x + world.contextActiveRoom.columnIndex * world.roomWidth,
    y: object.y + world.contextActiveRoom.rowIndex * world.roomHeight
  };
}

function sameRoom(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.fileName && right.fileName) return left.fileName === right.fileName;
  return left.columnIndex === right.columnIndex && left.rowIndex === right.rowIndex;
}

export function roomContextWorld(world, activeRoom, renderedRoom = activeRoom, options = {}) {
  if (!world || !activeRoom) throw new Error("Room context needs a world and active room.");
  const radius = ROOM_CONTEXT_RADIUS;
  const size = radius * 2 + 1;
  const omittedDimmedRoles = new Set(options.omitDimmedRoleIds || []);
  const rooms = world.rooms
    .filter((room) =>
      Math.abs(room.columnIndex - activeRoom.columnIndex) <= radius &&
      Math.abs(room.rowIndex - activeRoom.rowIndex) <= radius)
    .map((room) => {
      const active = sameRoom(room, activeRoom);
      const roomState = active ? { ...room, ...renderedRoom } : room;
      return {
        ...roomState,
        objects: active || !omittedDimmedRoles.size
          ? roomState.objects
          : roomState.objects.filter((object) =>
              !omittedDimmedRoles.has(world.blockDefinitions.get(object.blockId)?.roleId)),
        columnIndex: room.columnIndex - activeRoom.columnIndex + radius,
        rowIndex: room.rowIndex - activeRoom.rowIndex + radius,
        renderDimmed: !active
      };
    });

  return {
    ...world,
    columns: Array.from({ length: size }, (_, index) => `context-column-${index - radius}`),
    rows: Array.from({ length: size }, (_, index) => `context-row-${index - radius}`),
    roomWidth: activeRoom.width || world.roomWidth,
    roomHeight: activeRoom.height || world.roomHeight,
    rooms,
    contextActiveRoom: {
      columnIndex: radius,
      rowIndex: radius,
      fileName: activeRoom.fileName
    }
  };
}
