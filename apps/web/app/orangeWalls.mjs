import { liftIsRaised, normalizeButtonOrientation } from "./visualVariants.mjs";

function nonnegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function definitionFor(definitions, blockId) {
  return definitions instanceof Map
    ? definitions.get(blockId)
    : definitions?.find?.((definition) => definition.id === blockId);
}

export function orangeWallIsDedicatedFace(wall) {
  return Number(wall?.stateId) === 0;
}

export function orangeWallIsHiddenVolume(wall, definitions) {
  return definitionFor(definitions, wall?.blockId)?.visual?.orangeForm === "hidden" ||
    Number(wall?.stateId) === 2;
}

export function orangeWallMechanismValue(wall) {
  return orangeWallMechanismDepth(wall);
}

export function orangeWallDepthFromMechanismValue(value) {
  const encoded = Number(value);
  if (!Number.isInteger(encoded)) return 0;
  // Read the old private Orange Face encoding for project/WASM compatibility,
  // but every newly written engine value is the ordinary nonnegative depth.
  return encoded <= -2 ? Math.max(0, -encoded - 2) : Math.max(0, encoded);
}

export function orangeWallMechanismDepth(wall) {
  if (wall?.mechanismDepth !== undefined) {
    return nonnegativeInteger(wall.mechanismDepth);
  }
  // Before binary wall states were introduced, stateId held the additive
  // lowering depth directly. Retaining this fallback migrates every authored
  // frame without rewriting its layout.
  return nonnegativeInteger(wall?.stateId);
}

export function orangeWallSupportZ(wall, voxels, definitions) {
  const lowestAnchorZ = voxels.reduce((lowest, candidate) => {
    const definition = definitionFor(definitions, candidate.blockId);
    if (definition?.roleId !== "orange-wall" ||
        candidate.x !== wall.x || candidate.y !== wall.y) {
      return lowest;
    }
    return Math.min(lowest, orangeWallEngineAnchorZ(candidate, definitions));
  }, orangeWallEngineAnchorZ(wall, definitions));
  let supportZ = Number.NEGATIVE_INFINITY;
  for (const candidate of voxels) {
    if (
      candidate === wall || candidate.x !== wall.x || candidate.y !== wall.y ||
      candidate.z >= lowestAnchorZ
    ) {
      continue;
    }
    const definition = definitionFor(definitions, candidate.blockId);
    if (!definition || definition.visual?.kind === "gem" ||
        definition.visual?.kind === "button" ||
        definition.roleId === "orange-wall" ||
        definition.roleId === "player" ||
        definition.roleId === "pushable" ||
        definition.roleId === "weightless-pushable" ||
        (definition.visual?.kind === "lift" && !liftIsRaised(candidate.genericId))) {
      continue;
    }
    if (definition.occupancy === "solid" || definition.visual?.kind === "lift") {
      supportZ = Math.max(supportZ, candidate.z);
    }
  }
  return supportZ;
}

function orangeWallSupportZFromEngineAnchors(wall, voxels, definitions) {
  const lowestAnchorZ = voxels.reduce((lowest, candidate) => {
    const definition = definitionFor(definitions, candidate.blockId);
    return definition?.roleId === "orange-wall" &&
      candidate.x === wall.x && candidate.y === wall.y
      ? Math.min(lowest, candidate.z)
      : lowest;
  }, wall.z);
  let supportZ = Number.NEGATIVE_INFINITY;
  for (const candidate of voxels) {
    if (candidate === wall || candidate.x !== wall.x || candidate.y !== wall.y ||
        candidate.z >= lowestAnchorZ) {
      continue;
    }
    const definition = definitionFor(definitions, candidate.blockId);
    if (!definition || definition.visual?.kind === "gem" ||
        definition.visual?.kind === "button" ||
        definition.roleId === "orange-wall" ||
        definition.roleId === "player" || definition.roleId === "pushable" ||
        definition.roleId === "weightless-pushable" ||
        (definition.visual?.kind === "lift" &&
         !liftIsRaised(candidate.genericId))) {
      continue;
    }
    if (definition.occupancy === "solid" || definition.visual?.kind === "lift") {
      supportZ = Math.max(supportZ, candidate.z);
    }
  }
  return supportZ;
}

export function orangeWallPhysicalState(wall, voxels, definitions) {
  const mechanismDepth = orangeWallMechanismDepth(wall);
  const supportZ = orangeWallSupportZ(wall, voxels, definitions);
  if (orangeWallIsHiddenVolume(wall, definitions)) {
    return {
      mechanismDepth,
      physicalZ: wall.z,
      stateId: 2,
      supportZ,
    };
  }
  if (orangeWallIsDedicatedFace(wall, definitions)) {
    // Read the retired lowered-face state as an ordinary visible cube. New
    // project data never writes state 0, but this keeps old imports lossless.
    return {
      mechanismDepth,
      physicalZ: wall.z,
      stateId: 1,
      supportZ,
    };
  }
  const desiredZ = wall.z - mechanismDepth;
  return {
    mechanismDepth,
    physicalZ: desiredZ,
    stateId: 1,
    supportZ,
  };
}

export function orangeWallDepthForState(wall, voxels, definitions, stateId) {
  if (Number(stateId) !== 0) return 0;
  const supportZ = orangeWallSupportZ(wall, voxels, definitions);
  if (!Number.isFinite(supportZ) || supportZ >= wall.z) return null;
  return wall.z - supportZ;
}

