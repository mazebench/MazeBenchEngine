import {
  buttonIsHiddenMechanismId,
  buttonMechanismId,
  normalizeButtonOrientation,
  normalizeSlopeDirection,
  puncherIsSprungMechanismId,
  puncherMechanismId,
} from "./visualVariants.mjs";
import {
  orangeWallDepthFromMechanismValue,
  orangeWallEngineAnchorZ,
  orangeWallFrameFromEngine,
  orangeWallMechanismValue,
} from "./orangeWalls.mjs";

type Direction = "up" | "down" | "left" | "right";
type PhysicsRole = { id: string; generic: boolean };
type BlockDefinition = {
  id: string;
  roleId: string;
  visual?: {
    buttonForm?: "visible" | "hidden";
    kind?: string;
    orangeForm?: "visible" | "hidden";
  };
};
type Voxel = {
  x: number;
  y: number;
  z: number;
  blockId: string;
  genericId?: number;
  groupId?: number;
  mechanismDepth?: number;
  orientation?: string;
  stateId?: number;
  variantId?: number;
};
type Frame = { voxels: Voxel[] };
type WorldSettings = { width: number; height: number };

type PhysicsExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  physics_abi_version: () => number;
  role_buffer: () => number;
  role_buffer_capacity: () => number;
  role_code: (length: number) => number;
  command_tick: () => number;
  command_cycle_detected: () => number;
  command_cycle_start_tick: () => number;
  command_cycle_repeat_tick: () => number;
  motion_state_buffer: () => number;
  motion_state_size: () => number;
  reset_command: () => void;
  step_command_tick: (count: number, width: number, height: number, direction: number) => number;
  simulate_turn: (count: number, width: number, height: number, direction: number) => number;
  voxel_buffer: () => number;
  voxel_capacity: () => number;
  voxel_stride: () => number;
};

let physicsPromise: Promise<PhysicsExports> | null = null;

async function loadPhysics() {
  if (!physicsPromise) {
    physicsPromise = fetch("/physics/voxel_physics.wasm")
      .then((response) => {
        if (!response.ok) throw new Error(`C++ physics engine failed to load (${response.status})`);
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes))
      .then((module) => WebAssembly.instantiate(module, {}))
      .then((instance) => instance.exports as PhysicsExports)
      .catch((error) => { physicsPromise = null; throw error; });
  }
  return physicsPromise;
}

function directionCode(direction: Direction) {
  return { up: 0, right: 1, down: 2, left: 3 }[direction];
}

function framesHaveSameCoordinates(left: Frame, right: Frame) {
  return left.voxels.length === right.voxels.length &&
    left.voxels.every((voxel, index) => {
      const other = right.voxels[index];
      return voxel.x === other.x && voxel.y === other.y && voxel.z === other.z &&
        voxel.genericId === other.genericId && voxel.stateId === other.stateId &&
        voxel.mechanismDepth === other.mechanismDepth;
    });
}

function slopePhysicsRoleId(baseRoleId: string, direction: string) {
  if (baseRoleId === "orange-wall") return `orange-wall-slope-${direction}`;
  if (baseRoleId === "weightless-pushable") return `blue-box-slope-${direction}`;
  if (baseRoleId === "clone") return `yellow-clone-slope-${direction}`;
  return `ice-slope-${direction}`;
}

async function roleCodesById(physics: PhysicsExports, roles: PhysicsRole[]) {
  const encoder = new TextEncoder();
  const roleBufferPointer = physics.role_buffer();
  const roleBufferCapacity = physics.role_buffer_capacity();
  const codes = new Map<string, number>();

  const roleIds = [
    ...roles.map((role) => role.id),
    "orange-wall-slope-up",
    "orange-wall-slope-right",
    "orange-wall-slope-down",
    "orange-wall-slope-left",
    "ice-slope-up",
    "ice-slope-right",
    "ice-slope-down",
    "ice-slope-left",
    "blue-box-slope-up",
    "blue-box-slope-right",
    "blue-box-slope-down",
    "blue-box-slope-left",
    "yellow-clone-slope-up",
    "yellow-clone-slope-right",
    "yellow-clone-slope-down",
    "yellow-clone-slope-left",
  ];
  for (const roleId of roleIds) {
    const bytes = encoder.encode(roleId);
    if (bytes.length > roleBufferCapacity) {
      throw new Error(`Physics role key is too long: ${roleId}`);
    }
    new Uint8Array(physics.memory.buffer, roleBufferPointer, bytes.length).set(bytes);
    codes.set(roleId, physics.role_code(bytes.length));
  }
  return codes;
}

