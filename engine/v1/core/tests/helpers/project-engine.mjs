import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  cropVoxelsToWorld,
  rotateVoxelsClockwise,
  rotateWorldClockwise,
} from "../../../apps/web/app/worldBounds.mjs";
import {
  buttonIsHiddenMechanismId,
  buttonMechanismId,
  normalizeButtonOrientation,
  normalizeSlopeDirection,
  puncherIsSprungMechanismId,
  puncherMechanismId,
} from "../../../apps/web/app/visualVariants.mjs";
import {
  normalizeOrangeWallFrame,
  orangeWallDepthFromMechanismValue,
  orangeWallEngineAnchorZ,
  orangeWallFrameFromEngine,
  orangeWallMechanismValue,
  orangeWallVisualFrame,
} from "../../../apps/web/app/orangeWalls.mjs";

import { readProjectDirectory } from "../../../scripts/lib/project-store.mjs";

const project = await readProjectDirectory(new URL(
  "../../../project-data", import.meta.url));
const wasm = await readFile(
  new URL("../../../apps/web/public/physics/voxel_physics.wasm", import.meta.url),
);
const { instance } = await WebAssembly.instantiate(wasm, {});
const engine = instance.exports;
const encoder = new TextEncoder();

function roleCode(roleId) {
  const bytes = encoder.encode(roleId);
  assert.ok(bytes.length <= engine.role_buffer_capacity());
  new Uint8Array(engine.memory.buffer, engine.role_buffer(), bytes.length).set(bytes);
  return engine.role_code(bytes.length);
}

const roleCodes = new Map(project.roles.map((role) => [role.id, roleCode(role.id)]));
for (const direction of ["up", "right", "down", "left"]) {
  for (const family of ["ice-slope", "blue-box-slope", "yellow-clone-slope"]) {
    roleCodes.set(`${family}-${direction}`, roleCode(`${family}-${direction}`));
  }
}
const blocksById = new Map(project.blocks.map((block) => [block.id, block]));
const floorBlockId = project.blocks.find((block) => block.roleId === "floor")?.id;
const buttonBlockIds = {
  visible: project.blocks.find((block) =>
    block.visual?.kind === "button" && block.visual.buttonForm !== "hidden")?.id,
  hidden: project.blocks.find((block) =>
    block.visual?.kind === "button" && block.visual.buttonForm === "hidden")?.id,
};
const slopeDirections = ["up", "right", "down", "left"];
function slopePhysicsRoleId(baseRoleId, direction) {
  if (baseRoleId === "weightless-pushable") return `blue-box-slope-${direction}`;
  if (baseRoleId === "clone") return `yellow-clone-slope-${direction}`;
  return `ice-slope-${direction}`;
}
function voxelRole(voxel) {
  const block = blocksById.get(voxel.blockId);
  if (!block) return 0;
  if (block.visual?.kind === "slope") {
    const direction = slopeDirections.includes(voxel.orientation)
      ? voxel.orientation
      : slopeDirections[Math.max(0, Math.floor(voxel.variantId ?? 0)) % 4];
    return roleCodes.get(slopePhysicsRoleId(block.roleId, direction)) ?? 0;
  }
  return roleCodes.get(block.roleId) ?? 0;
}
const genericRoles = new Set(project.roles.filter((role) => role.generic).map((role) => role.id));
const genericBlocks = new Set(
  project.blocks.filter((block) => genericRoles.has(block.roleId)).map((block) => block.id),
);
function voxelMechanismId(voxel) {
  const block = blocksById.get(voxel.blockId);
  if (block?.visual?.kind === "button") {
    return buttonMechanismId(
      normalizeButtonOrientation(voxel.orientation, voxel.variantId),
      block.visual.buttonForm === "hidden",
    );
  }
  if (block?.visual?.kind === "orange-wall") {
    return orangeWallMechanismValue(voxel, blocksById);
  }
  if (block?.visual?.kind === "puncher") {
    return puncherMechanismId(
      normalizeSlopeDirection(voxel.orientation, voxel.variantId),
      Number(voxel.genericId) === 1,
    );
  }
  return genericBlocks.has(voxel.blockId)
    ? Math.max(0, Math.floor(voxel.genericId ?? 0))
    : -1;
}

