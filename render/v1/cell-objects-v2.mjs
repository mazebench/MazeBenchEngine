// Minimal editor occupancy rules ported from MazeBenchEngineUnitTest.

export function objectCanShareCell(block) {
  return block?.roleId === "orange-wall" || block?.occupancy !== "solid";
}

export function objectIsSurface(block) {
  return ["floor", "exit"].includes(block?.visual?.kind);
}

export function objectPaintsInsideClickedBody(block) {
  return block?.visual?.kind !== "lift" && objectCanShareCell(block);
}

export function cellCoordinateKey(object) {
  return `${object.x},${object.y},${object.z}`;
}

export function cellObjectSemanticKey(object) {
  return [
    cellCoordinateKey(object),
    object.blockId,
    object.groupId ?? object.genericId ?? -1,
    object.variantId ?? 0,
    object.stateId ?? 0,
    object.mechanismDepth ?? -1,
    object.orientation ?? "none"
  ].join(":");
}

export function cellObjectSelectionKey(object) {
  return object.instanceId
    ? `instance:${object.instanceId}`
    : `semantic:${cellObjectSemanticKey(object)}`;
}

export function placeObjectInCell(objects, placement, definitions) {
  const coordinate = cellCoordinateKey(placement);
  const semantic = cellObjectSemanticKey(placement);
  const occupants = objects.filter((object) => cellCoordinateKey(object) === coordinate);
  if (occupants.some((object) => cellObjectSemanticKey(object) === semantic)) {
    return { changed: false, objects: objects.map((object) => ({ ...object })) };
  }
  const block = definitions.get(placement.blockId);
  const placementSurface = objectIsSurface(block);
  const placementShareable = objectCanShareCell(block);
  const fixtureKind = block?.visual?.kind;
  const replacesFixture = ["button", "gate", "lift", "puncher"].includes(fixtureKind);
  const kept = placementSurface
    ? objects.filter((object) =>
        cellCoordinateKey(object) !== coordinate ||
        !objectIsSurface(definitions.get(object.blockId)))
    : placementShareable
    ? block?.roleId === "orange-wall"
      ? objects.filter((object) =>
          cellCoordinateKey(object) !== coordinate || object.blockId !== placement.blockId)
      : replacesFixture
        ? objects.filter((object) =>
            cellCoordinateKey(object) !== coordinate ||
            object.blockId !== placement.blockId ||
            (object.orientation || "top") !== (placement.orientation || "top"))
      : objects
    : objects.filter((object) =>
        cellCoordinateKey(object) !== coordinate ||
        objectIsSurface(definitions.get(object.blockId)) ||
        objectCanShareCell(definitions.get(object.blockId)));
  return {
    changed: true,
    objects: [...kept.map((object) => ({ ...object })), { ...placement }]
  };
}

export function eraseOneObjectAtCell(objects, coordinate, selectionKey) {
  const key = cellCoordinateKey(coordinate);
  let removeIndex = -1;
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index];
    if (selectionKey
      ? cellObjectSelectionKey(object) === selectionKey
      : cellCoordinateKey(object) === key) {
      removeIndex = index;
      break;
    }
  }
  if (removeIndex < 0) {
    return { changed: false, objects: objects.map((object) => ({ ...object })), removed: null };
  }
  return {
    changed: true,
    objects: objects.filter((_, index) => index !== removeIndex).map((object) => ({ ...object })),
    removed: { ...objects[removeIndex] }
  };
}

export function objectsAtCell(objects, coordinate) {
  const key = cellCoordinateKey(coordinate);
  return objects.filter((object) => cellCoordinateKey(object) === key);
}