export function normalizeOrangeWallFrame(frame, definitions) {
  if (!frame.voxels.some((voxel) =>
    definitionFor(definitions, voxel.blockId)?.roleId === "orange-wall")) {
    return frame;
  }
  const voxels = frame.voxels.map((voxel) => ({ ...voxel }));
  return {
    ...frame,
    voxels: voxels.map((voxel) => {
      const definition = definitionFor(definitions, voxel.blockId);
      if (definition?.roleId !== "orange-wall") return voxel;
      const state = orangeWallPhysicalState(voxel, voxels, definitions);
      return {
        ...voxel,
        mechanismDepth: state.mechanismDepth,
        stateId: orangeWallIsHiddenVolume(voxel, definitions)
          ? 2
          : 1,
      };
    }),
  };
}

function orangeWallBlockIdForForm(wall, definitions, form) {
  const all = definitions instanceof Map
    ? [...definitions.values()]
    : definitions ?? [];
  return all.find((definition) =>
    definition?.roleId === "orange-wall" &&
    (definition.visual?.kind === "slope") ===
      (definitionFor(definitions, wall.blockId)?.visual?.kind === "slope") &&
    (definition.visual?.orangeForm ?? "visible") === form)?.id ?? wall.blockId;
}

// C++ stores a stable fully-raised anchor for each Orange Wall voxel. Authored
// frames instead store exactly what the editor displays. Converting at the ABI
// boundary keeps C++ state fixed-size while allowing cube/face/hidden records
// to change form at every mechanism tick.
export function orangeWallEngineAnchorZ(wall) {
  const depth = orangeWallMechanismDepth(wall);
  if (Number(wall?.stateId) === 0) return wall.z + Math.max(0, depth - 1);
  return wall.z + depth;
}

export function orangeWallFrameFromEngine(frame, definitions) {
  if (!frame.voxels.some((voxel) =>
    definitionFor(definitions, voxel.blockId)?.roleId === "orange-wall")) {
    return frame;
  }
  const engineVoxels = frame.voxels.map((voxel) => ({ ...voxel }));
  const visualVoxels = engineVoxels.map((voxel) => {
      const definition = definitionFor(definitions, voxel.blockId);
      if (definition?.roleId !== "orange-wall") return voxel;
      const depth = orangeWallMechanismDepth(voxel);
      const supportZ = orangeWallSupportZFromEngineAnchors(
        voxel, engineVoxels, definitions);
      const desiredZ = voxel.z - depth;
      const stateId = Number.isFinite(supportZ) && desiredZ < supportZ ? 2 : 1;
      return {
        ...voxel,
        blockId: orangeWallBlockIdForForm(
          voxel,
          definitions,
          stateId === 2 ? "hidden" : "visible",
        ),
        mechanismDepth: depth,
        stateId,
        z: desiredZ,
      };
    });

  // A wall-mounted side button has one compact engine record for its active
  // face. Below the support plane, the editor/test timeline also visualizes
  // the buried attachment column as transparent, inert button volumes. Derive
  // those cells here so the C++ ABI stays fixed-size and search states do not
  // pay for editor-only geometry.
  const buriedButtons = [];
  for (const button of visualVoxels) {
    const definition = definitionFor(definitions, button.blockId);
    if (definition?.visual?.kind !== "button" ||
        definition.visual.buttonForm !== "hidden") {
      continue;
    }
    const orientation = normalizeButtonOrientation(
      button.orientation,
      button.variantId,
    );
    for (const wall of engineVoxels) {
      if (definitionFor(definitions, wall.blockId)?.roleId !== "orange-wall") {
        continue;
      }
      const depth = orangeWallMechanismDepth(wall);
      const raisedButtonZ = button.z + depth;
      const mounted =
        (orientation === "top" && button.x === wall.x &&
          button.y === wall.y && raisedButtonZ === wall.z + 1) ||
        (orientation === "north" && button.x === wall.x &&
          button.y + 1 === wall.y && raisedButtonZ === wall.z) ||
        (orientation === "east" && button.x - 1 === wall.x &&
          button.y === wall.y && raisedButtonZ === wall.z) ||
        (orientation === "south" && button.x === wall.x &&
          button.y - 1 === wall.y && raisedButtonZ === wall.z) ||
        (orientation === "west" && button.x + 1 === wall.x &&
          button.y === wall.y && raisedButtonZ === wall.z) ||
        (orientation === "bottom" && button.x === wall.x &&
          button.y === wall.y && raisedButtonZ === wall.z - 1);
      if (!mounted) continue;
      const supportZ = orangeWallSupportZFromEngineAnchors(
        wall,
        engineVoxels,
        definitions,
      );
      if (Number.isFinite(supportZ)) {
        for (let z = button.z + 1; z <= supportZ; z += 1) {
          buriedButtons.push({
            ...button,
            z,
            ...(button.instanceId === undefined
              ? {}
              : { instanceId: `${button.instanceId}:buried:${z}` }),
          });
        }
      }
      break;
    }
  }

  return {
    ...frame,
    voxels: [...visualVoxels, ...buriedButtons],
  };
}

export function orangeWallVisualFrame(frame, definitions) {
  return normalizeOrangeWallFrame(frame, definitions);
}