function simulateFrames(voxels, direction, world) {
  assert.equal(engine.physics_abi_version(), 4);
  const stride = engine.voxel_stride();
  assert.equal(stride, 5);
  assert.ok(voxels.length <= engine.voxel_capacity());
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => {
    buffer.set([
      voxel.x,
      voxel.y,
      blocksById.get(voxel.blockId)?.roleId === "orange-wall"
        ? orangeWallEngineAnchorZ(voxel, blocksById)
        : voxel.z,
      voxelRole(voxel),
      voxelMechanismId(voxel),
    ], index * stride);
  });
  const readFrame = () => orangeWallFrameFromEngine({
    voxels: voxels.map((voxel, index) => {
      const mechanismId = buffer[index * stride + 4];
      const visualKind = blocksById.get(voxel.blockId)?.visual?.kind;
      return ({
      ...voxel,
      ...(visualKind === "button"
        ? {
            blockId: buttonIsHiddenMechanismId(mechanismId)
              ? buttonBlockIds.hidden ?? voxel.blockId
              : buttonBlockIds.visible ?? voxel.blockId,
          }
        : visualKind === "floating-floor" && mechanismId === 1
          ? { blockId: floorBlockId ?? voxel.blockId }
        : {}),
      x: buffer[index * stride],
      y: buffer[index * stride + 1],
      z: buffer[index * stride + 2],
      ...(visualKind === "button"
        ? { stateId: 0 }
        : visualKind === "orange-wall"
          ? { mechanismDepth: orangeWallDepthFromMechanismValue(mechanismId) }
          : {}),
      ...(genericBlocks.has(voxel.blockId)
        ? { genericId: visualKind === "puncher"
          ? Number(puncherIsSprungMechanismId(mechanismId))
          : mechanismId }
        : {}),
      });
    }),
  }, blocksById).voxels;
  const frames = [];
  const sameCoordinates = (left, right) => left.length === right.length &&
    left.every((voxel, index) => voxel.x === right[index].x &&
      voxel.y === right[index].y && voxel.z === right[index].z &&
      voxel.genericId === right[index].genericId &&
      voxel.stateId === right[index].stateId &&
      voxel.mechanismDepth === right[index].mechanismDepth);
  let tick = 0;
  engine.reset_command();
  for (let iteration = 0; ; ++iteration) {
    assert.ok(iteration < 10000, "command did not settle or report a cycle within 10000 steps");
    const status = engine.step_command_tick(
      voxels.length, world.width, world.height, direction);
    assert.ok(status === 0 || status === 1);
    if (engine.command_tick() !== tick) {
      tick = engine.command_tick();
      frames.push(readFrame());
    }
    if (status === 0) {
      const final = readFrame();
      if (engine.command_cycle_detected() ||
          !sameCoordinates(frames.at(-1) ?? voxels, final)) {
        frames.push(final);
      }
      frames.cycle = engine.command_cycle_detected()
        ? {
            startTick: engine.command_cycle_start_tick(),
            repeatTick: engine.command_cycle_repeat_tick(),
          }
        : null;
      return frames;
    }
  }
}

function simulateFinal(voxels, direction, world) {
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    voxels.length * stride,
  );
  voxels.forEach((voxel, index) => {
    buffer.set([
      voxel.x,
      voxel.y,
      blocksById.get(voxel.blockId)?.roleId === "orange-wall"
        ? orangeWallEngineAnchorZ(voxel, blocksById)
        : voxel.z,
      voxelRole(voxel),
      voxelMechanismId(voxel),
    ], index * stride);
  });
  assert.equal(
    engine.simulate_turn(voxels.length, world.width, world.height, direction),
    0,
  );
  return orangeWallFrameFromEngine({
    voxels: voxels.map((voxel, index) => {
      const mechanismId = buffer[index * stride + 4];
      const visualKind = blocksById.get(voxel.blockId)?.visual?.kind;
      return ({
      ...voxel,
      ...(visualKind === "button"
        ? {
            blockId: buttonIsHiddenMechanismId(mechanismId)
              ? buttonBlockIds.hidden ?? voxel.blockId
              : buttonBlockIds.visible ?? voxel.blockId,
          }
        : visualKind === "floating-floor" && mechanismId === 1
          ? { blockId: floorBlockId ?? voxel.blockId }
        : {}),
      x: buffer[index * stride],
      y: buffer[index * stride + 1],
      z: buffer[index * stride + 2],
      ...(visualKind === "button"
        ? { stateId: 0 }
        : visualKind === "orange-wall"
          ? { mechanismDepth: orangeWallDepthFromMechanismValue(mechanismId) }
          : {}),
      ...(genericBlocks.has(voxel.blockId)
        ? { genericId: visualKind === "puncher"
          ? Number(puncherIsSprungMechanismId(mechanismId))
          : mechanismId }
        : {}),
      });
    }),
  }, blocksById).voxels;
}

function identity(voxel) {
  return `${voxel.x},${voxel.y},${voxel.z}:${voxel.blockId}:${voxel.genericId ?? -1}:${voxel.stateId ?? 0}:${voxel.mechanismDepth ?? -1}:${voxel.orientation ?? "none"}`;
}

function summarize(voxels) {
  if (voxels.length === 0) return "none";
  const shown = voxels.slice(0, 8).map(identity).join("; ");
  return voxels.length > 8 ? `${shown}; +${voxels.length - 8} more` : shown;
}

function frameDifference(expected, actual, world) {
  const visibleExpected = orangeWallVisualFrame({
    voxels: cropVoxelsToWorld(expected, world),
  }, blocksById).voxels;
  const visibleActual = orangeWallVisualFrame({
    voxels: cropVoxelsToWorld(actual, world),
  }, blocksById).voxels;
  const expectedMap = new Map(visibleExpected.map((voxel) => [identity(voxel), voxel]));
  const actualMap = new Map(visibleActual.map((voxel) => [identity(voxel), voxel]));
  return {
    missing: [...expectedMap].filter(([key]) => !actualMap.has(key)).map(([, voxel]) => voxel),
    unexpected: [...actualMap].filter(([key]) => !expectedMap.has(key)).map(([, voxel]) => voxel),
  };
}


export { project, engine, blocksById, voxelRole, voxelMechanismId, simulateFrames, simulateFinal, frameDifference, summarize };