type PhysicsAdapterContext = {
  blockRole: (voxel: Voxel) => number;
  blocks: BlockDefinition[];
  blocksById: Map<string, BlockDefinition>;
  buttonBlockIds: { visible?: string; hidden?: string };
  floorBlockId?: string;
  genericBlockIds: Set<string>;
  mechanismValue: (voxel: Voxel) => number;
  physics: PhysicsExports;
  roles: PhysicsRole[];
};

let cachedAdapterContext: PhysicsAdapterContext | null = null;

async function physicsAdapterContext(
  blocks: BlockDefinition[],
  roles: PhysicsRole[],
) {
  const physics = await loadPhysics();
  if (cachedAdapterContext?.physics === physics &&
      cachedAdapterContext.blocks === blocks &&
      cachedAdapterContext.roles === roles) {
    return cachedAdapterContext;
  }

  const rolesById = await roleCodesById(physics, roles);
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const slopeDirections = ["up", "right", "down", "left"];
  const blockRole = (voxel: Voxel) => {
    const block = blocksById.get(voxel.blockId);
    if (!block) return 0;
    if (block.visual?.kind === "slope") {
      const orientation = slopeDirections.includes(voxel.orientation ?? "")
        ? voxel.orientation!
        : slopeDirections[Math.max(0, Math.floor(voxel.variantId ?? 0)) % 4];
      return rolesById.get(slopePhysicsRoleId(block.roleId, orientation)) ?? 0;
    }
    return rolesById.get(block.roleId) ?? 0;
  };
  const genericRoleIds = new Set(
    roles.filter((role) => role.generic).map((role) => role.id));
  const genericBlockIds = new Set(
    blocks.filter((block) => genericRoleIds.has(block.roleId)).map((block) => block.id),
  );
  const buttonBlockIds = {
    visible: blocks.find((block) =>
      block.visual?.kind === "button" && block.visual.buttonForm !== "hidden")?.id,
    hidden: blocks.find((block) =>
      block.visual?.kind === "button" && block.visual.buttonForm === "hidden")?.id,
  };
  const floorBlockId = blocks.find((block) => block.roleId === "floor")?.id;
  const mechanismValue = (voxel: Voxel) => {
    const visual = blocksById.get(voxel.blockId)?.visual;
    if (visual?.kind === "button") {
      return buttonMechanismId(
        normalizeButtonOrientation(voxel.orientation, voxel.variantId),
        visual.buttonForm === "hidden",
      );
    }
    if (blocksById.get(voxel.blockId)?.roleId === "orange-wall") {
      return orangeWallMechanismValue(voxel);
    }
    if (visual?.kind === "puncher") {
      return puncherMechanismId(
        normalizeSlopeDirection(voxel.orientation, voxel.variantId),
        Number(voxel.genericId) === 1,
      );
    }
    return genericBlockIds.has(voxel.blockId)
      ? Math.max(0, Math.floor(Number(voxel.genericId) || 0))
      : -1;
  };

  cachedAdapterContext = {
    blockRole,
    blocks,
    blocksById,
    buttonBlockIds,
    floorBlockId,
    genericBlockIds,
    mechanismValue,
    physics,
    roles,
  };
  return cachedAdapterContext;
}

export async function simulateTurnWithCpp(
  frame: Frame,
  direction: Direction,
  blocks: BlockDefinition[],
  roles: PhysicsRole[],
  world: WorldSettings,
): Promise<Frame> {
  const simulation = await simulateCommandWithCpp(frame, direction, blocks, roles, world);
  return simulation.final;
}

