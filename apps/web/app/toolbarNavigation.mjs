export const MAX_GENERIC_OBJECT_ID = 2147483647;

/**
 * @param {number} currentIndex
 * @param {number} slotCount
 * @param {-1 | 1} direction
 */
export function offsetToolbarIndex(currentIndex, slotCount, direction) {
  if (slotCount <= 0) return -1;
  const safeIndex = currentIndex >= 0 && currentIndex < slotCount ? currentIndex : 0;
  return (safeIndex + direction + slotCount) % slotCount;
}

/**
 * @param {number} currentId
 * @param {-1 | 1} direction
 * @param {number} [maximumId]
 */
export function offsetGenericObjectId(currentId, direction, maximumId = MAX_GENERIC_OBJECT_ID) {
  const safeMaximum = Number.isInteger(maximumId)
    ? Math.max(0, Math.min(MAX_GENERIC_OBJECT_ID, maximumId))
    : MAX_GENERIC_OBJECT_ID;
  const safeId = Number.isInteger(currentId)
    ? Math.max(0, Math.min(safeMaximum, currentId))
    : 0;
  if (direction < 0 && safeId === 0) return null;
  return Math.max(0, Math.min(safeMaximum, safeId + direction));
}

/**
 * Generic tools show their chosen object number only while they are the active
 * paint tool. Every inactive generic tool returns to the family marker `N`.
 *
 * @param {string} blockId
 * @param {string} selectedBlockId
 * @param {number} genericId
 * @param {boolean} temporarilyInactive
 */
export function genericToolbarLabel(blockId, selectedBlockId, genericId, temporarilyInactive) {
  if (temporarilyInactive || blockId !== selectedBlockId) return "N";
  return String(Math.max(0, Math.min(MAX_GENERIC_OBJECT_ID, Math.floor(Number(genericId) || 0))));
}
