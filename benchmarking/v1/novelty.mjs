import { createHash } from "node:crypto";
import { engineRoleIdForObject, writeEngineStateV1 } from "../../engine/v1/adapter.mjs";

export const NOVELTY_VERSION = 2;

const FIXED_ROLES = new Set(["floor", "solid", "ice", "ice-slope-up", "ice-slope-right", "ice-slope-down", "ice-slope-left"]);

// Analytics identity is intentionally separate from the complete game-state
// hash and signed checkpoint. Gem objects, global collection progress, camera,
// fixed terrain, room dimensions and object-array order do not distinguish
// configurations. Retain movable bodies and every mechanism, including an
// orange slope whose adapter role happens to be an ordinary ice slope.
export function noveltyStateHash(roomFile, state, definitions) {
  const buffer = new Int32Array(state.objects.length * 5);
  writeEngineStateV1(state, definitions, () => 0, buffer, 5);
  const objects = [];
  const blocks = definitions instanceof Map ? definitions : new Map(definitions.map(block => [block.id, block]));
  for (const [index, object] of state.objects.entries()) {
    const role = engineRoleIdForObject(object, definitions);
    if (role === "goal") continue;
    if (FIXED_ROLES.has(role) && blocks.get(object.blockId)?.roleId !== "orange-wall") continue;
    const offset = index * 5;
    objects.push(JSON.stringify([
      object.blockId, role, buffer[offset], buffer[offset + 1],
      buffer[offset + 2], buffer[offset + 4]
    ]));
  }
  objects.sort();
  return createHash("sha256").update(JSON.stringify({ roomFile, objects })).digest("hex");
}
