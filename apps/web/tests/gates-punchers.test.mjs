import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../../../project-data/project.json", import.meta.url);

test("the tracked project catalog includes binary red gates and binary four-direction punchers", async () => {
  const project = JSON.parse(await readFile(projectUrl, "utf8"));
  const roles = new Map(project.roles.map((role) => [role.id, role]));
  const blocks = new Map(project.blocks.map((block) => [block.id, block]));

  assert.deepEqual(roles.get("player-gate"), {
    id: "player-gate",
    name: "Red Gate",
    description: "A two-state red player gate. State 0 is a lowered pass-through slab and state 1 is a raised gate cube. Its collision and trigger rules are awaiting authored tests.",
    generic: true,
  });
  assert.deepEqual(blocks.get("player-gate"), {
    id: "player-gate",
    name: "Red gate",
    color: "#C75652",
    roleId: "player-gate",
    genericMax: 1,
    occupancy: "sensor",
    visual: { kind: "gate" },
  });
  assert.deepEqual(blocks.get("puncher"), {
    id: "puncher",
    name: "Puncher",
    color: "#EF4444",
    roleId: "puncher",
    genericMax: 1,
    variantMax: 3,
    occupancy: "sensor",
    visual: { kind: "puncher" },
  });
  assert.deepEqual(roles.get("puncher"), {
    id: "puncher",
    name: "Puncher",
    description: "A four-direction, two-state fixture. State 0 is unsprung and state 1 is sprung; its direction points outward from its supporting side face. Its launch and timing rules are awaiting authored tests.",
    generic: true,
  });
});
