export function installRoomControlsV1(world, grid, onOpen) {
  const sorted = world.rooms.slice().sort((left, right) =>
    left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex);
  const buttons = new Map();
  sorted.forEach((room) => {
    const label = room.position.join("×");
    const button = document.createElement("button");
    button.type = "button";
    button.title = `Play room ${label}`;
    button.setAttribute("aria-label", `Play room ${label}`);
    button.addEventListener("click", () => onOpen(room));
    grid.append(button);
    buttons.set(room.fileName, button);
  });
  return (room) => {
    buttons.forEach((button, fileName) => {
      button.classList.toggle("is-current", fileName === room.fileName);
      button.setAttribute("aria-pressed", String(fileName === room.fileName));
    });
  };
}
