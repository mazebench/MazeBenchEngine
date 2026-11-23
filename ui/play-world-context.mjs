// Stable room snapshots let Play and the editor share cached background meshes.
// A new objects array invalidates only that room's authored snapshot.
export function createWorldContext(world, { hideBackgroundPlayers = false } = {}) {
  const contextRooms = [];
  const sources = [];
  return (room, renderedRoom = room) => {
    world.rooms.forEach((source, index) => {
      if (sources[index] === source.objects) return;
      sources[index] = source.objects;
      contextRooms[index] = {
        ...source,
        renderDimmed: true,
        objects: hideBackgroundPlayers ? source.objects.filter(object =>
          world.blockDefinitions.get(object.blockId)?.roleId !== "player") : source.objects
      };
    });
    return {
      ...world,
      contextRooms,
      rooms: contextRooms.map(background => background.fileName === room.fileName
        ? { ...room, ...renderedRoom, columnIndex: room.columnIndex, rowIndex: room.rowIndex, renderDimmed: false }
        : background),
      contextActiveRoom: { fileName: room.fileName, columnIndex: room.columnIndex, rowIndex: room.rowIndex }
    };
  };
}

export const createPlayWorldContext = world => createWorldContext(world, { hideBackgroundPlayers: true });

export function playRoomCenter(world) {
  const room = world.contextActiveRoom;
  return {
    x: (room.columnIndex + 0.5 - world.columns.length / 2) * world.roomWidth,
    z: (room.rowIndex + 0.5 - world.rows.length / 2) * world.roomHeight
  };
}