export async function simulateCommandWithCpp(
  frame: Frame,
  direction: Direction,
  blocks: BlockDefinition[],
  roles: PhysicsRole[],
  world: WorldSettings,
): Promise<{
  final: Frame;
  frames: Frame[];
  cycle?: { startTick: number; repeatTick: number; onCycle: "rollback-command" };
}> {
  const context = await physicsAdapterContext(blocks, roles);
  const {
    blockRole,
    blocksById,
    buttonBlockIds,
    floorBlockId,
    genericBlockIds,
    mechanismValue,
    physics,
  } = context;
  if (physics.physics_abi_version() !== 4 || physics.voxel_stride() !== 5) {
    throw new Error("The web app and C++ physics engine use different ABI versions");
  }
  if (frame.voxels.length > physics.voxel_capacity()) {
    throw new Error(`The C++ engine supports up to ${physics.voxel_capacity()} voxels per frame`);
  }

  const stride = physics.voxel_stride();
  const voxelBuffer = new Int32Array(
    physics.memory.buffer,
    physics.voxel_buffer(),
    frame.voxels.length * stride,
  );
  frame.voxels.forEach((voxel, index) => {
    const offset = index * stride;
    voxelBuffer[offset] = voxel.x;
    voxelBuffer[offset + 1] = voxel.y;
    voxelBuffer[offset + 2] = blocksById.get(voxel.blockId)?.roleId === "orange-wall"
      ? orangeWallEngineAnchorZ(voxel)
      : voxel.z;
    voxelBuffer[offset + 3] = blockRole(voxel);
    voxelBuffer[offset + 4] = mechanismValue(voxel);
  });

  const readFrame = (): Frame => orangeWallFrameFromEngine({
    voxels: frame.voxels.map((voxel, index) => {
      const offset = index * stride;
      const visualKind = blocksById.get(voxel.blockId)?.visual?.kind;
      const mechanismId = voxelBuffer[offset + 4];
      return {
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
        x: voxelBuffer[offset],
        y: voxelBuffer[offset + 1],
        z: voxelBuffer[offset + 2],
        ...(visualKind === "button"
          ? { stateId: 0 }
          : blocksById.get(voxel.blockId)?.roleId === "orange-wall"
            ? { mechanismDepth: orangeWallDepthFromMechanismValue(mechanismId) }
            : {}),
        ...(genericBlockIds.has(voxel.blockId)
          ? {
              genericId: visualKind === "puncher"
                ? Number(puncherIsSprungMechanismId(mechanismId))
                : mechanismId,
              ...(blocksById.get(voxel.blockId)?.visual?.kind === "lift"
                ? { groupId: voxelBuffer[offset + 4] }
                : {}),
            }
          : {}),
      };
    }),
  }, blocksById) as Frame;

  physics.reset_command();
  const frames: Frame[] = [];
  let previousTick = 0;
  for (let iteration = 0; iteration < 100_000; iteration += 1) {
    const status = physics.step_command_tick(
      frame.voxels.length,
      world.width,
      world.height,
      directionCode(direction),
    );
    if (status === -1) throw new Error("The C++ engine rejected invalid command data");
    if (status === -2) throw new Error("The C++ engine could not find a player");
    const tick = physics.command_tick();
    if (tick !== previousTick) {
      frames.push(readFrame());
      previousTick = tick;
    }
    if (status === 0) {
      const final = readFrame();
      const lastVisible = frames.at(-1) ?? frame;
      if (physics.command_cycle_detected() ||
          !framesHaveSameCoordinates(lastVisible, final)) {
        frames.push(final);
      }
      const cycle = physics.command_cycle_detected()
        ? {
            startTick: physics.command_cycle_start_tick(),
            repeatTick: physics.command_cycle_repeat_tick(),
            onCycle: "rollback-command" as const,
          }
        : undefined;
      return { final, frames, cycle };
    }
  }
  throw new Error("The C++ command did not become quiescent within 100,000 ticks");
}
