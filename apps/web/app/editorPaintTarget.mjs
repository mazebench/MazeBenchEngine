/**
 * Shareable objects are sensors/surfaces rather than launch faces. Clicking an
 * existing actor while painting another shareable object therefore means
 * "add to this cell", while ordinary cube painting still targets the exposed
 * neighboring face.
 */
export function resolveEditorPaintTarget(
  target,
  { erase = false, replace = false, selectedCanShare = false } = {},
) {
  const addToActorCell =
    !erase && !replace && selectedCanShare && target?.kind === "actor";
  const useSource = erase || replace || addToActorCell;
  return {
    layer: useSource ? target.sourceLayer : target.paintLayer,
    x: useSource ? target.sourceX : target.paintX,
    y: useSource ? target.sourceY : target.paintY,
  };
}
