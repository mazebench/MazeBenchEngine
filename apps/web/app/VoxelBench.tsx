"use client";

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import LabToolboxPreviews from "./LabToolboxPreviews";
import MazeBenchCanvas, { type PaintSurface } from "./MazeBenchCanvas";
import SearchBench, { normalizeSearchLevels, type SearchLevel } from "./SearchBench";
import {
  cameraFacingSlopeDirection,
  cameraRelativeDirection,
} from "./cameraNavigation.mjs";
import { createSuitePreviewState, suitePreviewReducer } from "./suitePreviewCamera.mjs";
import { simulateCommandWithCpp } from "./physicsEngine";
import {
  applyWorldToTest,
  cropVoxelsToWorld,
  parseWorldDimensionDraft,
} from "./worldBounds.mjs";
import {
  moveVoxelGroup,
  removeSelectedVoxels,
  selectConnectedVoxelGroup,
  toggleVoxelGroupSelection,
} from "./voxelGroups.mjs";
import {
  genericToolbarLabel,
  offsetGenericObjectId,
  offsetToolbarIndex,
} from "./toolbarNavigation.mjs";
import { deleteTestCase, matchingFolderIds, runnableTestCases, sortTestCases, summarizeTestResults } from "./testSuite.mjs";
import {
  canonicalTagCombination,
  combinationViewIncludesTest,
  defaultSubtagId,
  directSubtagViewIncludesTest,
  ensureDefaultSubtags,
  flattenSubtags,
  normalizeTestTagPlacement,
  rootTagId,
  testUsesTag,
} from "./testTags.mjs";
import { enforceFloorLayer, selectionContainsFloor } from "./floorLayer.mjs";
import {
  OCCUPANCY_PROFILES,
  blockCanShareCell,
  blockUsesPolycubeGroup,
  cellObjectSelectionKey,
  eraseOneObjectAtCell,
  normalizeOccupancyProfile,
  objectPaintsInsideClickedBody,
  placeObjectInCell,
} from "./cellObjects.mjs";
import {
  normalizeOrangeWallFrame,
  orangeWallMechanismDepth,
} from "./orangeWalls.mjs";
import {
  shouldShowResultComparison,
  traceFrameLabel,
} from "./resultTrace.mjs";
import {
  insertIntermediateFrame,
  offsetTimelineSelection,
  previousExpectedFrame,
} from "./timelineFrames.mjs";
import {
  buttonOrientationFromPaintFace,
  buttonOrientationIndex,
  GATE_GENERIC_MAX,
  gateIsRaised,
  LIFT_GENERIC_MAX,
  liftGenericId,
  liftIsRaised,
  liftOrientationIndex,
  liftOrientationFromPaintFace,
  normalizeLiftOrientation,
  PUNCHER_GENERIC_MAX,
  puncherDirectionFromPaintFace,
  puncherIsSprung,
  slopeDirectionIndex,
} from "./visualVariants.mjs";
import {
  adjustCycleForDeletedTick,
  clearCycleExpectation,
  markCycleRepeat,
  markCycleStart,
  normalizeCycleExpectation,
  tickIsInCycle,
} from "./cycleExpectation.mjs";
import {
  decodeProjectPayload,
} from "./projectFormat.mjs";
import { createProjectCodec } from "./projectCodec";
import { compareFrames, runRotationalTest } from "./suiteRunner";
import { startSuiteWorker } from "./suiteWorker";
import type { Direction, PhysicsRoleDefinition, BlockDefinition, OccupancyProfile, BlockVisualDefinition, Voxel, Frame, WorldSettings, CycleExpectation, TestCase, TestResult } from "./suiteTypes";

type FrameKind = "start" | "expected";

type StoredBlockDefinition = Omit<BlockDefinition, "roleId" | "occupancy" | "visual"> & {
  behavior?: string;
  genericId?: number;
  occupancy?: OccupancyProfile;
  roleId?: string;
  visual?: Partial<BlockVisualDefinition>;
};

type TestFolder = {
  collapsed: boolean;
  default?: boolean;
  id: string;
  locked: boolean;
  name: string;
  parentId?: string;
};
type StoredTestFolder = Omit<TestFolder, "collapsed" | "locked"> & {
  collapsed?: boolean;
  locked?: boolean;
};

type StoredTestCase = Omit<TestCase, "description" | "folderId" | "hidden" | "intermediate" | "locked" | "tagIds" | "world"> & {
  cycle?: Partial<CycleExpectation>;
  description?: string;
  folderId?: string;
  hidden?: boolean;
  tagIds?: string[];
  intermediate?: Frame[];
  locked?: boolean;
  world?: WorldSettings;
};

type EditSnapshot = {
  frame: Frame;
  frameKind: FrameKind;
  intermediateIndex: number | null;
  testId: string;
};

type GroupSelection = {
  frameKind: FrameKind;
  intermediateIndex: number | null;
  keys: string[];
  testId: string;
};

const STORAGE_KEY = "voxelbench-project-v1";
const LOCAL_PROJECT_ENDPOINT = "/api/local-project";
const DELETE_TOOL_ID = "__erase_top__";
const GROUP_TOOL_ID = "__select_group__";
const UNDO_STACK_LIMIT = 80;
const DEFAULT_ROLES: PhysicsRoleDefinition[] = [
  { id: "solid", name: "Solid", description: "Occupies space and blocks movement.", generic: false },
  { id: "player", name: "Player", description: "The actor moved by the canonical directional input.", generic: false },
  { id: "pushable", name: "Pushable", description: "Moves when pushed and slides while supported by Ice.", generic: false },
  { id: "floor", name: "Floor", description: "Solid support whose edge the player may deliberately walk off.", generic: false },
  { id: "ice", name: "Ice", description: "A support tile that continues movement until normal floor or an obstacle.", generic: false },
  { id: "goal", name: "Goal / floor", description: "A floor marker with no movement behavior of its own.", generic: false },
  { id: "decor", name: "Decoration", description: "A visible object with no special movement behavior.", generic: false },
  { id: "weightless-pushable", name: "Weightless Pushable", description: "A numbered rigid polycube family that can push other weightless bodies.", generic: true },
  { id: "clone", name: "Clone", description: "A numbered rigid polycube family that receives the player's command.", generic: true },
  { id: "player-lift", name: "Player Lift", description: "A numbered purple lift family: 0/1 Up, 2/3 Front, 4/5 Right, 6/7 Back, and 8/9 Left. Even IDs are lowered and odd IDs are raised.", generic: true },
  { id: "player-gate", name: "Red Gate", description: "A two-state red player gate. State 0 is a lowered pass-through slab and state 1 is a raised gate cube. Its collision and trigger rules are awaiting authored tests.", generic: true },
  { id: "puncher", name: "Puncher", description: "A four-direction, two-state fixture. State 0 is unsprung and state 1 is sprung; its direction points outward from its supporting side face. Its launch and timing rules are awaiting authored tests.", generic: true },
  { id: "orange-button", name: "Orange Button", description: "A six-face pressure sensor with visible and editor-only invisible forms. Every independently pressed button lowers every Orange Wall by one additional unit.", generic: false },
  { id: "orange-wall", name: "Orange Wall", description: "One mechanism with visible and editor-only invisible wall forms. Both may share a cell with anything and store a nonnegative remaining-rise number.", generic: false },
  { id: "floating-floor", name: "Floating Floor", description: "A one-weight hovering platform. One can be pushed like a Sokoban box; after entering a Row-0 hole it stays suspended for that movement tick, then becomes permanent Floor on the next tick.", generic: false },
];

const DEFAULT_BLOCKS: BlockDefinition[] = [
  { id: "floor", name: "Limestone", color: "#D8CFC0", roleId: "floor", occupancy: "solid", visual: { kind: "cube" } },
  { id: "wall", name: "Basalt wall", color: "#424957", roleId: "solid", occupancy: "solid", visual: { kind: "cube" } },
  { id: "crate", name: "Amber crate", color: "#E9963A", roleId: "pushable", occupancy: "solid", visual: { kind: "cube" } },
  { id: "player", name: "Player", color: "#5A67D8", roleId: "player", occupancy: "solid", visual: { kind: "cube" } },
  { id: "ice", name: "Ice", color: "#72D7FF", roleId: "ice", occupancy: "solid", visual: { kind: "cube" } },
  { id: "ice-slope", name: "Ice slope", color: "#72D7FF", roleId: "ice", occupancy: "solid", visual: { kind: "slope" } },
  { id: "weightless-pushbox", name: "Weightless Pushbox", color: "#5E87D9", roleId: "weightless-pushable", occupancy: "solid", visual: { kind: "cube" } },
  { id: "blue-box-slope", name: "Blue box slope", color: "#5E87D9", roleId: "weightless-pushable", occupancy: "solid", visual: { kind: "slope" } },
  { id: "clone", name: "Clone", color: "#A0A244", roleId: "clone", occupancy: "solid", visual: { kind: "cube" } },
  { id: "yellow-clone-slope", name: "Yellow clone slope", color: "#A0A244", roleId: "clone", occupancy: "solid", visual: { kind: "slope" } },
  { id: "goal", name: "Gem collectible", color: "#48A985", roleId: "goal", occupancy: "sensor", visual: { kind: "gem", modelUrl: "/assets/objects/gem.glb" } },
  { id: "player-lift", name: "Player lift", color: "#8A63D2", roleId: "player-lift", occupancy: "sensor", genericMax: LIFT_GENERIC_MAX, visual: { kind: "lift" } },
  { id: "player-gate", name: "Red gate", color: "#C75652", roleId: "player-gate", occupancy: "sensor", genericMax: GATE_GENERIC_MAX, visual: { kind: "gate" } },
  { id: "puncher", name: "Puncher", color: "#EF4444", roleId: "puncher", occupancy: "sensor", genericMax: PUNCHER_GENERIC_MAX, variantMax: 3, visual: { kind: "puncher" } },
  { id: "orange-wall", name: "Orange wall", color: "#B85F16", roleId: "orange-wall", occupancy: "inactive", visual: { kind: "orange-wall", orangeForm: "visible" } },
  { id: "orange-wall-hidden", name: "Invisible orange wall", color: "#B85F16", roleId: "orange-wall", occupancy: "inactive", visual: { kind: "orange-wall", orangeForm: "hidden" } },
  { id: "orange-wall-slope", name: "Orange wall slope", color: "#B85F16", roleId: "orange-wall", occupancy: "inactive", visual: { kind: "slope", orangeForm: "visible" } },
  { id: "orange-wall-slope-hidden", name: "Invisible orange wall slope", color: "#B85F16", roleId: "orange-wall", occupancy: "inactive", visual: { kind: "slope", orangeForm: "hidden" } },
  { id: "orange-button", name: "Orange button", color: "#F59E0B", roleId: "orange-button", occupancy: "sensor", variantMax: 5, visual: { kind: "button", buttonForm: "visible" } },
  { id: "orange-button-hidden", name: "Invisible orange button", color: "#F59E0B", roleId: "orange-button", occupancy: "inactive", variantMax: 5, visual: { kind: "button", buttonForm: "hidden" } },
  { id: "floating-floor", name: "Floating floor", color: "#D6BD94", roleId: "floating-floor", occupancy: "solid", visual: { kind: "floating-floor" } },
];

const SLOPE_DIRECTION_OPTIONS = [
  { id: "up", label: "Up", glyph: "↑" },
  { id: "right", label: "Right", glyph: "→" },
  { id: "down", label: "Down", glyph: "↓" },
  { id: "left", label: "Left", glyph: "←" },
] as const;

function visualDefinitionForKind(kind: string): BlockVisualDefinition {
  if (kind === "gem") return { kind: "gem", modelUrl: "/assets/objects/gem.glb" };
  if (kind === "floating-floor") return { kind: "floating-floor" };
  if (kind === "gate") return { kind: "gate" };
  if (kind === "lift") return { kind: "lift" };
  if (kind === "puncher") return { kind: "puncher" };
  if (kind === "slope") return { kind: "slope" };
  if (kind === "button") return { kind: "button", buttonForm: "visible" };
  if (kind === "orange-wall") return { kind: "orange-wall", orangeForm: "visible" };
  return { kind: "cube" };
}

function binaryVisualState(block: BlockDefinition | undefined, value = 0) {
  if (block?.visual.kind === "lift") return liftIsRaised(value) ? 1 : 0;
  if (block?.visual.kind === "gate") return gateIsRaised(value) ? 1 : 0;
  if (block?.visual.kind === "puncher") return puncherIsSprung(value) ? 1 : 0;
  return null;
}

const DEFAULT_FOLDERS: TestFolder[] = [
  { collapsed: false, id: "general", locked: false, name: "Movement & walls" },
  { collapsed: false, id: "push-boxes", locked: false, name: "Push boxes" },
  { collapsed: false, id: "ice", locked: false, name: "Ice" },
];

function normalizeRoles(roles?: PhysicsRoleDefinition[]) {
  if (!roles?.length) return DEFAULT_ROLES.map((role) => ({ ...role }));
  const normalized = roles
    .filter((role) => role?.id)
    .map((role) => ({
      id: String(role.id),
      name: String(role.name ?? "").trim() || "Untitled role",
      description: String(role.description ?? ""),
      generic: role.id === "puncher" ? true : Boolean(role.generic),
    }));
  if (!normalized.some((role) => role.id === "player-lift")) {
    normalized.push({ ...DEFAULT_ROLES.find((role) => role.id === "player-lift")! });
  }
  for (const roleId of ["player-gate", "puncher", "orange-button", "orange-wall", "floating-floor"]) {
    if (!normalized.some((role) => role.id === roleId)) {
      normalized.push({ ...DEFAULT_ROLES.find((role) => role.id === roleId)! });
    }
  }
  return normalized.length ? normalized : DEFAULT_ROLES.map((role) => ({ ...role }));
}

function normalizeBlocks(
  blocks: StoredBlockDefinition[],
  roles: PhysicsRoleDefinition[],
): BlockDefinition[] {
  const roleIds = new Set(roles.map((role) => role.id));
  const fallbackRoleId = roleIds.has("solid") ? "solid" : roles[0].id;
  const normalized = blocks
    .filter((block, index) =>
      blocks.findIndex((candidate) => candidate.id === block.id) === index)
    .map((block): BlockDefinition => {
    const requestedRoleId = block.roleId ?? block.behavior ?? fallbackRoleId;
    const roleId = roleIds.has(requestedRoleId) ? requestedRoleId : fallbackRoleId;
    const visualKind = block.visual?.kind === "lift"
      ? "lift"
      : block.visual?.kind === "floating-floor" || roleId === "floating-floor"
      ? "floating-floor"
      : block.visual?.kind === "gate" || roleId === "player-gate"
      ? "gate"
      : block.visual?.kind === "puncher" || roleId === "puncher"
      ? "puncher"
      : block.visual?.kind === "slope"
      ? "slope"
      : block.visual?.kind === "button" || roleId === "orange-button"
        ? "button"
      : block.visual?.kind === "orange-wall" || roleId === "orange-wall"
        ? "orange-wall"
      : block.visual?.kind === "gem" || roleId === "goal"
        ? "gem"
        : "cube";
    return {
      id: block.id,
      name: block.name,
      color: block.color,
      roleId,
      ...(visualKind === "lift" || visualKind === "gate" || visualKind === "puncher"
        ? { genericMax: visualKind === "lift"
            ? LIFT_GENERIC_MAX
            : visualKind === "gate"
              ? GATE_GENERIC_MAX
              : PUNCHER_GENERIC_MAX }
        : Number.isInteger(block.genericMax) && Number(block.genericMax) >= 0
          ? { genericMax: Math.floor(Number(block.genericMax)) }
          : {}),
      ...(Number.isInteger(block.variantMax) && Number(block.variantMax) >= 0
        ? { variantMax: Math.floor(Number(block.variantMax)) }
        : {}),
      occupancy: normalizeOccupancyProfile(block.occupancy, roleId) as OccupancyProfile,
      visual: visualKind === "gem"
        ? { kind: "gem", modelUrl: block.visual?.modelUrl ?? "/assets/objects/gem.glb" }
        : visualKind === "floating-floor"
          ? { kind: "floating-floor" }
        : visualKind === "slope"
          ? {
              kind: "slope",
              ...(roleId === "orange-wall"
                ? { orangeForm: block.visual?.orangeForm === "hidden" ? "hidden" as const : "visible" as const }
                : {}),
            }
          : visualKind === "lift"
            ? { kind: "lift" }
          : visualKind === "gate"
            ? { kind: "gate" }
          : visualKind === "puncher"
            ? { kind: "puncher" }
          : visualKind === "button"
            ? {
                kind: "button",
                buttonForm: block.id === "orange-button-hidden" ||
                  block.visual?.buttonForm === "hidden" ? "hidden" : "visible",
              }
          : visualKind === "orange-wall"
            ? {
                kind: "orange-wall",
                orangeForm: block.id === "orange-wall-hidden" ||
                  block.visual?.orangeForm === "hidden" ? "hidden" : "visible",
              }
          : { kind: "cube" },
      };
    });
  if (roleIds.has("ice") && !normalized.some((block) =>
    block.roleId === "ice" && block.visual.kind === "slope")) {
    normalized.push({
      id: "ice-slope",
      name: "Ice slope",
      color: "#72D7FF",
      roleId: "ice",
      occupancy: "solid",
      visual: { kind: "slope" },
    });
  }
  if (roleIds.has("weightless-pushable") && !normalized.some((block) =>
    block.roleId === "weightless-pushable" && block.visual.kind === "slope")) {
    const boxIndex = normalized.findIndex((block) => block.roleId === "weightless-pushable");
    normalized.splice(boxIndex < 0 ? normalized.length : boxIndex + 1, 0, {
      id: normalized.some((block) => block.id === "blue-box-slope")
        ? "blue-box-slope-2"
        : "blue-box-slope",
      name: "Blue box slope",
      color: normalized.find((block) =>
        block.roleId === "weightless-pushable" && block.visual.kind === "cube")?.color ?? "#5E87D9",
      roleId: "weightless-pushable",
      occupancy: "solid",
      visual: { kind: "slope" },
    });
  }
  if (roleIds.has("clone") && !normalized.some((block) =>
    block.roleId === "clone" && block.visual.kind === "slope")) {
    const cloneIndex = normalized.findIndex((block) => block.roleId === "clone");
    normalized.splice(cloneIndex < 0 ? normalized.length : cloneIndex + 1, 0, {
      id: normalized.some((block) => block.id === "yellow-clone-slope")
        ? "yellow-clone-slope-2"
        : "yellow-clone-slope",
      name: "Yellow clone slope",
      color: normalized.find((block) =>
        block.roleId === "clone" && block.visual.kind === "cube")?.color ?? "#A0A244",
      roleId: "clone",
      occupancy: "solid",
      visual: { kind: "slope" },
    });
  }
  if (roleIds.has("player-lift") && !normalized.some((block) => block.roleId === "player-lift")) {
    normalized.push({
      id: "player-lift",
      name: "Player lift",
      color: "#8A63D2",
      roleId: "player-lift",
      occupancy: "sensor",
      genericMax: LIFT_GENERIC_MAX,
      visual: { kind: "lift" },
    });
  }
  if (roleIds.has("player-gate") && !normalized.some((block) => block.roleId === "player-gate")) {
    normalized.push({
      id: "player-gate",
      name: "Red gate",
      color: "#C75652",
      roleId: "player-gate",
      occupancy: "sensor",
      genericMax: GATE_GENERIC_MAX,
      visual: { kind: "gate" },
    });
  }
  if (roleIds.has("puncher") && !normalized.some((block) => block.roleId === "puncher")) {
    normalized.push({
      id: "puncher",
      name: "Puncher",
      color: "#EF4444",
      roleId: "puncher",
      occupancy: "sensor",
      genericMax: PUNCHER_GENERIC_MAX,
      variantMax: 3,
      visual: { kind: "puncher" },
    });
  }
  if (roleIds.has("floating-floor") && !normalized.some((block) => block.roleId === "floating-floor")) {
    normalized.push({
      id: "floating-floor",
      name: "Floating floor",
      color: "#D6BD94",
      roleId: "floating-floor",
      occupancy: "solid",
      visual: { kind: "floating-floor" },
    });
  }
  const mechanismDefinitions: BlockDefinition[] = [];
  if (roleIds.has("orange-wall")) {
    const visible = normalized.find((block) =>
      block.roleId === "orange-wall" && block.visual.kind !== "slope" &&
      block.visual.orangeForm !== "hidden");
    const hidden = normalized.find((block) =>
      block.roleId === "orange-wall" && block.visual.kind !== "slope" &&
      block.visual.orangeForm === "hidden");
    const visibleSlope = normalized.find((block) =>
      block.roleId === "orange-wall" && block.visual.kind === "slope" &&
      block.visual.orangeForm !== "hidden");
    const hiddenSlope = normalized.find((block) =>
      block.roleId === "orange-wall" && block.visual.kind === "slope" &&
      block.visual.orangeForm === "hidden");
    mechanismDefinitions.push({
      id: "orange-wall",
      name: visible?.name ?? "Orange wall",
      color: visible?.color ?? "#B85F16",
      roleId: "orange-wall",
      occupancy: "inactive",
      visual: { kind: "orange-wall", orangeForm: "visible" },
    }, {
      id: "orange-wall-hidden",
      name: hidden?.name ?? "Invisible orange wall",
      color: hidden?.color ?? visible?.color ?? "#B85F16",
      roleId: "orange-wall",
      occupancy: "inactive",
      visual: { kind: "orange-wall", orangeForm: "hidden" },
    }, {
      id: "orange-wall-slope",
      name: visibleSlope?.name ?? "Orange wall slope",
      color: visibleSlope?.color ?? visible?.color ?? "#B85F16",
      roleId: "orange-wall",
      occupancy: "inactive",
      visual: { kind: "slope", orangeForm: "visible" },
    }, {
      id: "orange-wall-slope-hidden",
      name: hiddenSlope?.name ?? "Invisible orange wall slope",
      color: hiddenSlope?.color ?? visibleSlope?.color ?? visible?.color ?? "#B85F16",
      roleId: "orange-wall",
      occupancy: "inactive",
      visual: { kind: "slope", orangeForm: "hidden" },
    });
  }
  if (roleIds.has("orange-button")) {
    const visible = normalized.find((block) =>
      block.roleId === "orange-button" && block.visual.buttonForm !== "hidden");
    const hidden = normalized.find((block) =>
      block.roleId === "orange-button" && block.visual.buttonForm === "hidden");
    mechanismDefinitions.push({
      id: "orange-button",
      name: visible?.name ?? "Orange button",
      color: visible?.color ?? "#F59E0B",
      roleId: "orange-button",
      occupancy: "sensor",
      variantMax: 5,
      visual: { kind: "button", buttonForm: "visible" },
    }, {
      id: "orange-button-hidden",
      name: hidden?.name ?? "Invisible orange button",
      color: hidden?.color ?? visible?.color ?? "#F59E0B",
      roleId: "orange-button",
      occupancy: "inactive",
      variantMax: 5,
      visual: { kind: "button", buttonForm: "hidden" },
    });
  }
  const collapsed = normalized.filter((block) =>
    block.roleId !== "orange-wall" && block.roleId !== "orange-button");
  collapsed.push(...mechanismDefinitions);
  const familyCubeColors = new Map(
    ["weightless-pushable", "clone"].flatMap((roleId) => {
      const cube = normalized.find((block) =>
        block.roleId === roleId && block.visual.kind === "cube");
      return cube ? [[roleId, cube.color] as const] : [];
    }),
  );
  return collapsed.map((block) => {
    const familyColor = familyCubeColors.get(block.roleId);
    return block.visual.kind === "slope" && familyColor
      ? { ...block, color: familyColor }
      : block;
  });
}

function nonnegativeInteger(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeFolders(folders?: StoredTestFolder[]) {
  const sourceFolders = folders?.length ? folders : DEFAULT_FOLDERS;
  const seen = new Set<string>();
  const normalized = sourceFolders.flatMap((folder) => {
    const id = String(folder?.id ?? "").trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const parentId = String(folder.parentId ?? "").trim();
    return [{
      collapsed: Boolean(folder.collapsed),
      ...(folder.default ? { default: true } : {}),
      id,
      locked: false,
      name: String(folder.name ?? "").trim() || "Untitled tag",
      ...(parentId ? { parentId } : {}),
    }];
  });
  if (!normalized.length) return [];

  const foldersById = new Map(normalized.map((folder) => [folder.id, folder]));
  const validated = normalized.map((folder) => {
    if (!folder.parentId || folder.parentId === folder.id || !foldersById.has(folder.parentId)) {
      const rootFolder = { ...folder };
      delete rootFolder.parentId;
      return rootFolder;
    }
    const visited = new Set([folder.id]);
    let cursor: TestFolder | undefined = foldersById.get(folder.parentId);
    while (cursor) {
      if (visited.has(cursor.id)) {
        const rootFolder = { ...folder };
        delete rootFolder.parentId;
        return rootFolder;
      }
      visited.add(cursor.id);
      cursor = cursor.parentId ? foldersById.get(cursor.parentId) : undefined;
    }
    return folder;
  });
  return ensureDefaultSubtags(flattenSubtags(validated)) as TestFolder[];
}

function normalizeGenericIds(
  frame: Frame,
  blocks: BlockDefinition[],
  roles: PhysicsRoleDefinition[],
  legacyBlocks: StoredBlockDefinition[] = [],
): Frame {
  const genericRoleIds = new Set(roles.filter((role) => role.generic).map((role) => role.id));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const floorBlockIds = new Set(blocks.filter((block) => block.roleId === "floor").map((block) => block.id));
  const legacyIds = new Map(legacyBlocks.map((block) => [block.id, block.genericId]));
  const legacyDefinitions = new Map(legacyBlocks.map((block) => [block.id, block]));
  const normalized = {
    voxels: enforceFloorLayer(frame.voxels, floorBlockIds).map((storedVoxel: Voxel) => {
      const legacy = legacyDefinitions.get(storedVoxel.blockId);
      const legacyRoleId = legacy?.roleId ?? legacy?.behavior;
      const legacyOrangeForm = legacy?.visual?.orangeForm;
      const legacyButtonForm = legacy?.visual?.buttonForm;
      const isOrangeSlope = storedVoxel.blockId === "orange-wall-slope" ||
        storedVoxel.blockId === "orange-wall-slope-hidden" ||
        (legacyRoleId === "orange-wall" && legacy?.visual?.kind === "slope");
      const canonicalBlockId = isOrangeSlope
        ? legacyOrangeForm === "hidden" || storedVoxel.blockId === "orange-wall-slope-hidden" ||
          Number(storedVoxel.stateId) === 2
          ? "orange-wall-slope-hidden" : "orange-wall-slope"
        : storedVoxel.blockId === "orange-wall-hidden" ||
        legacyOrangeForm === "hidden" ||
        (legacyRoleId === "orange-wall" && Number(storedVoxel.stateId) === 2)
        ? "orange-wall-hidden"
        : storedVoxel.blockId === "orange-wall-face" || legacyRoleId === "orange-wall"
          ? "orange-wall"
          : storedVoxel.blockId === "orange-button-hidden" || legacyButtonForm === "hidden"
            ? "orange-button-hidden"
            : legacyRoleId === "orange-button"
              ? "orange-button"
              : storedVoxel.blockId;
      const voxel = canonicalBlockId === storedVoxel.blockId
        ? storedVoxel
        : { ...storedVoxel, blockId: canonicalBlockId };
      const block = blocksById.get(voxel.blockId);
      const instanceId = String(voxel.instanceId ?? "").trim();
      const orientation = String(voxel.orientation ?? "").trim();
      const base: Voxel = {
        ...voxel,
        ...(instanceId ? { instanceId } : {}),
        ...(voxel.mechanismDepth === undefined ? {} : { mechanismDepth: nonnegativeInteger(voxel.mechanismDepth) }),
        ...(orientation ? { orientation } : {}),
        ...(voxel.stateId === undefined ? {} : { stateId: nonnegativeInteger(voxel.stateId) }),
        ...(voxel.variantId === undefined ? {} : { variantId: nonnegativeInteger(voxel.variantId) }),
      };
      if (block?.visual.kind === "button") return { ...base, stateId: 0 };
      if (block && genericRoleIds.has(block.roleId)) {
        let value = Math.min(
          block.genericMax ?? 2147483647,
          nonnegativeInteger(
            voxel.groupId ?? voxel.genericId ?? legacyIds.get(voxel.blockId),
          ),
        );
        // Migrate the brief split-state lift representation without changing
        // any layout: an explicit side orientation plus old state 0/1 becomes
        // its equivalent combined 2–9 ID.
        if (block.visual.kind === "lift" && value <= 1) {
          const legacyOrientation = normalizeLiftOrientation(voxel.orientation, voxel.variantId);
          if (legacyOrientation !== "top") {
            value = liftGenericId(legacyOrientation, liftIsRaised(value));
          }
        }
        return {
          ...base,
          genericId: value,
          ...(voxel.groupId === undefined ? {} : { groupId: value }),
        };
      }
      const groupId = Number.isInteger(voxel.groupId) && Number(voxel.groupId) >= 0
        ? Number(voxel.groupId)
        : undefined;
      return groupId === undefined ? base : { ...base, groupId };
    }),
  };
  return normalizeOrangeWallFrame(normalized, blocksById) as Frame;
}

function setGenericModeForBlocks(
  frame: Frame,
  blockIds: ReadonlySet<string>,
  generic: boolean,
): Frame {
  return {
    voxels: frame.voxels.map((voxel) => {
      if (!blockIds.has(voxel.blockId)) return { ...voxel };
      return generic
        ? {
          ...voxel,
          genericId: nonnegativeInteger(voxel.groupId ?? voxel.genericId),
          groupId: nonnegativeInteger(voxel.groupId ?? voxel.genericId),
        }
        : { ...voxel, genericId: undefined };
    }),
  };
}

function enforceFloorModeForBlocks(
  frame: Frame,
  blockIds: ReadonlySet<string>,
  floor: boolean,
): Frame {
  if (!floor) return frame;
  return {
    voxels: frame.voxels.filter((voxel) => !blockIds.has(voxel.blockId) || voxel.z === 0),
  };
}

function normalizeTests(
  tests: StoredTestCase[],
  folders: TestFolder[],
  blocks: BlockDefinition[],
  roles: PhysicsRoleDefinition[],
  legacyBlocks: StoredBlockDefinition[] = [],
  legacyWorld: WorldSettings = DEFAULT_WORLD,
): TestCase[] {
  const folderIds = new Set(folders.map((folder) => folder.id));
  const fallbackFolderId = folderIds.has("general") ? "general" : folders[0].id;
  return tests.map((test) => {
    const world = normalizeWorld(test.world ?? legacyWorld);
    const legacyFolderId = test.folderId && folderIds.has(test.folderId)
      ? test.folderId
      : fallbackFolderId;
    const directTagIds = [...new Set((test.tagIds ?? [])
      .map((tagId) => String(tagId))
      .filter((tagId) => folderIds.has(tagId)))];
    if (!directTagIds.length) directTagIds.push(legacyFolderId);
    const placement = normalizeTestTagPlacement({
      directTagIds,
      preferredTagId: legacyFolderId,
    }, folders);
    return cropTestToWorld({
      ...test,
      description: String(test.description ?? ""),
      folderId: placement.groupTagId,
      hidden: Boolean(test.hidden),
      tagIds: placement.tagIds,
      locked: Boolean(test.locked),
      intermediate: (test.intermediate ?? []).map((frame) =>
        normalizeGenericIds(frame, blocks, roles, legacyBlocks)),
      cycle: normalizeCycleExpectation(test.cycle, test.intermediate?.length ?? 0) ?? undefined,
      start: normalizeGenericIds(test.start, blocks, roles, legacyBlocks),
      expected: normalizeGenericIds(test.expected, blocks, roles, legacyBlocks),
      world,
    });
  });
}

async function normalizeTestsInBatches(...[tests, ...settings]: Parameters<typeof normalizeTests>) {
  const normalized: TestCase[] = [];
  let started = performance.now();
  for (let index = 0; index < tests.length; index += 8) {
    normalized.push(...normalizeTests(tests.slice(index, index + 8), ...settings));
    if (performance.now() - started >= 8) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      started = performance.now();
    }
  }
  return normalized;
}

function keyOf(voxel: Pick<Voxel, "x" | "y" | "z">) {
  return `${voxel.x},${voxel.y},${voxel.z}`;
}

function newInstanceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `object:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const DEFAULT_WORLD: WorldSettings = { width: 16, height: 16, floorLayer: 0 };

function floorFrame(width = DEFAULT_WORLD.width, height = DEFAULT_WORLD.height): Voxel[] {
  const voxels: Voxel[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      voxels.push({ x, y, z: 0, blockId: x === 5 && y === 3 ? "goal" : "floor" });
    }
  }
  return voxels;
}

function defaultRoomFloor(width: number, height: number): Frame {
  return {
    voxels: Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x): Voxel => ({ x, y, z: 0, blockId: "floor" })),
    ).flat(),
  };
}

function withActors(actors: Voxel[]) {
  return { voxels: [...floorFrame(), ...actors] };
}

function withIceStrip(actors: Voxel[]) {
  const iceRows = new Set([1, 2, 3]);
  return {
    voxels: [
      ...floorFrame().map((voxel) =>
        voxel.x === 2 && iceRows.has(voxel.y) ? { ...voxel, blockId: "ice" } : voxel),
      ...actors,
    ],
  };
}

const DEFAULT_TESTS: StoredTestCase[] = [
  {
    description: "Moving Up pushes the single crate one cell onto the goal, and the player occupies the crate's previous cell.",
    folderId: "push-boxes",
    id: "push-one",
    hidden: false,
    locked: false,
    name: "Push crate onto goal",
    input: "up",
    intermediate: [],
    world: { ...DEFAULT_WORLD },
    start: withActors([
      { x: 5, y: 5, z: 1, blockId: "player" },
      { x: 5, y: 4, z: 1, blockId: "crate" },
    ]),
    expected: withActors([
      { x: 5, y: 4, z: 1, blockId: "player" },
      { x: 5, y: 3, z: 1, blockId: "crate" },
    ]),
  },
  {
    description: "Moving Up into the basalt wall changes nothing; both the player and wall remain in their starting cells.",
    folderId: "general",
    id: "wall-stop",
    hidden: false,
    locked: false,
    name: "Wall blocks movement",
    input: "up",
    intermediate: [],
    world: { ...DEFAULT_WORLD },
    start: withActors([
      { x: 2, y: 3, z: 1, blockId: "player" },
      { x: 2, y: 2, z: 1, blockId: "wall" },
    ]),
    expected: withActors([
      { x: 2, y: 3, z: 1, blockId: "player" },
      { x: 2, y: 2, z: 1, blockId: "wall" },
    ]),
  },
  {
    description: "Moving Up cannot push two adjacent crates, so the player and both crates remain unchanged.",
    folderId: "push-boxes",
    id: "double-crate",
    hidden: false,
    locked: false,
    name: "Two crates cannot be pushed",
    input: "up",
    intermediate: [],
    world: { ...DEFAULT_WORLD },
    start: withActors([
      { x: 4, y: 5, z: 1, blockId: "player" },
      { x: 4, y: 4, z: 1, blockId: "crate" },
      { x: 4, y: 3, z: 1, blockId: "crate" },
    ]),
    expected: withActors([
      { x: 4, y: 5, z: 1, blockId: "player" },
      { x: 4, y: 4, z: 1, blockId: "crate" },
      { x: 4, y: 3, z: 1, blockId: "crate" },
    ]),
  },
  {
    description: "One Up command carries the player across every contiguous Ice tile and stops on the normal floor beyond the strip.",
    folderId: "ice",
    id: "future-ice",
    hidden: false,
    locked: false,
    name: "Ice continues one command",
    input: "up",
    intermediate: [],
    world: { ...DEFAULT_WORLD },
    start: withIceStrip([{ x: 2, y: 4, z: 1, blockId: "player" }]),
    expected: withIceStrip([{ x: 2, y: 0, z: 1, blockId: "player" }]),
  },
];

function cloneFrame(frame: Frame): Frame {
  return { voxels: frame.voxels.map((voxel) => ({ ...voxel })) };
}

function editableFrame(
  test: TestCase,
  frameKind: FrameKind,
  intermediateIndex: number | null,
) {
  return intermediateIndex === null
    ? test[frameKind]
    : test.intermediate[intermediateIndex] ?? test.expected;
}

function replaceEditableFrame(
  test: TestCase,
  frameKind: FrameKind,
  intermediateIndex: number | null,
  frame: Frame,
): TestCase {
  if (intermediateIndex === null) return { ...test, [frameKind]: frame };
  const intermediate = [...test.intermediate];
  intermediate[intermediateIndex] = frame;
  return { ...test, intermediate };
}

function clampWorldDimension(value: number) {
  return Math.min(32, Math.max(3, Math.round(Number.isFinite(value) ? value : 3)));
}

function normalizeWorld(world: WorldSettings): WorldSettings {
  return {
    width: clampWorldDimension(world.width),
    height: clampWorldDimension(world.height),
    floorLayer: 0,
  };
}

function cropFrameToWorld(frame: Frame, world: WorldSettings): Frame {
  return { voxels: cropVoxelsToWorld(frame.voxels, world) };
}

function cropTestToWorld(test: TestCase, world: WorldSettings = test.world): TestCase {
  return applyWorldToTest({ ...test, input: "up" }, world) as TestCase;
}

function DirectionIcon({ direction }: { direction: Direction }) {
  return <span aria-hidden="true">{{ up: "↑", down: "↓", left: "←", right: "→" }[direction]}</span>;
}

function FailureTraceComparison({
  blocks,
  genericBlockIds,
  layer,
  onClose,
  result,
}: {
  blocks: BlockDefinition[];
  genericBlockIds: Set<string>;
  layer: number;
  onClose: () => void;
  result: TestResult;
}) {
  const representativeIndex = Math.max(
    0,
    result.checks.findIndex((check) => check.rotation === result.rotation),
  );
  const [checkIndex, setCheckIndex] = useState(representativeIndex);
  const [traceIndex, setTraceIndex] = useState(
    result.checks[representativeIndex].firstMismatchFrame ??
      result.checks[representativeIndex].trace.length - 1,
  );

  useEffect(() => {
    const nextCheckIndex = Math.max(
      0,
      result.checks.findIndex((check) => check.rotation === result.rotation),
    );
    const nextCheck = result.checks[nextCheckIndex];
    // A different engine result starts at its representative mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCheckIndex(nextCheckIndex);
    setTraceIndex(nextCheck.firstMismatchFrame ?? nextCheck.trace.length - 1);
  }, [result]);

  const check = result.checks[checkIndex];
  const frameIndex = Math.min(traceIndex, check.trace.length - 1);
  const frame = check.trace[frameIndex];
  const mismatchFrames = check.trace.flatMap((entry, index) => entry.pass ? [] : [index]);
  const expectedCount = check.trace.filter((entry) => entry.expectedPresent).length;
  const differenceCount = frame.missing.length + frame.unexpected.length;
  const label = traceFrameLabel(frameIndex, expectedCount);

  const chooseRotation = (index: number) => {
    const nextCheck = result.checks[index];
    setCheckIndex(index);
    setTraceIndex(nextCheck.firstMismatchFrame ?? nextCheck.trace.length - 1);
  };

  const jumpToNextMismatch = () => {
    if (!mismatchFrames.length) return;
    setTraceIndex(
      mismatchFrames.find((index) => index > frameIndex) ?? mismatchFrames[0],
    );
  };

  return (
    <div className="result-console result-console--trace failed" role="dialog" aria-label="C++ engine trace differences">
      <div className="result-heading">
        <div className="result-mark">!</div>
        <div>
          <span>C++ ENGINE TRACE · {check.rotation}° · {check.input.toUpperCase()}</span>
          <h3>{frame.pass ? "This frame matches" : `${differenceCount} voxel difference${differenceCount === 1 ? "" : "s"}`} · {label}</h3>
        </div>
        <button aria-label="Close comparison" onClick={onClose}>×</button>
      </div>
      {check.cycleDifference && <p className="trace-cycle-difference" role="status">{check.cycleDifference}</p>}
      <div className="trace-navigation">
        <div className="trace-rotations" role="group" aria-label="Rotation trace">
          {result.checks.map((rotationCheck, index) => (
            <button
              className={`${index === checkIndex ? "active" : ""} ${rotationCheck.pass ? "passed" : "failed"}`}
              key={rotationCheck.rotation}
              onClick={() => chooseRotation(index)}
              type="button"
            >
              {rotationCheck.rotation}° <span>{rotationCheck.pass ? "✓" : "!"}</span>
            </button>
          ))}
        </div>
        <div className="trace-pager">
          <button type="button" aria-label="Previous comparison frame" disabled={frameIndex === 0} onClick={() => setTraceIndex(frameIndex - 1)}>←</button>
          <strong>{label}<span>{frameIndex + 1} / {check.trace.length}</span></strong>
          <button type="button" aria-label="Next comparison frame" disabled={frameIndex === check.trace.length - 1} onClick={() => setTraceIndex(frameIndex + 1)}>→</button>
        </div>
        {mismatchFrames.length > 1 && <button className="next-mismatch-button" type="button" onClick={jumpToNextMismatch}>Next difference</button>}
      </div>
      <div className="compare-grid">
        <div className={`compare-card ${frame.expectedPresent ? "" : "missing-frame"}`}>
          <div><strong>EXPECTED · {label.toUpperCase()} · {check.rotation}°</strong><span>{!frame.expectedPresent ? "no authored frame" : frame.missing.length ? `${frame.missing.length} missing` : "match"}</span></div>
          <MazeBenchCanvas frame={frame.expected} blocks={blocks} genericBlockIds={genericBlockIds} world={check.world} layer={layer} compact />
        </div>
        <div className={`compare-card ${frame.actualPresent ? "" : "missing-frame"}`}>
          <div><strong>ENGINE OUTPUT · {frameIndex === 0 ? "START" : `TICK ${frameIndex}`} · <DirectionIcon direction={check.input} /></strong><span>{!frame.actualPresent ? "engine stopped" : frame.unexpected.length ? `${frame.unexpected.length} unexpected` : "match"}</span></div>
          <MazeBenchCanvas frame={frame.actual} blocks={blocks} genericBlockIds={genericBlockIds} world={check.world} layer={layer} compact />
        </div>
      </div>
    </div>
  );
}

function TestWorldEditor({
  locked,
  onSave,
  test,
}: {
  locked: boolean;
  onSave: (width: number, height: number) => void;
  test: TestCase;
}) {
  const [widthDraft, setWidthDraft] = useState(String(test.world.width));
  const [heightDraft, setHeightDraft] = useState(String(test.world.height));
  const [error, setError] = useState("");

  const cancel = () => {
    setWidthDraft(String(test.world.width));
    setHeightDraft(String(test.world.height));
    setError("");
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const width = parseWorldDimensionDraft(widthDraft);
    const height = parseWorldDimensionDraft(heightDraft);
    if (width === null || height === null) {
      setError("Width and depth must be whole numbers from 3 to 32.");
      return;
    }
    setError("");
    onSave(width, height);
  };

  return (
    <form className="dimension-editor" onSubmit={save}>
      <div className="dimension-grid">
        <label className="field"><span>Width · X</span><input aria-label="Test room width draft" aria-describedby={error ? "dimension-draft-error" : undefined} aria-invalid={Boolean(error)} type="text" inputMode="numeric" autoComplete="off" disabled={locked} value={widthDraft} onChange={(event) => { setWidthDraft(event.target.value); setError(""); }} /></label>
        <label className="field"><span>Depth · Y</span><input aria-label="Test room depth draft" aria-describedby={error ? "dimension-draft-error" : undefined} aria-invalid={Boolean(error)} type="text" inputMode="numeric" autoComplete="off" disabled={locked} value={heightDraft} onChange={(event) => { setHeightDraft(event.target.value); setError(""); }} /></label>
      </div>
      {error && <p className="dimension-error" id="dimension-draft-error" role="alert">{error}</p>}
      <div className="dimension-actions">
        <button className="tool-button" type="button" disabled={locked} onClick={cancel}>Cancel</button>
        <button className="tool-button tool-button--primary" type="submit" disabled={locked}>Save dimensions</button>
      </div>
    </form>
  );
}

function cameraLayerRangeForFrames(frames: Frame[]) {
  let minimum = 0;
  let maximum = 0;
  frames.forEach((frame) => frame.voxels.forEach((voxel) => {
    minimum = Math.min(minimum, voxel.z);
    maximum = Math.max(maximum, voxel.z);
  }));
  return { minimum, maximum };
}

function TimelineSnapshotStrip({
  blocks,
  cycle,
  final,
  frames,
  genericBlockIds,
  layer,
  start,
  world,
}: {
  blocks: BlockDefinition[];
  cycle?: CycleExpectation;
  final: Frame;
  frames: Frame[];
  genericBlockIds: ReadonlySet<string>;
  layer: number;
  start: Frame;
  world: WorldSettings;
}) {
  const items = frames.length
    ? [{ frame: start, label: "START" }, ...frames.map((frame, index) => ({
      frame,
      label: cycle && index + 1 > cycle.repeatTick
        ? "ROLLBACK"
        : `TICK ${index + 1}`,
    }))]
    : [{ frame: start, label: "START" }, { frame: final, label: "FINAL" }];
  const cameraLayerRange = cameraLayerRangeForFrames(items.map((item) => item.frame));
  const [snapshots, setSnapshots] = useState<Array<string | undefined>>([]);
  const [captureIndex, setCaptureIndex] = useState(0);
  const capture = items[captureIndex];
  const acceptSnapshot = useCallback((dataUrl: string) => {
    setSnapshots((current) => {
      const next = [...current];
      next[captureIndex] = dataUrl;
      return next;
    });
    setCaptureIndex((current) => current + 1);
  }, [captureIndex]);

  return (
    <div className="timeline-review__strip">
      {capture && (
        <div className="timeline-review__capture" aria-hidden="true">
          <MazeBenchCanvas
            cameraLayerRange={cameraLayerRange}
            cameraSceneKey="generated-timeline"
            frame={capture.frame}
            blocks={blocks}
            genericBlockIds={genericBlockIds}
            world={world}
            layer={layer}
            compact
            onSnapshot={acceptSnapshot}
            snapshotRequestId={captureIndex}
          />
        </div>
      )}
      {items.map((item, index) => (
        <article className={`timeline-review__card ${tickIsInCycle(cycle, index) ? "cycle-span" : ""} ${cycle?.startTick === index ? "cycle-start" : ""} ${cycle?.repeatTick === index ? "cycle-repeat" : ""}`} key={`${item.label}-${index}`}>
          <small>{item.label}</small>
          {snapshots[index] ? (
            // Data URLs are generated locally from the shared sequential
            // WebGL capture; an image optimizer cannot improve this source.
            // eslint-disable-next-line @next/next/no-img-element
            <img alt={`${item.label.toLowerCase()} voxel preview`} draggable={false} src={snapshots[index]} />
          ) : (
            <span className={`timeline-review__snapshot-status ${snapshots[index] === "" ? "failed" : ""}`}>
              {snapshots[index] === "" ? "Preview unavailable" : "Rendering…"}
            </span>
          )}
        </article>
      ))}
    </div>
  );
}

function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d={open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
    </svg>
  );
}

function VisibilityIcon({ hidden = false }: { hidden?: boolean }) {
  return (
    <svg className="visibility-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {hidden && <path d="m3 3 18 18" />}
    </svg>
  );
}

function suitePreviewKey(testId: string, frameIndex: number) {
  return JSON.stringify([testId, frameIndex]);
}

function suitePreviewFrames(test: TestCase) {
  return [test.start, ...test.intermediate, test.expected];
}

function SuiteTestPreview({
  cameraGeneration,
  onOpen,
  onRequest,
  previews,
  test,
}: {
  cameraGeneration: number;
  onOpen: () => void;
  onRequest: (testId: string, frameIndex: number) => void;
  previews: Readonly<Record<string, { dataUrl: string; generation: number }>>;
  test: TestCase;
}) {
  const [frameIndex, setFrameIndex] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const frames = suitePreviewFrames(test);
  const image = previews[suitePreviewKey(test.id, frameIndex)];
  const preview = image?.dataUrl;
  const isCurrent = image?.generation === cameraGeneration;
  const frameLabel = frameIndex === 0
    ? "Start"
    : frameIndex === frames.length - 1
      ? "Expected"
      : `Tick ${frameIndex}`;

  useEffect(() => {
    const element = previewRef.current;
    if (!element || isCurrent) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      onRequest(test.id, frameIndex);
      observer.disconnect();
    }, { rootMargin: "240px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cameraGeneration, frameIndex, isCurrent, onRequest, test.id]);

  return (
    <div ref={previewRef} className="suite-test-preview" aria-busy={!isCurrent} data-camera-generation={image?.generation}>
      <button className="suite-test-preview__scene" type="button" aria-label={`Open ${test.name} from its ${frameLabel.toLowerCase()} 3D preview`} onClick={onOpen}>
        {preview ? (
          // Generated locally from the shared, serialized WebGL renderer.
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={`${test.name} ${frameLabel.toLowerCase()} frame`} draggable={false} src={preview} />
        ) : <span className={preview === "" ? "is-unavailable" : ""}>{preview === "" ? "Preview unavailable" : "Rendering 3D…"}</span>}
      </button>
      <div className="suite-test-preview__pager" aria-label={`${test.name} preview timeline`}>
        <button type="button" disabled={frameIndex === 0} aria-label={`Previous preview frame for ${test.name}`} onClick={() => setFrameIndex((current) => Math.max(0, current - 1))}>←</button>
        <strong>{frameLabel}<span>{frameIndex + 1}/{frames.length}</span></strong>
        <button type="button" disabled={frameIndex === frames.length - 1} aria-label={`Next preview frame for ${test.name}`} onClick={() => setFrameIndex((current) => Math.min(frames.length - 1, current + 1))}>→</button>
      </div>
    </div>
  );
}

function folderPathLabel(folders: TestFolder[], folderId: string) {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  const visited = new Set<string>();
  let cursor = foldersById.get(folderId);
  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    names.unshift(cursor.name);
    cursor = cursor.parentId ? foldersById.get(cursor.parentId) : undefined;
  }
  return names.join(" / ") || "Unknown tag";
}

function TestTagPicker({
  folders,
  folderPaths,
  onChangeGroup,
  onToggle,
  test,
}: {
  folders: TestFolder[];
  folderPaths: ReadonlyMap<string, string>;
  onChangeGroup: (groupTagId: string) => void;
  onToggle: (tagId: string) => void;
  test: TestCase;
}) {
  const tagsById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const groups = folders.filter((folder) => !folder.parentId);
  const subtags = folders.filter((folder) => folder.parentId === test.folderId);
  const groupName = tagsById.get(test.folderId)?.name ?? "Unknown group";
  return (
    <details className="test-tag-picker">
      <summary><span><b>{groupName}</b> · {test.tagIds.map((tagId) => tagsById.get(tagId)?.name ?? "Unknown subtag").join(" + ")}</span><i aria-hidden="true">▾</i></summary>
      <div className="test-tag-picker__menu">
        <label className="test-tag-picker__group">
          <span>Parent group</span>
          <select aria-label={`Parent tag group for ${test.name}`} value={test.folderId} onChange={(event) => onChangeGroup(event.target.value)}>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <div className="test-tag-picker__divider"><span>Subtags</span><small>Choose any within this group</small></div>
        {subtags.map((folder) => {
          const checked = test.tagIds.includes(folder.id);
          const disabled = Boolean(folder.default && checked && test.tagIds.length === 1);
          return (
            <label key={folder.id}>
              <input type="checkbox" checked={checked} disabled={disabled} onChange={() => onToggle(folder.id)} />
              <span>{folderPaths.get(folder.id) ?? folder.name}</span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

type TagCombinationAlias = {
  groupTagId: string;
  id: string;
  label: string;
  tagIds: string[];
};

function SuiteGroupStatus({ label, summary }: {
  label: string;
  summary: ReturnType<typeof summarizeTestResults>;
}) {
  const description = summary.state === "empty"
    ? "No active tests"
    : `${summary.passed}/${summary.active} passing${summary.failed ? ` · ${summary.failed} failing` : ""}${summary.pending ? ` · ${summary.pending} not run` : ""}`;
  const tooltip = `${label}: ${description}${summary.hidden ? ` · ${summary.hidden} hidden / ignored` : ""}`;
  return <span className={`suite-group-status is-${summary.state}`} role="img" aria-label={tooltip} title={tooltip}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {summary.state === "pass" ? <path d="m4 10 4 4 8-8" />
        : summary.state === "fail" ? <path d="m5 5 10 10M15 5 5 15" />
          : summary.state === "pending" ? <circle cx="10" cy="10" r="5" strokeWidth="1.5" />
            : <path d="M6 10h8" strokeWidth="1.5" />}
    </svg>
  </span>;
}

function TestSuiteWorkspace({
  activeId,
  blocks,
  folders,
  genericBlockIds,
  onAddFolder,
  onAddTest,
  onDeleteFolder,
  onDeleteTest,
  onDuplicateTest,
  onChangeTestGroup,
  onToggleTestTag,
  onOpenTest,
  onRenameFolder,
  onReorderTest,
  onRunTest,
  onToggleTestHidden,
  onToggleTestLocked,
  onUpdateTest,
  results,
  tests,
}: {
  activeId: string;
  blocks: BlockDefinition[];
  folders: TestFolder[];
  genericBlockIds: ReadonlySet<string>;
  onAddFolder: (name: string, parentId?: string) => void;
  onAddTest: (folderId?: string, tagIds?: string[]) => void;
  onDeleteFolder: (folderId: string) => void;
  onDeleteTest: (testId: string) => void;
  onDuplicateTest: (testId: string) => void;
  onChangeTestGroup: (testId: string, groupTagId: string) => void;
  onToggleTestTag: (testId: string, tagId: string) => void;
  onOpenTest: (testId: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onReorderTest: (testId: string, targetTestId: string) => void;
  onRunTest: (test: TestCase) => void;
  onToggleTestHidden: (testId: string) => void;
  onToggleTestLocked: (testId: string) => void;
  onUpdateTest: (testId: string, patch: Partial<Pick<TestCase, "name" | "description">>) => void;
  results: Record<string, TestResult>;
  tests: TestCase[];
}) {
  const activeTest = tests.find((test) => test.id === activeId);
  const [requestedFolderId, setSelectedFolderId] = useState<string | null>(activeTest?.folderId ?? null);
  const [query, setQuery] = useState("");
  const [folderQuery, setFolderQuery] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(activeTest ? [activeTest.folderId] : []));
  const visibleFolderIds = useMemo(() => matchingFolderIds(folders, folderQuery), [folders, folderQuery]);
  const toggleExpandedFolder = (id: string) => setExpandedFolders(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [statusFilter, setStatusFilter] = useState<"all" | "failed" | "hidden" | "passed" | "untested">("all");
  const [sortOrder, setSortOrder] = useState<"group" | "name" | "id" | "frames" | "status" | "manual">("group");
  const [pagination, setPagination] = useState({ scope: "", index: 0 });
  const contentRef = useRef<HTMLDivElement>(null);
  const [folderDraft, setFolderDraft] = useState<{ name: string; parentId?: string } | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState<{ id: string; name: string } | null>(null);
  const [previewState, dispatchPreview] = useReducer(suitePreviewReducer, undefined, createSuitePreviewState);
  const { camera: previewCamera, generation: cameraGeneration, queue: previewQueue, previews } = previewState;

  useEffect(() => {
    let lastTiltAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"))) return;
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key)) return;
      event.preventDefault();
      if (key === "a" || key === "d") {
        if (event.repeat) return;
      } else {
        const now = performance.now();
        if (event.repeat && now - lastTiltAt < 120) return;
        lastTiltAt = now;
      }
      dispatchPreview({ type: "camera", key });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const tagOrder = useMemo(
    () => new Map(folders.map((folder, index) => [folder.id, index])),
    [folders],
  );
  const combinationAliases = useMemo(() => {
    const aliases = new Map<string, TagCombinationAlias>();
    for (const test of tests) {
      const tagIds = canonicalTagCombination(test.tagIds, tagOrder);
      if (tagIds.length < 2) continue;
      const id = `combo:${encodeURIComponent(test.folderId)}:${tagIds.map(encodeURIComponent).join("+")}`;
      if (!aliases.has(id)) {
        aliases.set(id, {
          groupTagId: test.folderId,
          id,
          label: tagIds.map((tagId) => foldersById.get(tagId)?.name ?? "Unknown subtag").join(" + "),
          tagIds,
        });
      }
    }
    return [...aliases.values()].sort((left, right) =>
      (tagOrder.get(left.groupTagId) ?? Number.MAX_SAFE_INTEGER) -
        (tagOrder.get(right.groupTagId) ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label));
  }, [foldersById, tagOrder, tests]);
  const aliasesById = useMemo(
    () => new Map(combinationAliases.map((alias) => [alias.id, alias])),
    [combinationAliases],
  );
  const selectedFolderId = requestedFolderId &&
    (foldersById.has(requestedFolderId) || aliasesById.has(requestedFolderId)) ? requestedFolderId : null;
  const childrenByParent = useMemo(() => {
    const children = new Map<string, TestFolder[]>();
    for (const folder of folders) {
      const parentId = folder.parentId && foldersById.has(folder.parentId) ? folder.parentId : "__root__";
      const entries = children.get(parentId) ?? [];
      entries.push(folder);
      children.set(parentId, entries);
    }
    return children;
  }, [folders, foldersById]);
  const folderPaths = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folderPathLabel(folders, folder.id)])),
    [folders],
  );
  const folderTestCounts = useMemo(() => new Map(folders.map((folder) => [
    folder.id,
    tests.filter((test) => testUsesTag(test, folder)).length,
  ])), [folders, tests]);
  const folderResults = useMemo(() => new Map(folders.map((folder) => [
    folder.id,
    // Include combination memberships: those cards also appear beneath the
    // direct subtag list, and their failures must propagate to the parent.
    summarizeTestResults(tests.filter((test) => testUsesTag(test, folder)), results),
  ])), [folders, results, tests]);
  const aliasResults = useMemo(() => new Map(combinationAliases.map((alias) => [
    alias.id,
    summarizeTestResults(tests.filter((test) => test.folderId === alias.groupTagId &&
      combinationViewIncludesTest(test.tagIds, alias.tagIds, tagOrder)), results),
  ])), [combinationAliases, results, tagOrder, tests]);
  const allResults = useMemo(() => summarizeTestResults(tests, results), [results, tests]);
  const rootFolderCount = folders.filter((folder) => !folder.parentId).length;

  const testIsInSelectedView = useCallback((test: TestCase) => {
    if (selectedFolderId === null) return true;
    const alias = aliasesById.get(selectedFolderId);
    if (alias) {
      return test.folderId === alias.groupTagId &&
        combinationViewIncludesTest(test.tagIds, alias.tagIds, tagOrder);
    }
    const folder = foldersById.get(selectedFolderId);
    if (!folder) return false;
    return folder.parentId
      ? test.folderId === folder.parentId && directSubtagViewIncludesTest(test.tagIds, folder.id)
      : test.folderId === folder.id;
  }, [aliasesById, foldersById, selectedFolderId, tagOrder]);

  const testMatchesFilters = (test: TestCase) => {
    const result = test.hidden ? undefined : results[test.id];
    if (statusFilter === "hidden" && !test.hidden) return false;
    if (statusFilter === "passed" && !result?.pass) return false;
    if (statusFilter === "failed" && (!result || result.pass)) return false;
    if (statusFilter === "untested" && (test.hidden || result)) return false;
    const needle = query.trim().toLowerCase();
    const tagPaths = test.tagIds.map((tagId) => folderPaths.get(tagId) ?? "").join(" ");
    const aliasLabel = combinationAliases.find((alias) =>
      alias.groupTagId === test.folderId &&
      combinationViewIncludesTest(test.tagIds, alias.tagIds, tagOrder))?.label ?? "";
    return !needle || `${test.id} ${test.name} ${test.description} ${tagPaths} ${aliasLabel}`.toLowerCase().includes(needle);
  };
  const selectedScopeTests = tests.filter(testIsInSelectedView);
  const visibleTests = sortTestCases(selectedScopeTests.filter(testMatchesFilters), sortOrder, tagOrder, results);
  const scopeSummary = summarizeTestResults(selectedScopeTests, results);
  const pageSize = 24;
  const pageScope = JSON.stringify([selectedFolderId, query, statusFilter, sortOrder]);
  const page = pagination.scope === pageScope ? pagination.index : 0;
  const setPage = (index: number) => setPagination({ scope: pageScope, index });
  const pageCount = Math.max(1, Math.ceil(visibleTests.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageTests = visibleTests.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0 }); }, [currentPage, selectedFolderId, query, statusFilter, sortOrder]);
  const selectedFolder = selectedFolderId ? foldersById.get(selectedFolderId) : undefined;
  const selectedAlias = selectedFolderId ? aliasesById.get(selectedFolderId) : undefined;
  const relatedAliasSections = selectedFolder?.parentId
    ? combinationAliases
      .filter((alias) => alias.groupTagId === selectedFolder.parentId && alias.tagIds.includes(selectedFolder.id))
      .map((alias) => {
        const scopeTests = tests.filter((test) =>
          test.folderId === alias.groupTagId &&
          combinationViewIncludesTest(test.tagIds, alias.tagIds, tagOrder));
        return { alias, scopeTests, tests: sortTestCases(scopeTests.filter(testMatchesFilters), sortOrder, tagOrder, results) };
      })
      .filter((section) => section.tests.length > 0)
    : [];
  const relatedTestCount = relatedAliasSections.reduce((count, section) => count + section.tests.length, 0);
  const runnableTests = runnableTestCases(tests);
  const runnableTestIds = new Set(runnableTests.map((test) => test.id));
  const completed = Object.entries(results)
    .filter(([testId]) => runnableTestIds.has(testId))
    .map(([, result]) => result);
  const passed = completed.filter((result) => result.pass).length;
  const hidden = tests.length - runnableTests.length;
  const previewJob = previewQueue.find((job) => {
    const test = tests.find((item) => item.id === job.testId);
    return test && suitePreviewFrames(test)[job.frameIndex];
  });
  const renderJob = previewJob ?? previewState.lastJob;
  const previewTest = renderJob
    ? tests.find((test) => test.id === renderJob.testId)
    : undefined;
  const previewFrame = previewTest && renderJob
    ? suitePreviewFrames(previewTest)[renderJob.frameIndex]
    : undefined;
  const requestPreview = useCallback((testId: string, frameIndex: number) => {
    dispatchPreview({ type: "request", key: suitePreviewKey(testId, frameIndex), testId, frameIndex, generation: cameraGeneration });
  }, [cameraGeneration]);
  const acceptPreview = useCallback((dataUrl: string) => {
    if (!previewJob) return;
    dispatchPreview({ type: "complete", key: previewJob.key, generation: previewJob.generation, dataUrl });
  }, [previewJob]);

  const renderTestCard = (test: TestCase, displayIndex: number, scopeTests: TestCase[]) => {
    const result = test.hidden ? undefined : results[test.id];
    const scopeIndex = scopeTests.findIndex((item) => item.id === test.id);
    const effectiveLocked = test.locked;
    const passedRotations = result?.checks.filter((check) => check.pass).length;
    return (
      <article className={`suite-test-row ${test.id === activeId ? "is-active" : ""} ${effectiveLocked ? "is-locked" : ""} ${test.hidden ? "is-hidden" : ""}`} key={test.id} role="listitem">
        <span className={`test-status ${test.hidden ? "hidden" : !result ? "idle" : result.pass ? "pass" : "fail"}`}>{test.hidden ? "—" : !result ? displayIndex + 1 : result.pass ? "✓" : "!"}</span>
        <SuiteTestPreview cameraGeneration={cameraGeneration} previews={previews} test={test} onOpen={() => onOpenTest(test.id)} onRequest={requestPreview} />
        <div className="suite-test-row__details">
          <label className="suite-test-row__title">
            <span>Title</span>
            <input aria-label={`Title for ${test.name || "untitled test"}`} title={test.name} value={test.name} placeholder="Untitled test" onChange={(event) => onUpdateTest(test.id, { name: event.target.value })} />
          </label>
        </div>
        <div className="suite-test-row__actions">
          <button type="button" disabled={test.hidden} title={test.hidden ? "Unhide this case before running it" : "Run this case"} onClick={() => onRunTest(test)}>Run</button>
          <button type="button" onClick={() => onOpenTest(test.id)}>Edit</button>
          <details className="suite-case-actions"><summary aria-label={`More actions for ${test.name}`}>•••</summary><div>
          <button type="button" disabled={sortOrder !== "manual" || scopeIndex === 0} aria-label={`Move ${test.name} left`} title={sortOrder === "manual" ? "Move earlier" : "Choose Manual order to rearrange tests"} onClick={() => onReorderTest(test.id, scopeTests[scopeIndex - 1].id)}>← Move earlier</button>
          <button type="button" disabled={sortOrder !== "manual" || scopeIndex === scopeTests.length - 1} aria-label={`Move ${test.name} right`} title={sortOrder === "manual" ? "Move later" : "Choose Manual order to rearrange tests"} onClick={() => onReorderTest(test.id, scopeTests[scopeIndex + 1].id)}>→ Move later</button>
          <button type="button" aria-label={`Duplicate ${test.name}`} onClick={() => onDuplicateTest(test.id)}>⧉ Duplicate</button>
          <button className={test.hidden ? "is-hidden" : ""} type="button" aria-label={`${test.hidden ? "Unhide" : "Hide"} ${test.name}`} title={test.hidden ? "Include this case in physics runs" : "Hide and ignore this case in physics runs"} onClick={() => onToggleTestHidden(test.id)}><VisibilityIcon hidden={test.hidden} />{test.hidden ? "Include in suite" : "Hide from suite"}</button>
          <button className={effectiveLocked ? "is-locked" : ""} type="button" aria-label={`${test.locked ? "Unlock" : "Lock"} ${test.name}`} title={test.locked ? "Unlock test" : "Lock test"} onClick={() => onToggleTestLocked(test.id)}><LockIcon open={!effectiveLocked} />{test.locked ? "Unlock" : "Lock"}</button>
          <button className="suite-test-row__delete" type="button" disabled={effectiveLocked || tests.length <= 1} aria-label={`Delete ${test.name}`} onClick={() => onDeleteTest(test.id)}>Delete test</button>
          </div></details>
        </div>
        <details className="suite-case-description" name="suite-case-details">
          <summary aria-label={`Details for ${test.name || "untitled test"}`}>Details</summary>
          <div className="suite-case-description__panel">
            <small title={test.id}>{test.world.width}×{test.world.height} · {test.intermediate.length + 2} frames · {cropFrameToWorld(test.start, test.world).voxels.length} voxels{test.hidden ? " · ignored" : result ? ` · ${passedRotations}/4 rotations` : ""}</small>
            <TestTagPicker folders={folders} folderPaths={folderPaths} test={test} onChangeGroup={(groupTagId) => onChangeTestGroup(test.id, groupTagId)} onToggle={(tagId) => onToggleTestTag(test.id, tagId)} />
            <label>
              <span>Expected behavior</span>
              <textarea aria-label={`Description for ${test.name || "untitled test"}`} rows={2} value={test.description} placeholder="Describe the intended behavior…" onChange={(event) => onUpdateTest(test.id, { description: event.target.value })} />
            </label>
          </div>
        </details>
      </article>
    );
  };

  const renderFolderBranch = (parentId = "__root__", depth = 0): React.ReactNode => (
    (childrenByParent.get(parentId) ?? []).filter(folder => visibleFolderIds.has(folder.id)).map((folder) => {
      const storedChildren = childrenByParent.get(folder.id) ?? [];
      // A sole Default subfolder duplicates its parent and adds no navigation.
      const children = storedChildren.length === 1 && storedChildren[0].default ? [] : storedChildren;
      const aliases = folder.parentId
        ? []
        : combinationAliases.filter((alias) => alias.groupTagId === folder.id);
      const hasChildren = children.length > 0 || aliases.length > 0;
      const expanded = expandedFolders.has(folder.id);
      const membershipCount = folderTestCounts.get(folder.id) ?? 0;
      const canDelete = membershipCount === 0 && !folder.default && (folder.parentId !== undefined || rootFolderCount > 1);
      const deleteTitle = folder.default
        ? "Default is a reserved subtag"
        : membershipCount > 0
          ? `${membershipCount} test${membershipCount === 1 ? "" : "s"} still use this tag, including combination memberships`
          : !folder.parentId && rootFolderCount <= 1
              ? "The final parent tag group cannot be deleted"
              : `Delete empty ${folder.parentId ? "subtag" : "tag group"}`;
      return (
        <div className="suite-tree__branch" key={folder.id}>
          <div className={`suite-tree__row ${selectedFolderId === folder.id ? "is-selected" : ""}`} style={{ "--tree-depth": depth } as React.CSSProperties}>
            {hasChildren ? <button className="suite-tree__collapse" type="button" aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`} aria-expanded={expanded} onClick={() => toggleExpandedFolder(folder.id)}><span aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m4 6 4 4 4-4" /></svg></span></button> : <span className="suite-tree__leaf" aria-hidden="true">{folder.parentId ? "·" : <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6V4h6l2 2h8v10H2Z" /></svg>}</span>}
            {folderRenameDraft?.id === folder.id ? (
              <form className="suite-tree__rename" onSubmit={(event) => { event.preventDefault(); const name = folderRenameDraft.name.trim(); if (!name) return; onRenameFolder(folder.id, name); setFolderRenameDraft(null); }}>
                <input aria-label={`New name for ${folder.name}`} value={folderRenameDraft.name} onChange={(event) => setFolderRenameDraft({ id: folder.id, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setFolderRenameDraft(null); } }} />
                <button type="submit" disabled={!folderRenameDraft.name.trim()} aria-label={`Save name for ${folder.name}`}>✓</button>
                <button type="button" aria-label={`Cancel renaming ${folder.name}`} onClick={() => setFolderRenameDraft(null)}>×</button>
              </form>
            ) : (
              <>
                <button className="suite-tree__select" type="button" title={folderPathLabel(folders, folder.id)} aria-current={selectedFolderId === folder.id ? "page" : undefined} onClick={() => { setSelectedFolderId(folder.id); if (hasChildren) setExpandedFolders(current => new Set([...current, folder.id])); }}><strong>{folder.name}</strong><SuiteGroupStatus label={folder.name} summary={folderResults.get(folder.id)!} /><em>{folderTestCounts.get(folder.id) ?? 0}</em></button>
                <details className="suite-folder-actions" name="suite-folder-menu"><summary onKeyDown={event => { if (event.key === "Escape") event.currentTarget.closest("details")?.removeAttribute("open"); }} aria-label={`Folder actions for ${folder.name}`}>•••</summary><div>
                  <button type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); setFolderDraft({name: "", parentId: folder.parentId ?? folder.id}); }}>{folder.parentId ? "New sibling folder" : "New subfolder"}</button>
                  <button className="suite-tree__rename-button" type="button" disabled={folder.default} aria-label={`Rename ${folder.name}`} onClick={() => { setSelectedFolderId(folder.id); setFolderRenameDraft({ id: folder.id, name: folder.name }); }}>Rename</button>
                  <button className="suite-tree__delete-button" type="button" disabled={!canDelete} aria-label={`Delete ${folder.name}`} title={deleteTitle} onClick={() => onDeleteFolder(folder.id)}>Delete empty folder</button>
                </div></details>
              </>
            )}
          </div>
          {expanded && hasChildren && <div className="suite-tree__children">
            {children.length > 0 && renderFolderBranch(folder.id, depth + 1)}
            {aliases.map((alias) => {
              const aliasCount = tests.filter((test) =>
                test.folderId === alias.groupTagId &&
                combinationViewIncludesTest(test.tagIds, alias.tagIds, tagOrder)).length;
              return (
                <div className={`suite-tree__row suite-tree__row--alias ${selectedFolderId === alias.id ? "is-selected" : ""}`} key={alias.id} style={{ "--tree-depth": depth + 1 } as React.CSSProperties}>
                  <span className="suite-tree__alias-marker" aria-hidden="true">◇</span>
                  <button className="suite-tree__select" type="button" title={`Combined subtag: ${alias.label}`} onClick={() => setSelectedFolderId(alias.id)}><span aria-hidden="true">↗</span><strong>{alias.label}</strong><SuiteGroupStatus label={alias.label} summary={aliasResults.get(alias.id)!} /><em>{aliasCount}</em></button>
                  <span />
                </div>
              );
            })}
          </div>}
        </div>
      );
    })
  );

  return (
    <section className="suite-workspace" aria-label="Test Suite workspace">
      <aside className="suite-explorer">
        <div className="suite-explorer__heading"><strong>Folders</strong><div className="suite-explorer__tools"><button type="button" aria-label="Collapse all folders" title="Collapse all folders" onClick={() => { setFolderQuery(""); setExpandedFolders(new Set()); }}>⌃</button><button type="button" aria-label="New folder" title="New folder" onClick={() => setFolderDraft({ name: "" })}>＋</button></div></div>
        <input className="suite-folder-search" type="search" aria-label="Find folders" placeholder="Find a folder…" value={folderQuery} onChange={event => { const value = event.target.value; setFolderQuery(value); if (value.trim()) setExpandedFolders(matchingFolderIds(folders, value)); }} />
        <button className={`suite-tree__all ${selectedFolderId === null ? "is-selected" : ""}`} type="button" onClick={() => setSelectedFolderId(null)}><span>All tests</span><SuiteGroupStatus label="All tests" summary={allResults} /><em>{tests.length}</em></button>
        <div className="suite-tree">{visibleFolderIds.size ? renderFolderBranch() : <p className="suite-folder-empty">No matching folders</p>}</div>
      </aside>

      <section className="suite-browser">
        <header className="suite-browser__header">
          <div className="suite-browser__title">
            <span>{selectedFolder ? folderPaths.get(selectedFolder.id) : selectedAlias ? `${foldersById.get(selectedAlias.groupTagId)?.name ?? "Unknown group"} / Combined subtags` : "Entire project"}</span>
            {selectedFolder ? <input aria-label={`Rename ${selectedFolder.name} tag`} disabled={selectedFolder.default} value={selectedFolder.name} onChange={(event) => onRenameFolder(selectedFolder.id, event.target.value)} /> : <h2>{selectedAlias?.label ?? "All tests"}</h2>}
            <small>{visibleTests.length} shown{relatedTestCount ? ` · ${relatedTestCount} in related combinations` : ""} · {scopeSummary.passed} passing · {scopeSummary.failed} failing · {scopeSummary.pending} untested{scopeSummary.hidden ? ` · ${scopeSummary.hidden} hidden` : ""}</small>
          </div>
          <div className="suite-browser__actions">
            <div className="suite-preview-camera" aria-label="Preview camera" title="A/D rotate · W/S tilt"><span>WASD · Camera</span><button type="button" aria-label="Reset preview camera" title="Reset preview camera" onClick={() => dispatchPreview({ type: "reset" })}>↺</button></div>
            {!selectedAlias && <button className="tool-button" type="button" onClick={() => setFolderDraft({ name: "", ...(selectedFolder ? { parentId: selectedFolder.parentId ?? selectedFolder.id } : {}) })}>＋ {selectedFolder?.parentId ? "Sibling folder" : selectedFolder ? "Subfolder" : "Folder"}</button>}
            <button className="tool-button tool-button--primary" type="button" onClick={() => onAddTest(selectedAlias?.groupTagId ?? selectedFolder?.id, selectedAlias?.tagIds)}>＋ New test</button>
          </div>
        </header>

        <div className="suite-summary" aria-label="Suite result summary">
          <div className="summary-track"><i style={{ width: completed.length && runnableTests.length ? `${(passed / runnableTests.length) * 100}%` : "0%" }} /></div>
          <span>{completed.length ? `Entire suite · ${passed}/${runnableTests.length} passing` : "Entire suite · Not run yet"}{hidden ? ` · ${hidden} hidden` : ""}</span>
        </div>

        {folderDraft && <form className="suite-folder-form" onSubmit={(event) => { event.preventDefault(); const name = folderDraft.name.trim(); if (!name) return; onAddFolder(name, folderDraft.parentId); setFolderDraft(null); }}><label className="field"><span>{folderDraft.parentId ? `New subfolder in ${foldersById.get(folderDraft.parentId)?.name ?? "folder"}` : "New folder"}</span><input aria-label="New test tag name" value={folderDraft.name} placeholder="e.g. Orange walls" onChange={(event) => setFolderDraft((current) => current ? { ...current, name: event.target.value } : current)} onKeyDown={(event) => { if (event.key === "Escape") setFolderDraft(null); }} /></label><button className="tool-button" type="button" onClick={() => setFolderDraft(null)}>Cancel</button><button className="tool-button tool-button--primary" type="submit">Create folder</button></form>}

        <div className="suite-browser__filters">
          <label><span>Search</span><input type="search" value={query} placeholder="Name, description, tag, or case ID…" onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span>Sort</span><select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as typeof sortOrder)}><option value="group">Group & name</option><option value="name">Name</option><option value="id">Case ID</option><option value="frames">Longest timeline</option><option value="status">Needs attention</option><option value="manual">Manual order</option></select></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="failed">Failing</option><option value="passed">Passing</option><option value="untested">Untested</option><option value="hidden">Hidden / ignored</option></select></label>
        </div>

        <div className="suite-browser__content" ref={contentRef}>
          {visibleTests.length > pageSize && <nav className="suite-pagination" aria-label="Test library pages">
            <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, visibleTests.length)} of {visibleTests.length} cases</span>
            <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← Previous</button><span>Page {currentPage + 1} / {pageCount}</span><button type="button" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next →</button></div>
          </nav>}
          <div className="suite-test-table" role="list">
            {visibleTests.length
              ? pageTests.map((test, visibleIndex) => renderTestCard(test, currentPage * pageSize + visibleIndex, selectedScopeTests))
              : <div className="suite-browser__empty"><strong>{statusFilter === "failed" && !query ? "No failing tests" : "No matching tests"}</strong><span>{relatedTestCount ? "Related combinations are shown below." : "Try another group, search, or status filter."}</span></div>}
          </div>
          {relatedAliasSections.length > 0 && <section className="suite-related-combinations" aria-label={`Related combinations for ${selectedFolder?.name ?? "subtag"}`}>
            <header><div><span>Related combinations</span><strong>Also tagged {selectedFolder?.name}</strong></div><em>{relatedTestCount} tests</em></header>
            {relatedAliasSections.map(({ alias, scopeTests, tests: relatedTests }) => (
              <section className="suite-related-combination" key={alias.id}>
                <header><div><span aria-hidden="true">◇</span><h3>{alias.label}</h3><em>{relatedTests.length}</em></div><button type="button" onClick={() => setSelectedFolderId(alias.id)}>Open combination →</button></header>
                <div className="suite-test-table" role="list" aria-label={`${alias.label} tests`}>
                  {relatedTests.slice(0, 6).map((test, index) => renderTestCard(test, index, scopeTests))}
                </div>
              </section>
            ))}
          </section>}
        </div>
        {previewTest && previewFrame && renderJob && <div className="suite-preview-capture" aria-hidden="true"><MazeBenchCanvas snapshotCamera={previewCamera} cameraLayerRange={cameraLayerRangeForFrames(suitePreviewFrames(previewTest))} cameraSceneKey={previewTest.id} frame={previewFrame} blocks={blocks} genericBlockIds={genericBlockIds} world={previewTest.world} layer={1} compact onSnapshot={previewJob ? acceptPreview : undefined} snapshotRequestId={`${renderJob.generation}:${renderJob.key}`} /></div>}
      </section>
    </section>
  );
}

export default function VoxelBench() {
  const [activeWorkspace, setActiveWorkspace] = useState<"tests" | "suite" | "search">("suite");
  const [roles, setRoles] = useState<PhysicsRoleDefinition[]>(DEFAULT_ROLES);
  const [blocks, setBlocks] = useState<BlockDefinition[]>(DEFAULT_BLOCKS);
  const [folders, setFolders] = useState<TestFolder[]>(() => normalizeFolders(DEFAULT_FOLDERS));
  const [tests, setTests] = useState<TestCase[]>(() => {
    const initialFolders = normalizeFolders(DEFAULT_FOLDERS);
    return normalizeTests(DEFAULT_TESTS, initialFolders, DEFAULT_BLOCKS, DEFAULT_ROLES);
  });
  const [savedSearchLevels, setSavedSearchLevels] = useState<SearchLevel[]>([]);
  const [activeId, setActiveId] = useState(DEFAULT_TESTS[0].id);
  const [frameKind, setFrameKind] = useState<FrameKind>("start");
  const [intermediateIndex, setIntermediateIndex] = useState<number | null>(null);
  const [generatedTimeline, setGeneratedTimeline] = useState<{
    cycle?: CycleExpectation;
    final: Frame;
    frames: Frame[];
    generationId: number;
    testId: string;
  } | null>(null);
  const [selectedBlock, setSelectedBlock] = useState("crate");
  const [groupToolPinned, setGroupToolPinned] = useState(false);
  const [groupSelection, setGroupSelection] = useState<GroupSelection | null>(null);
  const [inspectedCell, setInspectedCell] = useState<{ x: number; y: number; z: number } | null>(null);
  const [selectedGenericIds, setSelectedGenericIds] = useState<Record<string, number>>({});
  const [selectedOrangeWallDepths, setSelectedOrangeWallDepths] = useState<Record<string, number>>({});
  const [genericPrompt, setGenericPrompt] = useState<{ blockId: string; value: string } | null>(null);
  const [genericPromptError, setGenericPromptError] = useState("");
  const layer = 1;
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [suiteProgress, setSuiteProgress] = useState<number | null>(null);
  const suiteRunningRef = useRef(false);
  const suiteRevisionRef = useRef(0);
  const suiteJobRef = useRef<ReturnType<typeof startSuiteWorker> | null>(null);
  useEffect(() => { ++suiteRevisionRef.current; suiteJobRef.current?.cancel(); }, [tests, blocks, roles]);
  useEffect(() => () => { suiteJobRef.current?.cancel(); }, []);
  const [showResult, setShowResult] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const [addingBlock, setAddingBlock] = useState(false);
  const [newBlock, setNewBlock] = useState<{
    color: string;
    name: string;
    occupancy: OccupancyProfile;
    roleId: string;
    visual: BlockVisualDefinition;
  }>({ name: "", color: "#D96B5F", roleId: "solid", occupancy: "solid", visual: { kind: "cube" } });
  const [addingRole, setAddingRole] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState("pushable");
  const [newRole, setNewRole] = useState({ name: "", description: "", generic: false });
  const importRef = useRef<HTMLInputElement>(null);
  const genericIdInputRef = useRef<HTMLInputElement>(null);
  const undoStackRef = useRef<EditSnapshot[]>([]);
  const redoStackRef = useRef<EditSnapshot[]>([]);
  const paintGestureRef = useRef({ active: false, snapshotSaved: false });
  const [historyState, setHistoryState] = useState({ canRedo: false, canUndo: false });
  const [cameraQuarterTurns, setCameraQuarterTurns] = useState(0);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const repoRevisionRef = useRef<string | null>(null);
  const repoSaveBlockedRef = useRef(false);
  const repoSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectCodecRef = useRef<ReturnType<typeof createProjectCodec> | null>(null);
  useEffect(() => {
    const codec = createProjectCodec();
    projectCodecRef.current = codec;
    return () => { codec.dispose(); projectCodecRef.current = null; };
  }, []);
  const activeTest = tests.find((test) => test.id === activeId) ?? tests[0];
  const folderPaths = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folderPathLabel(folders, folder.id)])),
    [folders],
  );
  const isTestLocked = useCallback(
    (test: TestCase) => test.locked,
    [],
  );
  const activeTestLocked = activeTest ? isTestLocked(activeTest) : false;
  const activeWorld = activeTest?.world ?? DEFAULT_WORLD;
  const editableSource = activeTest ? editableFrame(activeTest, frameKind, intermediateIndex) : null;
  const activeFrame = useMemo(() => editableSource
    ? cropFrameToWorld(editableSource, activeWorld)
    : { voxels: [] }, [editableSource, activeWorld]);
  const selectedTimelineTick = frameKind === "start"
    ? 0
    : intermediateIndex === null
      ? null
      : intermediateIndex + 1;
  const activeGroupSelection = groupSelection &&
    groupSelection.testId === activeTest?.id &&
    groupSelection.frameKind === frameKind &&
    groupSelection.intermediateIndex === intermediateIndex
    ? groupSelection
    : null;
  const selectedVoxelKeys = useMemo(
    () => new Set(activeGroupSelection?.keys ?? []),
    [activeGroupSelection],
  );
  const groupSelectionMode = groupToolPinned;
  const activeResult = activeTest ? results[activeTest.id] : undefined;
  const genericRoleIds = useMemo(
    () => new Set(roles.filter((role) => role.generic).map((role) => role.id)),
    [roles],
  );
  const genericBlockIds = useMemo(
    () => new Set(blocks.filter((block) => genericRoleIds.has(block.roleId)).map((block) => block.id)),
    [blocks, genericRoleIds],
  );
  const floorBlockIds = useMemo(
    () => new Set(blocks.filter((block) => block.roleId === "floor").map((block) => block.id)),
    [blocks],
  );
  const blockDefinitionsById = useMemo(
    () => new Map(blocks.map((block) => [block.id, block])),
    [blocks],
  );
  const shareableBlockIds = useMemo(
    () => new Set(blocks.filter(blockCanShareCell).map((block) => block.id)),
    [blocks],
  );
  const inspectedCellOccupants = useMemo(() => {
    if (!inspectedCell) return [];
    const coordinate = keyOf(inspectedCell);
    return activeFrame.voxels.filter((voxel) => keyOf(voxel) === coordinate);
  }, [activeFrame.voxels, inspectedCell]);
  const selectedDefinition = selectedBlock === DELETE_TOOL_ID
    ? undefined
    : blocks.find((block) => block.id === selectedBlock) ?? blocks[0];
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? roles[0];
  const selectedGenericId = selectedDefinition && genericBlockIds.has(selectedDefinition.id)
    ? binaryVisualState(selectedDefinition, selectedGenericIds[selectedDefinition.id] ?? 0) ??
      selectedGenericIds[selectedDefinition.id] ?? 0
    : null;
  const selectedSlopeDirection = selectedDefinition?.visual.kind === "slope"
    ? cameraFacingSlopeDirection(cameraQuarterTurns)
    : null;
  const selectedSlopeOption = selectedSlopeDirection
    ? SLOPE_DIRECTION_OPTIONS.find((option) => option.id === selectedSlopeDirection)
    : null;
  const selectedOrangeWallDepth = selectedDefinition?.roleId === "orange-wall"
    ? selectedOrangeWallDepths[selectedDefinition.id] ?? 0
    : null;
  const selectedBlockCanShare = selectedDefinition
    ? objectPaintsInsideClickedBody(selectedDefinition)
    : false;
  const selectedToolName = groupSelectionMode
    ? "Select group"
    : activeGroupSelection
      ? `${activeGroupSelection.keys.length} cubes selected`
      : selectedBlock === DELETE_TOOL_ID
        ? "Erase"
        : `${selectedDefinition?.name ?? "Block"}${selectedGenericId === null ? "" : ` · ${selectedGenericId}`}${selectedOrangeWallDepth === null ? "" : ` · rise ${selectedOrangeWallDepth}`}${selectedSlopeOption ? ` · ${selectedSlopeOption.glyph} ${selectedSlopeOption.label}` : ""}${selectedDefinition?.visual.kind === "lift" || selectedDefinition?.visual.kind === "puncher" ? " · face chooses direction" : ""}`;

  useEffect(() => {
    let cancelled = false;

    const restoreProject = async () => {
      let repoProject: string | null = null;
      try {
        const response = await fetch(LOCAL_PROJECT_ENDPOINT, { cache: "no-store" });
        if (response.ok) {
          repoProject = await response.text();
          repoRevisionRef.current = response.headers.get("ETag");
        } else if (response.status === 404) {
          repoRevisionRef.current = "*";
        }
      } catch {
        // Repo persistence is local-development-only. Browser storage remains
        // the fallback for production previews and temporarily offline runs.
      }

      const browserProject = localStorage.getItem(STORAGE_KEY);
      const candidates = [repoProject, browserProject].filter((value): value is string => Boolean(value));
      let restored = false;

      for (const saved of candidates) {
        try {
          const parsed = await projectCodecRef.current!.decode(saved) as {
          blocks: StoredBlockDefinition[];
          folders?: StoredTestFolder[];
          tags?: StoredTestFolder[];
          roles?: PhysicsRoleDefinition[];
          searches?: unknown;
          tests: StoredTestCase[];
          world?: WorldSettings;
          };
          if (!parsed.blocks?.length || !parsed.tests?.length) continue;
          const legacyWorld = normalizeWorld(parsed.world ?? DEFAULT_WORLD);
          const restoredRoles = normalizeRoles(parsed.roles);
          const restoredBlocks = normalizeBlocks(parsed.blocks, restoredRoles);
          const restoredFolders = normalizeFolders(parsed.tags ?? parsed.folders);
          const restoredTests = await normalizeTestsInBatches(
            parsed.tests,
            restoredFolders,
            restoredBlocks,
            restoredRoles,
            parsed.blocks,
            legacyWorld,
          );
          if (cancelled) return;
          setRoles(restoredRoles);
          setSelectedRoleId(restoredRoles.find((role) => role.id === "pushable")?.id ?? restoredRoles[0].id);
          setNewBlock((current) => ({
            ...current,
            roleId: restoredRoles.some((role) => role.id === current.roleId)
              ? current.roleId
              : restoredRoles[0].id,
          }));
          setBlocks(restoredBlocks);
          setFolders(restoredFolders);
          setTests(restoredTests);
          setSavedSearchLevels(normalizeSearchLevels(parsed.searches, restoredBlocks));
          setActiveId(restoredTests[0].id);
          restored = true;
          break;
        } catch {
          // Try the browser fallback if the repo copy is incomplete.
        }
      }

      if (!cancelled) {
        if (!restored && candidates.length) {
          setToast("Could not restore saved project data");
        }
        setProjectLoaded(true);
      }
    };

    void restoreProject();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!projectLoaded) return;
    let cancelled = false;
    const saveProject = async () => {
      const project = {
        schemaVersion: 15,
        coordinateSystem: { horizontalAxes: ["x", "y"], verticalAxis: "z", floorLayer: 0 },
        roles,
        blocks,
        tags: folders,
        searches: savedSearchLevels,
        tests,
      };
      const serialized = await projectCodecRef.current!.encode(project);
      if (cancelled) return;
      let browserBackupPreserved = true;
      try {
        localStorage.setItem(STORAGE_KEY, serialized);
      } catch {
        // Large authored suites can exceed the browser's storage quota. The
        // tracked repo file remains the source of truth, so never let this
        // optional fallback prevent the local-project request below.
        browserBackupPreserved = false;
      }
      repoSaveQueueRef.current = repoSaveQueueRef.current.catch(() => undefined).then(async () => {
        if (cancelled || repoSaveBlockedRef.current) return;
        const response = await fetch(LOCAL_PROJECT_ENDPOINT, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(repoRevisionRef.current ? { "If-Match": repoRevisionRef.current } : {}),
          },
          body: serialized,
        });
        if (response.status === 409 || response.status === 428) {
          repoSaveBlockedRef.current = true;
          setSaveConflict(true);
          return;
        }
        if (response.ok) repoRevisionRef.current = response.headers.get("ETag");
        if (!response.ok && response.status !== 404 && !cancelled) {
          setToast(browserBackupPreserved
            ? "Repo save failed · browser backup preserved"
            : "Repo save failed · project is too large for the browser backup");
        }
      }).catch(() => {
        if (!browserBackupPreserved && !cancelled) {
          setToast("Repo save unavailable · project is too large for the browser backup");
        }
      });
    };
    const timer = window.setTimeout(() => {
      void saveProject().catch(() => {
        if (!cancelled) setToast("Could not prepare the project for saving. Your edits are still open.");
      });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [blocks, folders, projectLoaded, roles, savedSearchLevels, tests]);

  const runTest = useCallback(async (test: TestCase) => {
    if (suiteRunningRef.current) return null;
    if (test.hidden) {
      setToast(`${test.name} is hidden from physics runs`);
      return null;
    }
    setToast(`Running ${test.name} through the C++ engine…`);
    try {
      const result = await runRotationalTest(test, blocks, roles);
      setResults((current) => ({ ...current, [test.id]: result }));
      if (test.id === activeId) setShowResult(shouldShowResultComparison(result));
      const failedRotations = result.checks.filter((check) => !check.pass).length;
      setToast(result.pass
        ? `${test.name} passed all 4 rotations in C++`
        : `${test.name} failed ${failedRotations} of 4 rotations · first at ${result.rotation}° ${result.input}${result.tick === undefined ? "" : ` · tick ${result.tick}`}`);
      return result;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The C++ physics engine could not run");
      return null;
    }
  }, [activeId, blocks, roles]);

  const runSuite = useCallback(async () => {
    if (suiteRunningRef.current) return;
    const runnableTests = runnableTestCases(tests);
    const hiddenCount = tests.length - runnableTests.length;
    if (!runnableTests.length) {
      setResults({});
      setShowResult(false);
      setToast(`All ${hiddenCount} tests are hidden from physics runs`);
      return;
    }
    suiteRunningRef.current = true;
    const revision = suiteRevisionRef.current;
    setSuiteProgress(0);
    setToast(`Running ${runnableTests.length * 4} rotated checks through the C++ engine${hiddenCount ? ` · ignoring ${hiddenCount} hidden` : ""}…`);
    try {
      const job = startSuiteWorker(runnableTests, blocks, roles, setSuiteProgress);
      suiteJobRef.current = job;
      const nextResults = await job.result;
      if (revision !== suiteRevisionRef.current) return;
      setResults(nextResults);
      const passed = Object.values(nextResults).filter((result) => result.pass).length;
      setShowResult(shouldShowResultComparison(nextResults[activeId]));
      setToast(`${passed} of ${runnableTests.length} active tests passed in C++${hiddenCount ? ` · ${hiddenCount} hidden` : ""}`);
    } catch (error) {
      setToast(revision !== suiteRevisionRef.current
        ? "Tests changed during the run. Run the suite again for current results."
        : error instanceof Error ? error.message : "The C++ physics engine could not run");
    } finally {
      suiteJobRef.current = null;
      suiteRunningRef.current = false;
      setSuiteProgress(null);
    }
  }, [activeId, blocks, roles, tests]);

  const generateTimeline = useCallback(async () => {
    if (!activeTest) return;
    setToast(`Generating ${activeTest.name} tick frames in C++…`);
    try {
      const simulation = await simulateCommandWithCpp(
        cropFrameToWorld(activeTest.start, activeTest.world),
        "up",
        blocks,
        roles,
        activeTest.world,
      );
      setGeneratedTimeline({
        cycle: simulation.cycle,
        final: cropFrameToWorld(simulation.final, activeTest.world),
        frames: simulation.frames.map((frame) =>
          cropFrameToWorld(frame, activeTest.world)),
        generationId: Date.now(),
        testId: activeTest.id,
      });
      setToast(`${simulation.frames.length} C++ tick ${simulation.frames.length === 1 ? "frame" : "frames"} generated · review before accepting`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The C++ timeline could not be generated");
    }
  }, [activeTest, blocks, roles]);

  const syncHistoryState = useCallback(() => {
    setHistoryState({
      canRedo: redoStackRef.current.length > 0,
      canUndo: undoStackRef.current.length > 0,
    });
  }, []);

  const pushHistory = useCallback((stack: React.MutableRefObject<EditSnapshot[]>, snapshot: EditSnapshot) => {
    stack.current.push({ ...snapshot, frame: cloneFrame(snapshot.frame) });
    if (stack.current.length > UNDO_STACK_LIMIT) stack.current.shift();
    syncHistoryState();
  }, [syncHistoryState]);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    paintGestureRef.current = { active: false, snapshotSaved: false };
    syncHistoryState();
  }, [syncHistoryState]);

  const acceptGeneratedTimeline = useCallback(() => {
    if (!activeTest || !generatedTimeline || generatedTimeline.testId !== activeTest.id) return;
    if (activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const frames = generatedTimeline.frames;
    const final = generatedTimeline.final;
    const intermediate = frames.length && compareFrames(
      frames[frames.length - 1], final, activeTest.world, blocks).pass
      ? frames.slice(0, -1)
      : frames;
    setTests((current) => current.map((test) => test.id === activeTest.id
      ? {
        ...test,
        cycle: generatedTimeline.cycle,
        intermediate: intermediate.map(cloneFrame),
        expected: cloneFrame(final),
      }
      : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setGeneratedTimeline(null);
    setFrameKind("expected");
    setIntermediateIndex(null);
    setShowResult(false);
    clearHistory();
    setToast(`${intermediate.length} intermediate ${intermediate.length === 1 ? "frame" : "frames"} and the final frame accepted`);
  }, [activeTest, activeTestLocked, blocks, clearHistory, generatedTimeline]);

  const activateGroupTool = useCallback(() => {
    setGenericPrompt(null);
    setGenericPromptError("");
    if (groupToolPinned) {
      const selectedCount = activeGroupSelection?.keys.length ?? 0;
      setGroupSelection(null);
      setToast(selectedCount
        ? `${selectedCount} ${selectedCount === 1 ? "cube" : "cubes"} deselected · Group tool remains active`
        : "Group selection is already clear · Group tool remains active");
      return;
    }
    setGroupToolPinned(true);
    setToast("Select group tool selected · press G again to clear selection");
  }, [activeGroupSelection, groupToolPinned]);

  const requestBlockSelection = useCallback((blockId: string) => {
    const block = blocks.find((definition) => definition.id === blockId);
    if (!block) return;
    setGroupToolPinned(false);
    setGroupSelection(null);
    if (genericRoleIds.has(block.roleId) || block.roleId === "orange-wall") {
      setGenericPrompt({
        blockId,
        value: String(block.roleId === "orange-wall"
          ? selectedOrangeWallDepths[blockId] ?? 0
          : binaryVisualState(block, selectedGenericIds[blockId] ?? 0) ??
            selectedGenericIds[blockId] ?? 0),
      });
      setGenericPromptError("");
      return;
    }
    setGenericPrompt(null);
    setSelectedBlock(blockId);
    const slopeDirection = block.visual.kind === "slope"
      ? cameraFacingSlopeDirection(cameraQuarterTurns)
      : null;
    const slopeOption = slopeDirection
      ? SLOPE_DIRECTION_OPTIONS.find((option) => option.id === slopeDirection)
      : null;
    setToast(`${block.name}${slopeOption ? ` ${slopeOption.glyph} ${slopeOption.label}` : ""}${block.visual.kind === "lift" || block.visual.kind === "button" || block.visual.kind === "puncher" ? " · click a face to choose its mounting" : ""} selected`);
  }, [blocks, cameraQuarterTurns, genericRoleIds, selectedGenericIds, selectedOrangeWallDepths]);

  const selectToolbarRelative = useCallback((direction: -1 | 1) => {
    const slots = [DELETE_TOOL_ID, GROUP_TOOL_ID, ...blocks.map((block) => block.id)];
    const currentSlot = groupToolPinned ? GROUP_TOOL_ID : selectedBlock;
    const targetSlot = slots[offsetToolbarIndex(slots.indexOf(currentSlot), slots.length, direction)];
    setGenericPrompt(null);
    setGenericPromptError("");
    setGroupSelection(null);

    if (targetSlot === DELETE_TOOL_ID) {
      setGroupToolPinned(false);
      setSelectedBlock(DELETE_TOOL_ID);
      setToast("Erase tool selected");
      return;
    }
    if (targetSlot === GROUP_TOOL_ID) {
      setGroupToolPinned(true);
      setToast("Select group tool selected · click toggles · Shift-drag box-selects");
      return;
    }

    const block = blocks.find((definition) => definition.id === targetSlot);
    if (!block) return;
    setGroupToolPinned(false);
    setSelectedBlock(block.id);
    const genericId = genericBlockIds.has(block.id)
      ? binaryVisualState(block, selectedGenericIds[block.id] ?? 0) ??
        selectedGenericIds[block.id] ?? 0
      : null;
    const slopeDirection = block.visual.kind === "slope"
      ? cameraFacingSlopeDirection(cameraQuarterTurns)
      : null;
    const slopeOption = slopeDirection
      ? SLOPE_DIRECTION_OPTIONS.find((option) => option.id === slopeDirection)
      : null;
    setToast(genericId === null
      ? `${block.name}${slopeOption ? ` ${slopeOption.glyph} ${slopeOption.label}` : ""} selected`
      : `${block.name} ${genericId}${block.visual.kind === "lift" || block.visual.kind === "puncher" ? " · face chooses direction" : ""} selected`);
  }, [blocks, cameraQuarterTurns, genericBlockIds, groupToolPinned, selectedBlock, selectedGenericIds]);

  const handleHorizontalToolbarKey = useCallback((direction: -1 | 1) => {
    if (!groupToolPinned && selectedDefinition && genericBlockIds.has(selectedDefinition.id)) {
      const currentId = binaryVisualState(
        selectedDefinition,
        selectedGenericIds[selectedDefinition.id] ?? 0,
      ) ?? selectedGenericIds[selectedDefinition.id] ?? 0;
      const nextId = offsetGenericObjectId(
        currentId,
        direction,
        selectedDefinition.visual.kind === "lift" || selectedDefinition.visual.kind === "gate" || selectedDefinition.visual.kind === "puncher"
          ? 1
          : selectedDefinition.genericMax,
      );
      if (nextId !== null) {
        setSelectedGenericIds((current) => ({ ...current, [selectedDefinition.id]: nextId }));
        setToast(`${selectedDefinition.name} ${nextId} selected`);
        return;
      }
    }
    if (!groupToolPinned && selectedDefinition?.roleId === "orange-wall") {
      const currentDepth = selectedOrangeWallDepths[selectedDefinition.id] ?? 0;
      const nextDepth = offsetGenericObjectId(currentDepth, direction);
      if (nextDepth !== null) {
        setSelectedOrangeWallDepths((current) => ({
          ...current,
          [selectedDefinition.id]: nextDepth,
        }));
        setToast(`${selectedDefinition.name} · rise ${nextDepth} selected`);
        return;
      }
    }
    selectToolbarRelative(direction);
  }, [genericBlockIds, groupToolPinned, selectToolbarRelative, selectedDefinition, selectedGenericIds, selectedOrangeWallDepths]);

  const confirmGenericSelection = () => {
    if (!genericPrompt) return;
    const id = Number(genericPrompt.value.trim());
    const block = blocks.find((definition) => definition.id === genericPrompt.blockId);
    if (!block) {
      setGenericPrompt(null);
      return;
    }
    const maximum = block.visual.kind === "lift" || block.visual.kind === "gate" || block.visual.kind === "puncher"
      ? 1
      : block.roleId === "orange-wall"
        ? 2147483647
        : block.genericMax ?? 2147483647;
    if (!Number.isInteger(id) || id < 0 || id > maximum) {
      setGenericPromptError(`Enter a whole number from 0 to ${maximum.toLocaleString()}.`);
      return;
    }
    if (block.roleId === "orange-wall") {
      setSelectedOrangeWallDepths((current) => ({ ...current, [block.id]: id }));
    } else {
      setSelectedGenericIds((current) => ({ ...current, [block.id]: id }));
    }
    setGroupToolPinned(false);
    setGroupSelection(null);
    setSelectedBlock(block.id);
    setGenericPrompt(null);
    setGenericPromptError("");
    setToast(block.visual.kind === "lift"
      ? `${block.name} ${id} · ${id ? "raised" : "lowered"} selected · click a face to choose direction`
      : block.visual.kind === "gate"
        ? `${block.name} ${id} · ${id ? "raised" : "lowered"} selected`
      : block.visual.kind === "puncher"
        ? `${block.name} ${id} · ${id ? "sprung" : "unsprung"} selected · click a side face to choose direction`
      : block.roleId === "orange-wall"
        ? `${block.name} · rise ${id} selected${block.visual.kind === "slope" ? " · rotate the camera to choose direction" : ""}`
      : `${block.name} ${id} selected · paint cubes to join generic object ${id}`);
  };

  const genericPromptBlockId = genericPrompt?.blockId ?? null;
  useEffect(() => {
    if (!genericPromptBlockId) return;
    const frameId = window.requestAnimationFrame(() => {
      genericIdInputRef.current?.focus();
      genericIdInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [genericPromptBlockId]);

  const saveWorldDimensions = useCallback((width: number, height: number) => {
    if (!activeTest || activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const nextWorld = normalizeWorld({ width, height, floorLayer: 0 });
    if (nextWorld.width === activeTest.world.width && nextWorld.height === activeTest.world.height) {
      setToast(`${activeTest.name} dimensions unchanged`);
      return;
    }

    const boundedTest = cropTestToWorld(activeTest, nextWorld);
    const previousVoxelCount = activeTest.start.voxels.length +
      activeTest.intermediate.reduce((sum, frame) => sum + frame.voxels.length, 0) +
      activeTest.expected.voxels.length;
    const nextVoxelCount = boundedTest.start.voxels.length +
      boundedTest.intermediate.reduce((sum, frame) => sum + frame.voxels.length, 0) +
      boundedTest.expected.voxels.length;
    const removedVoxelCount = previousVoxelCount - nextVoxelCount;

    setTests((current) => current.map((test) => test.id === activeTest.id ? boundedTest : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setShowResult(false);
    setGroupSelection(null);
    clearHistory();
    setToast(removedVoxelCount > 0
      ? `${activeTest.name} resized to ${nextWorld.width} × ${nextWorld.height} · removed ${removedVoxelCount} out-of-bounds voxels`
      : `${activeTest.name} resized to ${nextWorld.width} × ${nextWorld.height}`);
  }, [activeTest, activeTestLocked, clearHistory]);

  const restoreEditSnapshot = useCallback((snapshot: EditSnapshot, oppositeStack: React.MutableRefObject<EditSnapshot[]>) => {
    const currentTest = tests.find((test) => test.id === snapshot.testId);
    if (!currentTest || isTestLocked(currentTest)) return false;
    pushHistory(oppositeStack, {
      testId: snapshot.testId,
      frameKind: snapshot.frameKind,
      intermediateIndex: snapshot.intermediateIndex,
      frame: editableFrame(
        currentTest, snapshot.frameKind, snapshot.intermediateIndex),
    });
    setTests((current) => current.map((test) =>
      test.id === snapshot.testId
        ? replaceEditableFrame(
          test,
          snapshot.frameKind,
          snapshot.intermediateIndex,
          cloneFrame(snapshot.frame),
        )
        : test,
    ));
    setActiveId(snapshot.testId);
    setFrameKind(snapshot.frameKind);
    setIntermediateIndex(snapshot.intermediateIndex);
    setGroupSelection(null);
    setShowResult(false);
    setResults((current) => {
      const next = { ...current };
      delete next[snapshot.testId];
      return next;
    });
    return true;
  }, [isTestLocked, pushHistory, tests]);

  const undoPaint = useCallback(() => {
    if (activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) {
      setToast("Nothing to undo");
      return;
    }
    if (restoreEditSnapshot(snapshot, redoStackRef)) {
      setToast("Undid the last paint stroke");
    }
    syncHistoryState();
  }, [activeTestLocked, restoreEditSnapshot, syncHistoryState]);

  const redoPaint = useCallback(() => {
    if (activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const snapshot = redoStackRef.current.pop();
    if (!snapshot) {
      setToast("Nothing to redo");
      return;
    }
    if (restoreEditSnapshot(snapshot, undoStackRef)) {
      setToast("Redid the paint stroke");
    }
    syncHistoryState();
  }, [activeTestLocked, restoreEditSnapshot, syncHistoryState]);

  const beginPaintGesture = useCallback(() => {
    paintGestureRef.current = { active: true, snapshotSaved: false };
  }, []);

  const endPaintGesture = useCallback(() => {
    paintGestureRef.current = { active: false, snapshotSaved: false };
  }, []);

  const selectVoxelGroup = useCallback((x: number, y: number, z: number, additive: boolean, selectionKey?: string) => {
    if (!activeTest) return;
    const exactObject = selectionKey
      ? activeFrame.voxels.find((voxel) => cellObjectSelectionKey(voxel) === selectionKey)
      : undefined;
    const origin = exactObject ?? { x, y, z, selectionKey };
    setInspectedCell({ x: origin.x, y: origin.y, z: origin.z });
    const keys = selectConnectedVoxelGroup(
      activeFrame.voxels,
      { ...origin, selectionKey },
      shareableBlockIds,
      blockDefinitionsById,
    );
    if (!keys.length) {
      if (!additive) setGroupSelection(null);
      setToast("No cube at that position");
      return;
    }
    const currentKeys = activeGroupSelection?.keys ?? [];
    const selection = toggleVoxelGroupSelection(currentKeys, keys, additive);
    if (selection.deselected) {
      setGroupSelection(selection.keys.length
        ? { frameKind, intermediateIndex, keys: selection.keys, testId: activeTest.id }
        : null);
      setToast(`${keys.length} ${keys.length === 1 ? "cube" : "cubes"} deselected`);
      return;
    }
    const previousKeys = additive ? currentKeys : [];
    const combinedKeys = selection.keys;
    setGroupSelection({ frameKind, intermediateIndex, keys: combinedKeys, testId: activeTest.id });
    const addedCount = combinedKeys.length - previousKeys.length;
    setToast(additive
      ? addedCount > 0
        ? `${addedCount} ${addedCount === 1 ? "cube" : "cubes"} added · ${combinedKeys.length} selected`
        : "That group is already selected"
      : `${keys.length} touching ${keys.length === 1 ? "cube" : "cubes"} selected · click again to deselect`);
  }, [activeFrame.voxels, activeGroupSelection, activeTest, blockDefinitionsById, frameKind, intermediateIndex, shareableBlockIds]);

  const selectVoxelGroups = useCallback((origins: Array<{ x: number; y: number; z: number; selectionKey?: string }>, additive: boolean) => {
    if (!activeTest) return;
    const selectedKeys = new Set<string>();
    const visitedCoordinates = new Set<string>();
    let groupCount = 0;

    for (const origin of origins) {
      const originKey = origin.selectionKey ?? `${origin.x},${origin.y},${origin.z}`;
      if (visitedCoordinates.has(originKey)) continue;
      visitedCoordinates.add(originKey);
      const groupKeys = selectConnectedVoxelGroup(
        activeFrame.voxels,
        origin,
        shareableBlockIds,
        blockDefinitionsById,
      );
      if (!groupKeys.length) continue;
      groupCount += 1;
      groupKeys.forEach((key) => selectedKeys.add(key));
    }

    if (!selectedKeys.size) {
      setToast("No groups inside that rectangle");
      return;
    }

    const previousKeys = additive ? activeGroupSelection?.keys ?? [] : [];
    const combinedKeys = [...new Set([...previousKeys, ...selectedKeys])];
    setGroupSelection({ frameKind, intermediateIndex, keys: combinedKeys, testId: activeTest.id });
    const addedCount = combinedKeys.length - previousKeys.length;
    setToast(addedCount > 0
      ? `${groupCount} ${groupCount === 1 ? "group" : "groups"} boxed · ${addedCount} ${addedCount === 1 ? "cube" : "cubes"} added`
      : "Every group in that rectangle is already selected");
  }, [activeFrame.voxels, activeGroupSelection, activeTest, blockDefinitionsById, frameKind, intermediateIndex, shareableBlockIds]);

  const moveSelectedGroup = useCallback((direction: Direction, verticalDelta = 0) => {
    if (!activeTest || !activeGroupSelection) return;
    if (activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const worldDirection = verticalDelta === 0
      ? cameraRelativeDirection(direction, cameraQuarterTurns) as Direction
      : direction;
    const delta = verticalDelta === 0 ? {
      up: { dx: 0, dy: -1 },
      right: { dx: 1, dy: 0 },
      down: { dx: 0, dy: 1 },
      left: { dx: -1, dy: 0 },
    }[worldDirection] : { dx: 0, dy: 0 };
    const currentFrame = editableFrame(activeTest, frameKind, intermediateIndex);
    if (verticalDelta !== 0 && selectionContainsFloor(
      currentFrame.voxels,
      activeGroupSelection.keys,
      floorBlockIds,
    )) {
      setToast("Floor tiles are fixed to Row 0 and cannot be raised or lowered");
      return;
    }
    const movement = moveVoxelGroup(
      currentFrame.voxels,
      activeGroupSelection.keys,
      delta.dx,
      delta.dy,
      activeWorld,
      verticalDelta,
      shareableBlockIds,
      blockDefinitionsById,
    );
    if (!movement.moved) {
      setToast(verticalDelta
        ? "Group is blocked by another cube on that layer"
        : "Group is blocked by the room edge or another cube");
      return;
    }

    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: currentFrame,
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) =>
      test.id === activeTest.id
        ? replaceEditableFrame(
          test, frameKind, intermediateIndex, { voxels: movement.voxels })
        : test,
    ));
    setGroupSelection({
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      keys: movement.selectedKeys,
    });
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setShowResult(false);
    const movementLabel = verticalDelta > 0
      ? "raised one layer"
      : verticalDelta < 0
        ? "lowered one layer"
        : `moved ${direction} relative to camera`;
    setToast(`${movement.selectedKeys.length} ${movement.selectedKeys.length === 1 ? "cube" : "cubes"} ${movementLabel}`);
  }, [activeGroupSelection, activeTest, activeTestLocked, activeWorld, blockDefinitionsById, cameraQuarterTurns, floorBlockIds, frameKind, intermediateIndex, pushHistory, shareableBlockIds, syncHistoryState]);

  const deleteSelectedGroup = useCallback(() => {
    if (!activeTest || !activeGroupSelection || !groupToolPinned) return;
    if (activeTestLocked) {
      setToast("This test is locked");
      return;
    }

    const currentFrame = editableFrame(activeTest, frameKind, intermediateIndex);
    const deletion = removeSelectedVoxels(currentFrame.voxels, activeGroupSelection.keys);
    if (!deletion.removedCount) {
      setGroupSelection(null);
      setToast("The selected cubes are no longer in this frame");
      return;
    }

    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: currentFrame,
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) =>
      test.id === activeTest.id
        ? replaceEditableFrame(
          test, frameKind, intermediateIndex, { voxels: deletion.voxels })
        : test,
    ));
    setGroupSelection(null);
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setShowResult(false);
    setToast(`${deletion.removedCount} ${deletion.removedCount === 1 ? "cube" : "cubes"} deleted · undo to restore`);
  }, [activeGroupSelection, activeTest, activeTestLocked, frameKind, groupToolPinned, intermediateIndex, pushHistory, syncHistoryState]);

  const selectTimelineRelative = useCallback((offset: -1 | 1) => {
    if (!activeTest) return;
    const selection = offsetTimelineSelection(
      frameKind,
      intermediateIndex,
      activeTest.intermediate.length,
      offset,
    );
    setFrameKind(selection.frameKind as FrameKind);
    setIntermediateIndex(selection.intermediateIndex);
    setGroupSelection(null);
    const label = selection.intermediateIndex === null
      ? selection.frameKind === "start" ? "Start" : "Expected"
      : `Tick ${selection.intermediateIndex + 1}`;
    setToast(`${label} frame selected`);
  }, [activeTest, frameKind, intermediateIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "g") {
        event.preventDefault();
        if (event.repeat) return;
        activateGroupTool();
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (key === "delete" || key === "backspace") &&
        groupToolPinned &&
        activeGroupSelection
      ) {
        event.preventDefault();
        if (!event.repeat) deleteSelectedGroup();
        return;
      }
      const groupDirection = {
        arrowup: "up",
        arrowright: "right",
        arrowdown: "down",
        arrowleft: "left",
      }[key] as Direction | undefined;
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.shiftKey &&
        (key === "arrowleft" || key === "arrowright")
      ) {
        event.preventDefault();
        if (!event.repeat) selectTimelineRelative(key === "arrowleft" ? -1 : 1);
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && groupDirection && activeGroupSelection) {
        event.preventDefault();
        const verticalDelta = event.shiftKey && (groupDirection === "up" || groupDirection === "down")
          ? groupDirection === "up" ? 1 : -1
          : 0;
        moveSelectedGroup(groupDirection, verticalDelta);
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && (key === "arrowleft" || key === "arrowright")) {
        event.preventDefault();
        handleHorizontalToolbarKey(key === "arrowleft" ? -1 : 1);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoPaint();
        else undoPaint();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "u") {
        event.preventDefault();
        undoPaint();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === "x") {
        event.preventDefault();
        setGenericPrompt(null);
        setGroupToolPinned(false);
        setGroupSelection(null);
        setSelectedBlock(DELETE_TOOL_ID);
        setToast("Erase tool selected");
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-9]$/.test(key)) {
        const definition = blocks[Number(key) - 1];
        if (definition) {
          event.preventDefault();
          requestBlockSelection(definition.id);
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && activeTest) {
        event.preventDefault();
        runTest(activeTest);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activateGroupTool, activeGroupSelection, activeTest, blocks, deleteSelectedGroup, groupToolPinned, handleHorizontalToolbarKey, moveSelectedGroup, redoPaint, requestBlockSelection, runTest, selectTimelineRelative, undoPaint]);

  const paint = (
    x: number,
    y: number,
    z: number,
    blockId: string | null,
    surface?: PaintSurface,
  ) => {
    if (!activeTest || activeTestLocked) return;
    if (blockId && z !== 0 && blocks.find((block) => block.id === blockId)?.roleId === "floor") {
      setToast("Floor tiles may only be painted on Row 0");
      return;
    }
    const currentFrame = editableFrame(activeTest, frameKind, intermediateIndex);
    let genericId = blockId && genericBlockIds.has(blockId)
      ? selectedGenericIds[blockId] ?? 0
      : undefined;
    const blockDefinition = blockId ? blockDefinitionsById.get(blockId) : undefined;
    const slopeDirection = blockDefinition?.visual.kind === "slope"
      ? cameraFacingSlopeDirection(cameraQuarterTurns)
      : null;
    const liftOrientation = blockDefinition?.visual.kind === "lift"
      ? liftOrientationFromPaintFace(surface)
      : null;
    const buttonOrientation = blockDefinition?.visual.kind === "button"
      ? buttonOrientationFromPaintFace(surface)
      : null;
    const puncherDirection = blockDefinition?.visual.kind === "puncher"
      ? puncherDirectionFromPaintFace(surface)
      : null;
    const orangeWallState = blockDefinition?.roleId === "orange-wall"
      ? blockDefinition.visual.orangeForm === "hidden" ? 2 : 1
      : null;
    if (blockDefinition?.visual.kind === "lift" && liftOrientation === null) {
      setToast("Downward-facing lifts are not part of the 0–9 lift family yet");
      return;
    }
    if (blockDefinition?.visual.kind === "puncher" && puncherDirection === null) {
      setToast("Punchers mount on a cube's four side faces");
      return;
    }
    if (blockDefinition?.visual.kind === "lift") {
      genericId = liftGenericId(liftOrientation ?? "top", liftIsRaised(genericId ?? 0));
    }
    let orangeWallDepth: number | undefined;
    if (blockDefinition?.roleId === "orange-wall") {
      orangeWallDepth = selectedOrangeWallDepths[blockDefinition.id] ?? 0;
    }
    const placement: Voxel | null = blockId ? {
      x,
      y,
      z,
      blockId,
      instanceId: newInstanceId(),
      orientation: slopeDirection ?? liftOrientation ?? buttonOrientation ?? puncherDirection ?? "none",
      stateId: orangeWallState ?? 0,
      ...(orangeWallDepth === undefined ? {} : { mechanismDepth: orangeWallDepth }),
      variantId: slopeDirection
        ? slopeDirectionIndex(slopeDirection)
        : liftOrientation
          ? liftOrientationIndex(liftOrientation)
          : buttonOrientation
            ? buttonOrientationIndex(buttonOrientation)
          : puncherDirection
            ? slopeDirectionIndex(puncherDirection)
          : 0,
      ...(genericId === undefined
        ? {}
        : {
            genericId,
            ...(blockUsesPolycubeGroup(blockDefinition)
              ? { groupId: genericId }
              : {}),
          }),
    } : null;
    const operation = placement
      ? placeObjectInCell(currentFrame.voxels, placement, blockDefinitionsById)
      : eraseOneObjectAtCell(currentFrame.voxels, { x, y, z }, surface?.selectionKey);
    if (!operation.changed) return;
    setGroupSelection(null);
    setInspectedCell({ x, y, z });
    if (!paintGestureRef.current.active || !paintGestureRef.current.snapshotSaved) {
      pushHistory(undoStackRef, {
        testId: activeTest.id,
        frameKind,
        intermediateIndex,
        frame: currentFrame,
      });
      redoStackRef.current = [];
      syncHistoryState();
      paintGestureRef.current.snapshotSaved = true;
    }
    setTests((current) => current.map((test) => {
      if (test.id !== activeTest.id) return test;
      const frame = cloneFrame(editableFrame(test, frameKind, intermediateIndex));
      frame.voxels = placement
        ? placeObjectInCell(frame.voxels, placement, blockDefinitionsById).objects
        : eraseOneObjectAtCell(frame.voxels, { x, y, z }, surface?.selectionKey).objects;
      return replaceEditableFrame(test, frameKind, intermediateIndex, frame);
    }));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
  };

  const removeCellOccupant = (selectionKey: string) => {
    if (!activeTest || activeTestLocked || !inspectedCell) return;
    const currentFrame = editableFrame(activeTest, frameKind, intermediateIndex);
    if (!currentFrame.voxels.some((voxel) => cellObjectSelectionKey(voxel) === selectionKey)) return;
    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: currentFrame,
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) => {
      if (test.id !== activeTest.id) return test;
      const frame = cloneFrame(editableFrame(test, frameKind, intermediateIndex));
      frame.voxels = frame.voxels.filter(
        (voxel) => cellObjectSelectionKey(voxel) !== selectionKey,
      );
      return replaceEditableFrame(test, frameKind, intermediateIndex, frame);
    }));
    setGroupSelection((current) => {
      if (!current) return null;
      const keys = current.keys.filter((key) => key !== selectionKey);
      return keys.length ? { ...current, keys } : null;
    });
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setToast("Removed one object from the cell");
  };

  const selectCellOccupant = (selectionKey: string) => {
    if (!activeTest) return;
    const currentKeys = activeGroupSelection?.keys ?? [];
    const selection = toggleVoxelGroupSelection(currentKeys, [selectionKey], false);
    setGroupSelection(selection.keys.length ? {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      keys: selection.keys,
    } : null);
    setToast(selection.deselected ? "Object deselected" : "Selected one cell occupant");
  };

  const clearInspectedCell = () => {
    if (!activeTest || activeTestLocked || !inspectedCell || !inspectedCellOccupants.length) return;
    const currentFrame = editableFrame(activeTest, frameKind, intermediateIndex);
    const coordinate = keyOf(inspectedCell);
    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: currentFrame,
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) => {
      if (test.id !== activeTest.id) return test;
      const frame = cloneFrame(editableFrame(test, frameKind, intermediateIndex));
      frame.voxels = frame.voxels.filter((voxel) => keyOf(voxel) !== coordinate);
      return replaceEditableFrame(test, frameKind, intermediateIndex, frame);
    }));
    setGroupSelection(null);
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setToast(`Cleared ${inspectedCellOccupants.length} objects from the cell`);
  };

  const addFolder = (requestedName: string, parentId?: string) => {
    const name = requestedName.trim();
    if (!name) return;
    const requestedParent = folders.find((folder) => folder.id === parentId);
    const effectiveParentId = requestedParent?.parentId ?? parentId;
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tag";
    const existingIds = new Set(folders.map((folder) => folder.id));
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    let defaultId = `${id}-default`;
    let defaultSuffix = 2;
    while (existingIds.has(defaultId)) defaultId = `${id}-default-${defaultSuffix++}`;
    setFolders((current) => [
      ...current.map((folder) =>
        folder.id === effectiveParentId ? { ...folder, collapsed: false } : folder),
      {
        collapsed: false,
        id,
        locked: false,
        name,
        ...(effectiveParentId ? { parentId: effectiveParentId } : {}),
      },
      ...(!effectiveParentId ? [{
        collapsed: false,
        default: true,
        id: defaultId,
        locked: false,
        name: "Default",
        parentId: id,
      } satisfies TestFolder] : []),
    ]);
    setToast(`${name} ${effectiveParentId ? "subtag" : "tag group"} created`);
  };

  const deleteFolder = (folderId: string) => {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) return;
    const rootFolders = folders.filter((item) => !item.parentId);
    if (folder.default) {
      setToast("Default is a reserved subtag and cannot be deleted");
      return;
    }
    if (!folder.parentId && rootFolders.length <= 1) {
      setToast("The final parent tag group cannot be deleted");
      return;
    }
    const deletedIds = new Set(folder.parentId
      ? [folder.id]
      : folders.filter((item) => item.id === folder.id || item.parentId === folder.id).map((item) => item.id));
    const referencedTests = tests.filter((test) => testUsesTag(test, folder));
    if (referencedTests.length) {
      setToast(`${folder.name} is still used by ${referencedTests.length} test${referencedTests.length === 1 ? "" : "s"}`);
      return;
    }
    setFolders((current) => current.filter((item) => !deletedIds.has(item.id)));
    setToast(`${folder.name} deleted`);
  };

  const toggleTestLocked = (testId: string) => {
    const test = tests.find((item) => item.id === testId);
    if (!test) return;
    const locked = !test.locked;
    setTests((current) => current.map((item) =>
      item.id === testId ? { ...item, locked } : item,
    ));
    endPaintGesture();
    setToast(`${test.name} ${locked ? "locked" : "unlocked"}`);
  };

  const toggleTestHidden = (testId: string) => {
    const test = tests.find((item) => item.id === testId);
    if (!test) return;
    const hidden = !test.hidden;
    setTests((current) => current.map((item) =>
      item.id === testId ? { ...item, hidden } : item,
    ));
    setResults((current) => {
      const next = { ...current };
      delete next[testId];
      return next;
    });
    if (testId === activeId) setShowResult(false);
    setToast(hidden
      ? `${test.name} hidden · physics runs will ignore it`
      : `${test.name} restored to physics runs`);
  };

  const updateTestMetadata = (
    testId: string,
    patch: Partial<Pick<TestCase, "name" | "description">>,
  ) => {
    const test = tests.find((item) => item.id === testId);
    if (!test) return;
    setTests((current) => current.map((item) =>
      item.id === testId ? { ...item, ...patch } : item,
    ));
  };

  const addTest = (requestedFolderId?: string, requestedTagIds?: string[]) => {
    const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
    const requestedFolder = folders.find((folder) => folder.id === requestedFolderId);
    const activeFolder = folders.find((folder) => folder.id === activeTest?.folderId);
    const targetFolder = requestedFolder
      ? requestedFolder
      : activeFolder
        ? activeFolder
        : folders.find((folder) => !folder.parentId);
    if (!targetFolder) {
      setToast("Create a parent tag group before adding a test");
      return;
    }
    const existingIds = new Set(tests.map((test) => test.id));
    let suffix = tests.length + 1;
    let id = `test-${suffix}`;
    while (existingIds.has(id)) {
      suffix += 1;
      id = `test-${suffix}`;
    }
    const testWorld = activeTest ? { ...activeTest.world } : { ...DEFAULT_WORLD };
    const source = activeTest?.start ?? { voxels: floorFrame(testWorld.width, testWorld.height) };
    const folderId = rootTagId(targetFolder.id, foldersById) ?? targetFolder.id;
    const placement = normalizeTestTagPlacement({
      directTagIds: requestedTagIds?.length
        ? requestedTagIds
        : [targetFolder.id === folderId
          ? defaultSubtagId(folderId, folders) ?? folderId
          : targetFolder.id],
      preferredTagId: folderId,
    }, folders);
    if (!placement.tagIds.length) {
      setToast("This tag group needs a Default subtag before adding tests");
      return;
    }
    const test: TestCase = {
      description: "",
      folderId: placement.groupTagId,
      tagIds: placement.tagIds,
      id,
      hidden: false,
      locked: false,
      name: `Untitled test ${tests.length + 1}`,
      input: "up",
      intermediate: [],
      start: cloneFrame(source),
      expected: cloneFrame(source),
      world: testWorld,
    };
    setTests((current) => [...current, test]);
    setActiveId(id);
    setFrameKind("start");
    setIntermediateIndex(null);
    setShowResult(false);
    setActiveWorkspace("tests");
    setToast(`New test added to ${placement.tagIds.map((tagId) => folderPathLabel(folders, tagId)).join(" + ")}`);
  };

  const reorderTest = (testId: string, targetTestId: string) => {
    const test = tests.find((item) => item.id === testId);
    const target = tests.find((item) => item.id === targetTestId);
    if (!test || !target) return;
    setTests((current) => {
      const sourceGlobalIndex = current.findIndex((item) => item.id === test.id);
      const targetGlobalIndex = current.findIndex((item) => item.id === target.id);
      if (sourceGlobalIndex < 0 || targetGlobalIndex < 0) return current;
      const next = [...current];
      [next[sourceGlobalIndex], next[targetGlobalIndex]] = [next[targetGlobalIndex], next[sourceGlobalIndex]];
      return next;
    });
    setToast(`${test.name} rearranged`);
  };

  const duplicateTest = (testId: string) => {
    const source = tests.find((test) => test.id === testId);
    if (!source) return;
    const existingIds = new Set(tests.map((test) => test.id));
    const baseId = `${source.id}-copy`;
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const duplicate: TestCase = {
      ...source,
      tagIds: [...source.tagIds],
      expected: cloneFrame(source.expected),
      intermediate: source.intermediate.map(cloneFrame),
      id,
      hidden: false,
      locked: false,
      name: `${source.name} copy`,
      start: cloneFrame(source.start),
      world: { ...source.world },
    };
    setTests((current) => {
      const sourceIndex = current.findIndex((test) => test.id === source.id);
      const next = [...current];
      next.splice(sourceIndex + 1, 0, duplicate);
      return next;
    });
    setActiveId(id);
    setFrameKind("start");
    setIntermediateIndex(null);
    setShowResult(false);
    setToast(`${source.name} duplicated`);
  };

  const deleteTest = (testId: string) => {
    const source = tests.find((test) => test.id === testId);
    if (!source) return;
    if (source.locked) {
      setToast("Unlock this test before deleting it");
      return;
    }
    if (tests.length <= 1) {
      setToast("The editor needs at least one test case");
      return;
    }
    if (!window.confirm(`Delete “${source.name}”? This cannot be undone.`)) return;

    const deletion = deleteTestCase(tests, testId, activeId);
    if (!deletion.removed) return;
    setTests(deletion.tests);
    setActiveId(deletion.activeId);
    setResults((current) => {
      const next = { ...current };
      delete next[testId];
      return next;
    });
    if (activeId === testId) {
      setFrameKind("start");
      setIntermediateIndex(null);
      setShowResult(false);
    }
    setGroupSelection((current) => current?.testId === testId ? null : current);
    undoStackRef.current = undoStackRef.current.filter((snapshot) => snapshot.testId !== testId);
    redoStackRef.current = redoStackRef.current.filter((snapshot) => snapshot.testId !== testId);
    syncHistoryState();
    endPaintGesture();
    setToast(`${source.name} deleted`);
  };

  const changeTestTagGroup = (testId: string, folderId: string) => {
    const test = tests.find((item) => item.id === testId);
    const targetGroup = folders.find((folder) => folder.id === folderId && !folder.parentId);
    const defaultId = defaultSubtagId(folderId, folders);
    if (!test || !targetGroup || !defaultId || test.folderId === folderId) return;
    setTests((current) => current.map((item) => item.id === testId
      ? { ...item, folderId, tagIds: [defaultId] }
      : item));
    setToast(`${test.name} moved to ${targetGroup.name} / Default`);
  };

  const toggleTestTag = (testId: string, folderId: string) => {
    const test = tests.find((item) => item.id === testId);
    const targetFolder = folders.find((folder) => folder.id === folderId);
    if (!test || !targetFolder) return;
    const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
    if (targetFolder.id === test.folderId || rootTagId(targetFolder.id, foldersById) !== test.folderId) {
      setToast("Subtags must stay inside the test's parent tag group");
      return;
    }
    const defaultId = defaultSubtagId(test.folderId, folders);
    if (!defaultId) return;
    const removing = test.tagIds.includes(folderId);
    setTests((current) => current.map((item) =>
      item.id === testId
        ? (() => {
          if (targetFolder.default) return { ...item, tagIds: [defaultId] };
          let tagIds = removing
            ? item.tagIds.filter((tagId) => tagId !== folderId)
            : [...item.tagIds.filter((tagId) => tagId !== defaultId), folderId];
          if (!tagIds.length) tagIds = [defaultId];
          return { ...item, tagIds };
        })()
        : item,
    ));
    setToast(`${test.name} ${targetFolder.default ? "returned to" : removing ? "removed from" : "tagged"} ${folderPathLabel(folders, targetFolder.default ? defaultId : folderId)}`);
  };

  const openTestInEditor = (testId: string) => {
    setActiveId(testId);
    setFrameKind("start");
    setIntermediateIndex(null);
    setGeneratedTimeline(null);
    setGroupSelection(null);
    setShowResult(shouldShowResultComparison(results[testId]));
    setActiveWorkspace("tests");
  };

  const duplicateFrame = () => {
    if (!activeTest || activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind: "expected",
      intermediateIndex: null,
      frame: activeTest.expected,
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) =>
      test.id === activeTest.id
        ? { ...test, expected: cropFrameToWorld(test.start, test.world) }
        : test,
    ));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setFrameKind("expected");
    setIntermediateIndex(null);
    setShowResult(false);
    setToast("Start frame copied to expected");
  };

  const addIntermediateFrame = () => {
    if (!activeTest || activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const insertion = insertIntermediateFrame(activeTest, frameKind, intermediateIndex);
    setTests((current) => current.map((test) =>
      test.id === activeTest.id ? insertion.test : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setGeneratedTimeline(null);
    setGroupSelection(null);
    setFrameKind("expected");
    setIntermediateIndex(insertion.insertionIndex);
    setShowResult(false);
    clearHistory();
    setToast(`Tick ${insertion.insertionIndex + 1} added as a copy of the previous frame`);
  };

  const copyPreviousFrame = () => {
    if (!activeTest || activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    const source = previousExpectedFrame(activeTest, frameKind, intermediateIndex);
    if (!source) {
      setToast("The Start frame has no previous frame");
      return;
    }
    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: editableFrame(activeTest, frameKind, intermediateIndex),
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) =>
      test.id === activeTest.id
        ? replaceEditableFrame(test, frameKind, intermediateIndex, cloneFrame(source))
        : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setGeneratedTimeline(null);
    setGroupSelection(null);
    setShowResult(false);
    setToast(`${intermediateIndex === null ? "Expected" : `Tick ${intermediateIndex + 1}`} copied from its previous frame`);
  };

  const deleteIntermediateFrame = () => {
    if (!activeTest || intermediateIndex === null || activeTestLocked) {
      setToast(activeTestLocked ? "This test is locked" : "Select an intermediate tick first");
      return;
    }
    const removedTick = intermediateIndex + 1;
    const remainingCount = activeTest.intermediate.length - 1;
    setTests((current) => current.map((test) => {
      if (test.id !== activeTest.id) return test;
      return {
        ...adjustCycleForDeletedTick(test, removedTick),
        intermediate: test.intermediate.filter((_, index) => index !== intermediateIndex),
      };
    }));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setGeneratedTimeline(null);
    setGroupSelection(null);
    setShowResult(false);
    clearHistory();
    if (remainingCount === 0) {
      setFrameKind("expected");
      setIntermediateIndex(null);
    } else {
      setIntermediateIndex(Math.min(intermediateIndex, remainingCount - 1));
    }
    setToast(`Tick ${removedTick} removed from the expected timeline`);
  };

  const setCycleStartAtSelection = () => {
    if (!activeTest || activeTestLocked || selectedTimelineTick === null) return;
    if (selectedTimelineTick >= activeTest.intermediate.length) {
      setToast("Cycle start must come before a later repeated tick");
      return;
    }
    setTests((current) => current.map((test) =>
      test.id === activeTest.id ? markCycleStart(test, selectedTimelineTick) : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setToast(`Cycle starts at ${selectedTimelineTick === 0 ? "Start" : `Tick ${selectedTimelineTick}`}`);
  };

  const setCycleRepeatAtSelection = () => {
    if (!activeTest || activeTestLocked || selectedTimelineTick === null) return;
    if (selectedTimelineTick <= 0) {
      setToast("The repeated cycle state must be an intermediate tick");
      return;
    }
    setTests((current) => current.map((test) =>
      test.id === activeTest.id ? markCycleRepeat(test, selectedTimelineTick) : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    const startTick = activeTest.cycle?.startTick ?? 0;
    setToast(`Cycle repeats at Tick ${selectedTimelineTick} · period ${selectedTimelineTick - Math.min(startTick, selectedTimelineTick - 1)}`);
  };

  const clearCycle = () => {
    if (!activeTest || activeTestLocked || !activeTest.cycle) return;
    setTests((current) => current.map((test) =>
      test.id === activeTest.id ? clearCycleExpectation(test) : test));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setToast("Cycle markers cleared");
  };

  const resetRoom = () => {
    if (!activeTest || activeTestLocked) {
      setToast("This test is locked");
      return;
    }
    pushHistory(undoStackRef, {
      testId: activeTest.id,
      frameKind,
      intermediateIndex,
      frame: editableFrame(activeTest, frameKind, intermediateIndex),
    });
    redoStackRef.current = [];
    syncHistoryState();
    setTests((current) => current.map((test) =>
      test.id === activeTest.id
        ? replaceEditableFrame(
          test,
          frameKind,
          intermediateIndex,
          defaultRoomFloor(test.world.width, test.world.height),
        )
        : test,
    ));
    setResults((current) => {
      const next = { ...current };
      delete next[activeTest.id];
      return next;
    });
    setShowResult(false);
    setToast(`${intermediateIndex === null
      ? frameKind === "start" ? "Start" : "Expected"
      : `Tick ${intermediateIndex + 1}`} room reset to floor tiles`);
  };

  const addBlock = () => {
    const name = newBlock.name.trim();
    if (!name) return;
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "block";
    const existingIds = new Set(blocks.map((block) => block.id));
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const isGeneric = roles.find((role) => role.id === newBlock.roleId)?.generic === true;
    setBlocks((current) => [...current, { id, ...newBlock, name }]);
    if (isGeneric) {
      setGenericPrompt({ blockId: id, value: "0" });
      setGenericPromptError("");
    } else {
      setSelectedBlock(id);
    }
    setNewBlock({
      name: "",
      color: "#D96B5F",
      roleId: roles[0]?.id ?? "solid",
      occupancy: "solid",
      visual: { kind: "cube" },
    });
    setAddingBlock(false);
    setToast(isGeneric ? `${name} created · choose its generic object ID` : `${name} block created`);
  };

  const updateBlockRole = (block: BlockDefinition, roleId: string) => {
    const generic = roles.find((role) => role.id === roleId)?.generic === true;
    const affected = new Set([block.id]);
    const normalizeFrame = (frame: Frame) => enforceFloorModeForBlocks(
      setGenericModeForBlocks(frame, affected, generic),
      affected,
      roleId === "floor",
    );
    setBlocks((current) => current.map((item) =>
      item.id === block.id ? { ...item, roleId } : item));
    setTests((current) => current.map((test) => isTestLocked(test) ? test : {
      ...test,
      start: normalizeFrame(test.start),
      intermediate: test.intermediate.map(normalizeFrame),
      expected: normalizeFrame(test.expected),
    }));
    if (roleId === "floor") {
      setSavedSearchLevels((current) => current.map((level) => ({
        ...level,
        voxels: level.voxels.filter((voxel) => voxel.blockId !== block.id || voxel.z === 0),
      })));
    }
    setSelectedRoleId(roleId);
    setResults({});
  };

  const addRole = () => {
    const name = newRole.name.trim();
    if (!name) return;
    const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role";
    const existingIds = new Set(roles.map((role) => role.id));
    let id = baseId;
    let suffix = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const role: PhysicsRoleDefinition = {
      id,
      name,
      description: newRole.description.trim(),
      generic: newRole.generic,
    };
    setRoles((current) => [...current, role]);
    setSelectedRoleId(id);
    setNewRole({ name: "", description: "", generic: false });
    setAddingRole(false);
    setToast(`${name} role created · ready for C++ behavior`);
  };

  const updateSelectedRole = (patch: Partial<Pick<PhysicsRoleDefinition, "name" | "description" | "generic">>) => {
    setRoles((current) => current.map((role) =>
      role.id === selectedRoleId ? { ...role, ...patch } : role,
    ));
  };

  const exportProject = async () => {
    const project = {
      schemaVersion: 15,
      coordinateSystem: { horizontalAxes: ["x", "y"], verticalAxis: "z", floorLayer: 0 },
      roles,
      blocks,
      tags: folders,
      searches: savedSearchLevels,
      tests,
    };
    try {
      const payload = await projectCodecRef.current!.encode(project);
      const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "voxelbench-project.compact.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setToast("Compact project exported");
    } catch {
      setToast("Could not export the project. Your edits are still open.");
    }
  };

  const importProject = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      try {
        const parsed = decodeProjectPayload(JSON.parse(text)) as {
          blocks: StoredBlockDefinition[];
          folders?: StoredTestFolder[];
          tags?: StoredTestFolder[];
          roles?: PhysicsRoleDefinition[];
          searches?: unknown;
          tests: StoredTestCase[];
          world?: WorldSettings;
        };
        if (!parsed.blocks?.length || !parsed.tests?.length) throw new Error("Invalid project");
        const legacyWorld = normalizeWorld(parsed.world ?? DEFAULT_WORLD);
        const importedRoles = normalizeRoles(parsed.roles);
        const importedFolders = normalizeFolders(parsed.tags ?? parsed.folders);
        const importedBlocks = normalizeBlocks(parsed.blocks, importedRoles);
        const importedTests = normalizeTests(
          parsed.tests,
          importedFolders,
          importedBlocks,
          importedRoles,
          parsed.blocks,
          legacyWorld,
        );
        setRoles(importedRoles);
        setFolders(importedFolders);
        setBlocks(importedBlocks);
        setNewBlock((current) => ({
          ...current,
          roleId: importedRoles.some((role) => role.id === current.roleId)
            ? current.roleId
            : importedRoles[0].id,
        }));
        setTests(importedTests);
        setSavedSearchLevels(normalizeSearchLevels(parsed.searches, importedBlocks));
        setActiveId(importedTests[0].id);
        setFrameKind("start");
        setIntermediateIndex(null);
        setGeneratedTimeline(null);
        setResults({});
        clearHistory();
        setSelectedRoleId(importedRoles[0].id);
        setToast(`Imported ${importedTests.length} tests across ${importedFolders.length} tags`);
      } catch {
        setToast("That file is not a valid VoxelBench project");
      }
    });
    event.target.value = "";
  };

  const counts = useMemo(() => {
    const runnableIds = new Set(runnableTestCases(tests).map((test) => test.id));
    const values = Object.entries(results)
      .filter(([testId]) => runnableIds.has(testId))
      .map(([, result]) => result);
    return {
      hidden: tests.length - runnableIds.size,
      passed: values.filter((result) => result.pass).length,
      failed: values.filter((result) => !result.pass).length,
      runnable: runnableIds.size,
    };
  }, [results, tests]);

  if (!activeTest) return null;

  return (
    <main className={`app-shell ${activeWorkspace === "tests" ? "maze-editor lab-editor" : ""}`}>
      {activeWorkspace === "tests" ? <header className="editor-topbar">
        <div className="editor-navigation">
          <button className="back-link" onClick={() => setActiveWorkspace("suite")} title="Back to the test library"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg><span>Back</span></button>
          <div className="editor-title"><strong>Editor</strong><span className="editor-room-name" title={activeTest.name}>{activeTest.name}</span></div>
        </div>
        <nav className="editor-actions" aria-label="Editor actions">
          <button className="primary" disabled={activeTest.hidden} title="Run this test in all four directions (⌘Enter / Ctrl+Enter)" onClick={() => runTest(activeTest)}>Run test</button>
          <button disabled={activeTestLocked || !historyState.canUndo} title="Undo last edit (⌘Z / Ctrl+Z)" onClick={undoPaint}>Undo</button>
          <button disabled={activeTestLocked || !historyState.canRedo} title="Redo last edit (⇧⌘Z / Ctrl+Shift+Z)" onClick={redoPaint}>Redo</button>
          <details className="editor-menu"><summary aria-label="More editor actions"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></summary><div className="menu-items">
            <button className="lab-mobile-redo" disabled={activeTestLocked || !historyState.canRedo} onClick={redoPaint}>Redo</button>
            <button onClick={() => toggleTestLocked(activeTest.id)}>{activeTestLocked ? "Unlock test" : "Lock test"}</button>
            <button onClick={() => importRef.current?.click()}>Import JSON…</button>
            <button onClick={exportProject}>Export JSON</button>
            <button onClick={() => setActiveWorkspace("suite")}>Test library</button>
            <button onClick={() => setActiveWorkspace("search")}>Search</button>
          </div></details>
        </nav>
      </header> : <header className="author-header">
        <div className="author-topbar">
          <nav className="author-nav" aria-label="Maze Bench navigation">
            {/* Leave the lab for the main site's static map, outside the app router. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a className="nav-link home-back-link" href="/" aria-label="Back to home" title="Back to home">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
              <span>Back</span>
            </a>
            <button className="nav-link" aria-pressed={false} onClick={() => setActiveWorkspace("tests")}>Editor</button>
            <button className={`nav-link ${activeWorkspace === "suite" ? "is-active" : ""}`} aria-pressed={activeWorkspace === "suite"} onClick={() => setActiveWorkspace("suite")}>Test Suite</button>
            <button className={`nav-link ${activeWorkspace === "search" ? "is-active" : ""}`} aria-pressed={activeWorkspace === "search"} onClick={() => setActiveWorkspace("search")}>Search</button>
          </nav>
          <div className="author-title">
            <span>{activeWorkspace === "suite" ? "TEST LIBRARY" : "EVOLUTIONARY LAB"}</span>
            <h1>{activeWorkspace === "suite" ? "Test Suite" : "3D Puzzle Search"}</h1>
          </div>
          <div className="author-actions">
            <details className="project-actions"><summary>Project <span aria-hidden="true">⌄</span></summary><div>
              <button type="button" onClick={() => importRef.current?.click()}>Import JSON…</button>
              <button type="button" onClick={exportProject}>Export JSON</button>
            </div></details>
            {activeWorkspace === "suite" && <button className="tool-button tool-button--primary" onClick={runSuite} disabled={suiteProgress !== null}>{suiteProgress === null ? "Run suite" : `Running ${suiteProgress} / ${runnableTestCases(tests).length}`}</button>}
          </div>
          {toast && <p className="author-status" role="status"><span />{toast}</p>}
        </div>
      </header>}
      <input ref={importRef} type="file" accept="application/json" hidden onChange={importProject} />
      {toast && activeWorkspace === "tests" && <p className="lab-editor-status" role="status">{toast}</p>}

      {saveConflict && <div className="save-conflict" role="alert">
        <span>Saving paused: the project changed on disk. Your unsaved edits are still in this tab; export them before reloading.</span>
        <button type="button" onClick={exportProject}>Export draft</button>
        <button type="button" onClick={() => { if (window.confirm("Reload the saved project? Unsaved edits in this tab will be discarded. Export your draft first if you need to keep them.")) window.location.reload(); }}>Reload saved project</button>
      </div>}

      {activeWorkspace === "search" && (
        <SearchBench
          blocks={blocks}
          roles={roles}
          savedLevels={savedSearchLevels}
          onSavedLevelsChange={setSavedSearchLevels}
          onStatus={setToast}
        />
      )}

      {activeWorkspace === "suite" && (
        <TestSuiteWorkspace
          activeId={activeId}
          blocks={blocks}
          folders={folders}
          genericBlockIds={genericBlockIds}
          results={results}
          tests={tests}
          onAddFolder={addFolder}
          onAddTest={addTest}
          onDeleteFolder={deleteFolder}
          onDeleteTest={deleteTest}
          onDuplicateTest={duplicateTest}
          onChangeTestGroup={changeTestTagGroup}
          onToggleTestTag={toggleTestTag}
          onOpenTest={openTestInEditor}
          onRenameFolder={(folderId, name) => setFolders((current) => current.map((folder) => folder.id === folderId ? { ...folder, name } : folder))}
          onReorderTest={reorderTest}
          onRunTest={runTest}
          onToggleTestHidden={toggleTestHidden}
          onToggleTestLocked={toggleTestLocked}
          onUpdateTest={updateTestMetadata}
        />
      )}

      {activeWorkspace === "tests" && <section className="editor-layout">
        <section className="lab-editor-workspace">
          <div className="editor-toolbar" aria-label="Frame controls">
              <div className="frame-switch" role="group" aria-label="Frame to edit">
                <button className={`${frameKind === "start" && intermediateIndex === null ? "active" : ""} ${tickIsInCycle(activeTest.cycle, 0) ? "cycle-span" : ""} ${activeTest.cycle?.startTick === 0 ? "cycle-start" : ""}`} title={activeTest.cycle?.startTick === 0 ? "Cycle begins here" : undefined} onClick={() => { setFrameKind("start"); setIntermediateIndex(null); setGroupSelection(null); }}><span>01</span> Start</button>
                {activeTest.intermediate.map((_, index) => (
                  <button key={index} className={`${intermediateIndex === index ? "active" : ""} ${tickIsInCycle(activeTest.cycle, index + 1) ? "cycle-span" : ""} ${activeTest.cycle?.startTick === index + 1 ? "cycle-start" : ""} ${activeTest.cycle?.repeatTick === index + 1 ? "cycle-repeat" : ""}`} title={activeTest.cycle?.startTick === index + 1 ? "Cycle begins here" : activeTest.cycle?.repeatTick === index + 1 ? "Full state repeats here" : tickIsInCycle(activeTest.cycle, index + 1) ? "Inside expected cycle" : undefined} onClick={() => { setFrameKind("expected"); setIntermediateIndex(index); setGroupSelection(null); }}><span>{String(index + 2).padStart(2, "0")}</span> Tick {index + 1}</button>
                ))}
                <button className={frameKind === "expected" && intermediateIndex === null ? "active" : ""} onClick={() => { setFrameKind("expected"); setIntermediateIndex(null); setGroupSelection(null); }}><span>{String(activeTest.intermediate.length + 2).padStart(2, "0")}</span> Expected</button>
              </div>
              <details className="editor-frame-menu"><summary>Frame <span aria-hidden="true">⌄</span></summary><div>
              {frameKind === "expected" && intermediateIndex === null && <button type="button" className="copy-start-button" title="Replace expected room with a copy of the start room" disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); duplicateFrame(); }}>Copy from start room</button>}
              <button type="button" className="add-tick-button" title="Insert an expected tick after the selected frame" disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); addIntermediateFrame(); }}>Add tick</button>
              {frameKind === "expected" && <button type="button" className="copy-previous-button" title="Replace this frame with a copy of the frame immediately before it" disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); copyPreviousFrame(); }}>Copy previous</button>}
              {intermediateIndex !== null && <button type="button" className="delete-tick-button" title={`Remove expected tick ${intermediateIndex + 1}`} disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); deleteIntermediateFrame(); }}>Delete tick</button>}
              {selectedTimelineTick !== null && <button type="button" className="cycle-mark-button cycle-mark-button--start" disabled={activeTestLocked || selectedTimelineTick >= activeTest.intermediate.length} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setCycleStartAtSelection(); }}>Loop starts</button>}
              {selectedTimelineTick !== null && selectedTimelineTick > 0 && <button type="button" className="cycle-mark-button cycle-mark-button--repeat" disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); setCycleRepeatAtSelection(); }}>Repeats here</button>}
              {activeTest.cycle && <button type="button" className="cycle-clear-button" disabled={activeTestLocked} title={`Cycle ${activeTest.cycle.startTick}→${activeTest.cycle.repeatTick} · period ${activeTest.cycle.repeatTick - activeTest.cycle.startTick}`} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); clearCycle(); }}>Clear loop</button>}
              <button type="button" className="reset-room-button" disabled={activeTestLocked} onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); resetRoom(); }}>Reset room</button>
              </div></details>
              <button type="button" className="tool-button editor-generate" disabled={activeTestLocked} onClick={generateTimeline}>Generate frames</button>
          </div>
          <section className="editor-stage lab-editor-stage is-ready" aria-label="Voxel frame editor">
            <MazeBenchCanvas cameraSceneKey={activeTest.id} frame={activeFrame} blocks={blocks} genericBlockIds={genericBlockIds} world={activeWorld} layer={layer} selectedVoxelKeys={selectedVoxelKeys} selectionMode={groupSelectionMode} selectedBlock={selectedBlock} selectedBlockCanShare={selectedBlockCanShare} eraseMode={selectedBlock === DELETE_TOOL_ID} interactive paintable={!activeTestLocked} onCameraQuarterTurnChange={setCameraQuarterTurns} onSelectVoxel={selectVoxelGroup} onSelectVoxels={selectVoxelGroups} onPaint={paint} onPaintGestureStart={beginPaintGesture} onPaintGestureEnd={endPaintGesture} />
            {generatedTimeline?.testId === activeTest.id && (
              <section className="timeline-review" aria-label="Generated C++ timeline review">
                <div className="timeline-review__heading"><div><span>C++ GENERATED · NOT SAVED</span><strong>{generatedTimeline.cycle ? `${generatedTimeline.cycle.repeatTick} ticks + rollback · loop ${generatedTimeline.cycle.startTick}→${generatedTimeline.cycle.repeatTick}` : `${generatedTimeline.frames.length} tick ${generatedTimeline.frames.length === 1 ? "frame" : "frames"}`}</strong></div><div><button className="tool-button" onClick={() => setGeneratedTimeline(null)}>Discard</button><button className="tool-button tool-button--primary" disabled={activeTestLocked} onClick={acceptGeneratedTimeline}>Accept frames</button></div></div>
                <TimelineSnapshotStrip
                  key={generatedTimeline.generationId}
                  blocks={blocks}
                  cycle={generatedTimeline.cycle}
                  final={generatedTimeline.final}
                  frames={generatedTimeline.frames}
                  genericBlockIds={genericBlockIds}
                  layer={layer}
                  start={activeTest.start}
                  world={activeWorld}
                />
              </section>
            )}
            {genericPrompt && (
              <div className="generic-id-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) setGenericPrompt(null); }}>
                <section className="generic-id-modal" role="dialog" aria-modal="true" aria-labelledby="generic-id-title" aria-describedby="generic-id-message">
                  <span className="generic-id-modal__eyebrow">{blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "lift" ? "Lift state" : blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "gate" ? "Gate state" : blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "puncher" ? "Puncher state" : blocks.find((block) => block.id === genericPrompt.blockId)?.roleId === "orange-wall" ? "Orange mechanism state" : "Generic numbered family"}</span>
                  <h2 id="generic-id-title">Choose {blocks.find((block) => block.id === genericPrompt.blockId)?.name ?? "object"} {blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "lift" || blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "gate" || blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "puncher" ? "state" : blocks.find((block) => block.id === genericPrompt.blockId)?.roleId === "orange-wall" ? "remaining rise" : "ID"}</h2>
                  <p id="generic-id-message">{blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "lift" ? "Use 0 for lowered or 1 for raised. The face you paint chooses Up, Front, Right, Back, or Left and stores the matching full ID from 0–9." : blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "gate" ? "Use 0 for the lowered red slab or 1 for the raised red gate cube." : blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "puncher" ? "Use 0 for the unsprung puncher or 1 for the sprung puncher. The side face you paint chooses its punch direction." : blocks.find((block) => block.id === genericPrompt.blockId)?.roleId === "orange-wall" ? "Use 0 when it will not rise. N means this wall or slope still needs to rise N mechanism steps." : "Cubes painted with the same number belong to the same generic object."}</p>
                  <label className="field"><span>{blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "puncher" ? "State (0 unsprung · 1 sprung)" : blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "lift" || blocks.find((block) => block.id === genericPrompt.blockId)?.visual.kind === "gate" ? "State (0 lowered · 1 raised)" : blocks.find((block) => block.id === genericPrompt.blockId)?.roleId === "orange-wall" ? "Remaining rise (0 or more)" : "ID (0 or more)"}</span><input ref={genericIdInputRef} inputMode="numeric" value={genericPrompt.value} aria-invalid={Boolean(genericPromptError)} onChange={(event) => { setGenericPrompt((current) => current ? { ...current, value: event.target.value } : current); setGenericPromptError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); confirmGenericSelection(); } else if (event.key === "Escape") { event.preventDefault(); setGenericPrompt(null); } }} /></label>
                  {genericPromptError && <small className="generic-id-modal__error" role="alert">{genericPromptError}</small>}
                  <div className="generic-id-modal__actions"><button className="tool-button" type="button" onClick={() => setGenericPrompt(null)}>Cancel</button><button className="tool-button tool-button--primary" type="button" onClick={confirmGenericSelection}>Select</button></div>
                </section>
              </div>
            )}
            {showResult && activeResult && !activeResult.pass && (
              <FailureTraceComparison
                blocks={blocks}
                genericBlockIds={genericBlockIds}
                layer={layer}
                onClose={() => setShowResult(false)}
                result={activeResult}
              />
            )}
          </section>
        </section>

        <aside className="editor-sidebar lab-editor-sidebar" aria-label="Editor tools and test settings">
            <section className="panel tools-panel">
              <div className="panel-heading"><div><span>Toolbox</span><strong>{selectedToolName}</strong></div></div>
              <p className="description">{groupSelectionMode || activeGroupSelection ? "Select objects to move together. Shift-drag selects an area." : selectedBlock === DELETE_TOOL_ID ? "Click an object to remove it." : roles.find((role) => role.id === selectedDefinition?.roleId)?.description || "Select a tool, then click a face to place it."}</p>
              <div id="lab-toolbox" className="toolbox" aria-label="MazeBench tools">
                <button type="button" className={`tool eraser-tool ${!groupSelectionMode && !activeGroupSelection && selectedBlock === DELETE_TOOL_ID ? "is-current" : ""}`} aria-label="Erase tool" title="Erase cube · X · ←/→ chooses tools" onClick={() => { setGenericPrompt(null); setGroupToolPinned(false); setGroupSelection(null); setSelectedBlock(DELETE_TOOL_ID); setToast("Erase tool selected"); }}>
                  <span>ERASE</span>

                </button>
                <button type="button" className={`tool group-tool ${groupSelectionMode || activeGroupSelection ? "is-current" : ""}`} aria-label="Select group tool" aria-pressed={groupToolPinned} title="Camera-relative arrows · Shift+↑/↓ changes layer · Delete erases" onClick={activateGroupTool}>
                  <span>G</span>
                  <span className="group-tool-icon" aria-hidden="true"><i /><i /><i /></span>
                </button>
                {blocks.map((block, index) => {
                  const generic = genericBlockIds.has(block.id);
                  const binaryStateId = binaryVisualState(
                    block,
                    selectedGenericIds[block.id] ?? 0,
                  );
                  const binaryStateRaised = binaryStateId === 1;
                  const orangeWallDepth = block.roleId === "orange-wall"
                    ? selectedOrangeWallDepths[block.id] ?? 0
                    : null;
                  const hiddenButton = block.visual.kind === "button" &&
                    block.visual.buttonForm === "hidden";
                  const hiddenOrangeWall = block.roleId === "orange-wall" &&
                    block.visual.orangeForm === "hidden";
                  const slopeDirection = block.visual.kind === "slope"
                    ? cameraFacingSlopeDirection(cameraQuarterTurns)
                    : null;
                  const slopeOption = slopeDirection
                    ? SLOPE_DIRECTION_OPTIONS.find((option) => option.id === slopeDirection)
                    : null;
                  const isPuncher = block.visual.kind === "puncher";
                  const genericLabel = generic
                    ? genericToolbarLabel(
                      block.id,
                      selectedBlock,
                      binaryStateId ?? selectedGenericIds[block.id] ?? 0,
                      groupToolPinned || Boolean(genericPrompt),
                      )
                    : orangeWallDepth === null
                      ? undefined
                      : String(orangeWallDepth);
                  const title = orangeWallDepth !== null
                    ? `${hiddenOrangeWall ? "invisible" : "visible"} · ${orangeWallDepth} remaining rise · may overlap any cell · ←/→ changes remaining rise`
                    : hiddenButton
                      ? "invisible editor-only pressure sensor · ←/→ chooses tools"
                      : binaryStateId !== null
                        ? `State ${binaryStateId} · ${isPuncher ? binaryStateRaised ? "sprung" : "unsprung" : binaryStateRaised ? "raised" : "lowered"}${block.visual.kind === "lift" || isPuncher ? " · click face chooses direction" : ""} · ←/→ toggles state`
                        : generic
                          ? `generic object ${selectedGenericIds[block.id] ?? 0}${slopeOption ? ` · ${slopeOption.label} · camera-facing` : ""} · ←/→ changes ID`
                          : slopeOption
                            ? `${slopeOption.label} · camera-facing · rotate camera to change direction · ←/→ chooses tools`
                            : isPuncher
                              ? "four horizontal directions · click a side face to choose · ←/→ chooses tools"
                              : `${roles.find((role) => role.id === block.roleId)?.name ?? block.roleId} · ←/→ chooses tools`;
                  return (
                    <button key={block.id} data-block-id={block.id} data-generic-family={generic ? block.roleId : undefined} style={{ "--tool-color": block.color } as React.CSSProperties} aria-label={block.name} aria-pressed={!groupSelectionMode && !activeGroupSelection && selectedBlock === block.id} className={`tool ${!groupSelectionMode && !activeGroupSelection && selectedBlock === block.id ? "is-current" : ""}`} title={`${block.name} — ${title}`} onClick={() => requestBlockSelection(block.id)}>
                      <canvas width={96} height={96} aria-hidden="true" />{(genericLabel !== undefined || index < 9) && <span>{genericLabel ?? index + 1}</span>}
                    </button>
                  );
                })}

                <button className="tool add-tool" aria-label="Define a new block" onClick={() => { setAddingBlock(true); }}>＋</button>
              </div>
              {projectLoaded && <LabToolboxPreviews blocks={blocks} genericBlockIds={genericBlockIds} genericIds={selectedGenericIds} orangeWallDepths={selectedOrangeWallDepths} cameraQuarterTurns={cameraQuarterTurns} />}
            </section>
          <div className="editor-lock-row"><span>{activeTestLocked ? <><LockIcon /> Read only</> : "Editing enabled"}</span><button onClick={() => toggleTestLocked(activeTest.id)}>{activeTestLocked ? "Unlock" : "Lock"}</button></div>
          <details className="panel inspector-test">
            <summary><span className="chevron">▸</span><span>Test details</span></summary>
            <div className="author-panel__body">
              <label className="field"><span>Name</span><input value={activeTest.name} onChange={(event) => updateTestMetadata(activeTest.id, { name: event.target.value })} /></label>
              <label className="field"><span>Description</span><textarea rows={3} value={activeTest.description} placeholder="What should happen in this test?" onChange={(event) => updateTestMetadata(activeTest.id, { description: event.target.value })} /></label>
              <div className="field"><span>Tags</span><TestTagPicker folders={folders} folderPaths={folderPaths} test={activeTest} onChangeGroup={(groupTagId) => changeTestTagGroup(activeTest.id, groupTagId)} onToggle={(tagId) => toggleTestTag(activeTest.id, tagId)} /></div>
              <div className="field"><span>Movement input</span><div className="canonical-input"><strong><DirectionIcon direction="up" /> Up</strong><small>Checked in all four directions.</small></div></div>
              <label className="generic-toggle test-hidden-toggle"><input aria-label={`Hide ${activeTest.name} from physics runs`} type="checkbox" checked={activeTest.hidden} onChange={() => toggleTestHidden(activeTest.id)} /><span><b>Skip in test runs</b></span></label>
            </div>
          </details>

          <button className="editor-library-link inspector-test" onClick={() => setActiveWorkspace("suite")}><span>Browse test library</span><span>{counts.runnable} tests ›</span></button>

          <details className="panel inspector-tool" open={addingBlock || groupSelectionMode || Boolean(activeGroupSelection) || undefined}>
            <summary><span className="chevron">▸</span><span>Selected tool</span><button type="button" className="panel-add" aria-label="Add block" onClick={(event) => { event.preventDefault(); setAddingBlock((value) => !value); }}>＋</button></summary>
            <div className="author-panel__body">
              {addingBlock ? (
                <div className="definition-form new-definition">
                  <label className="field"><span>New block name</span><input value={newBlock.name} placeholder="e.g. Ice" onChange={(event) => setNewBlock((value) => ({ ...value, name: event.target.value }))} /></label>
                  <div className="definition-row"><label className="field color-field"><span>Color</span><input type="color" value={newBlock.color} onChange={(event) => setNewBlock((value) => ({ ...value, color: event.target.value }))} /></label><label className="field"><span>Physics role</span><select value={newBlock.roleId} onChange={(event) => setNewBlock((value) => ({ ...value, roleId: event.target.value }))}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div>
                  <div className="definition-row definition-row--equal"><label className="field"><span>Occupancy</span><select value={newBlock.occupancy} onChange={(event) => setNewBlock((value) => ({ ...value, occupancy: event.target.value as OccupancyProfile }))}>{OCCUPANCY_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label><label className="field"><span>Visual</span><select value={newBlock.visual.kind} onChange={(event) => setNewBlock((value) => ({ ...value, visual: visualDefinitionForKind(event.target.value) }))}><option value="cube">Outlined cube</option><option value="floating-floor">MazeBench floating floor</option><option value="slope">Outlined slope · 4 directions</option><option value="lift">MazeBench lift</option><option value="gate">MazeBench red gate</option><option value="puncher">MazeBench puncher</option><option value="button">Orange pressure button</option><option value="orange-wall">Orange lowering wall</option><option value="gem">MazeBench gem</option></select></label></div>
                  <button className="tool-button tool-button--primary full" onClick={addBlock}>Create block</button>
                </div>
              ) : groupSelectionMode || activeGroupSelection ? (
                <div className="group-tool-panel">
                  <div className="group-tool-description"><span className="group-tool-icon large" aria-hidden="true"><i /><i /><i /></span><div><strong>Select group</strong><small>Press G once, then click an object; G again clears the selection. Arrow keys move relative to the camera. Shift+↑ raises and Shift+↓ lowers the selected groups one layer.</small></div></div>
                  <section className="cell-contents" aria-label="Cell contents">
                    <div className="cell-contents__heading"><div><span>Cell contents</span><strong>{inspectedCell ? `${inspectedCell.x}, ${inspectedCell.y}, ${inspectedCell.z}` : "Click an object"}</strong></div>{inspectedCell && <em>{inspectedCellOccupants.length}</em>}</div>
                    {inspectedCell ? inspectedCellOccupants.length ? (
                      <div className="cell-contents__list">{inspectedCellOccupants.map((voxel) => {
                        const definition = blockDefinitionsById.get(voxel.blockId);
                        const selectionKey = cellObjectSelectionKey(voxel);
                        const selected = selectedVoxelKeys.has(selectionKey);
                        return <div className={`cell-contents__item ${selected ? "is-selected" : ""}`} key={selectionKey}><span className="cell-contents__swatch" style={{ "--block-color": definition?.color ?? "#777" } as React.CSSProperties} /><div><strong>{definition?.name ?? voxel.blockId}</strong><small>{definition?.occupancy ?? "solid"}{voxel.groupId === undefined ? "" : ` · group ${voxel.groupId}`}{definition?.roleId === "orange-wall" ? ` · rise ${orangeWallMechanismDepth(voxel)}` : definition?.visual.kind === "puncher" ? ` · ${puncherIsSprung(voxel.genericId) ? "sprung" : "unsprung"}` : voxel.stateId === undefined ? "" : ` · state ${voxel.stateId}`}</small></div><button className="cell-contents__select" type="button" aria-label={`${selected ? "Deselect" : "Select"} ${definition?.name ?? voxel.blockId}`} onClick={() => selectCellOccupant(selectionKey)}>{selected ? "✓" : "Select"}</button><button type="button" disabled={activeTestLocked} aria-label={`Remove ${definition?.name ?? voxel.blockId} from cell`} onClick={() => removeCellOccupant(selectionKey)}>×</button></div>;
                      })}</div>
                    ) : <p className="cell-contents__empty">This cell is empty.</p> : <p className="cell-contents__empty">Click a cell to inspect every overlapping object.</p>}
                    {inspectedCell && <div className="cell-contents__actions"><button className="tool-button" type="button" disabled={activeTestLocked || !inspectedCellOccupants.length} onClick={clearInspectedCell}>Clear cell</button><button className="tool-button tool-button--primary" type="button" disabled={activeTestLocked || !selectedDefinition || selectedBlock === DELETE_TOOL_ID} onClick={() => selectedDefinition && paint(inspectedCell.x, inspectedCell.y, inspectedCell.z, selectedDefinition.id)}>Place selected here</button></div>}
                  </section>
                </div>
              ) : selectedBlock === DELETE_TOOL_ID ? (
                <div className="eraser-description"><svg className="author-tool-icon author-tool-icon--eraser" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></svg><div><strong>Erase tool</strong><small>Click a visible cube to remove it. Press X to select.</small></div></div>
              ) : selectedDefinition ? (
                <div className="definition-form">
                  <div className="selected-block-title"><span className={`swatch-cube large ${selectedDefinition.visual.kind === "floating-floor" ? "floating-floor" : ""} ${selectedDefinition.visual.kind === "slope" ? `slope slope--${selectedSlopeDirection}` : ""} ${selectedDefinition.visual.kind === "button" ? `pressure-button pressure-button--${selectedDefinition.visual.buttonForm === "hidden" ? "hidden" : "visible"}` : ""} ${selectedDefinition.roleId === "orange-wall" ? `orange-wall orange-wall--${selectedDefinition.visual.orangeForm === "hidden" ? "hidden" : "cube"} stateful` : ""} ${selectedDefinition.visual.kind === "lift" ? `lift lift--${liftIsRaised(selectedGenericIds[selectedDefinition.id] ?? 0) ? "raised" : "lowered"} lift--top` : ""} ${selectedDefinition.visual.kind === "gate" ? `gate gate--${gateIsRaised(selectedGenericIds[selectedDefinition.id] ?? 0) ? "raised" : "lowered"}` : ""} ${selectedDefinition.visual.kind === "puncher" ? `puncher puncher--${puncherIsSprung(selectedGenericIds[selectedDefinition.id] ?? 0) ? "sprung" : "unsprung"}` : ""} ${genericBlockIds.has(selectedDefinition.id) ? "generic" : ""}`} data-generic-label={genericBlockIds.has(selectedDefinition.id) ? selectedDefinition.visual.kind === "lift" ? String(liftIsRaised(selectedGenericIds[selectedDefinition.id] ?? 0) ? 1 : 0) : selectedDefinition.visual.kind === "gate" ? String(gateIsRaised(selectedGenericIds[selectedDefinition.id] ?? 0) ? 1 : 0) : selectedDefinition.visual.kind === "puncher" ? String(puncherIsSprung(selectedGenericIds[selectedDefinition.id] ?? 0) ? 1 : 0) : "N" : selectedOrangeWallDepth ?? undefined} style={{ "--block-color": selectedDefinition.color } as React.CSSProperties}>{selectedSlopeOption && !genericBlockIds.has(selectedDefinition.id) && selectedOrangeWallDepth === null ? <i className="slope-direction-glyph" aria-hidden="true">{selectedSlopeOption.glyph}</i> : selectedDefinition.visual.kind === "puncher" ? <i className="puncher-direction-glyph" aria-hidden="true">→</i> : null}</span><div><strong>{selectedDefinition.name}</strong><small>{selectedDefinition.id}</small></div></div>
                  <label className="field"><span>Name</span><input value={selectedDefinition.name} onChange={(event) => { setBlocks((current) => current.map((block) => block.id === selectedBlock ? { ...block, name: event.target.value } : block)); setResults({}); }} /></label>
                  <div className="definition-row"><label className="field color-field"><span>Color</span><input type="color" value={selectedDefinition.color} onChange={(event) => setBlocks((current) => current.map((block) => block.id === selectedBlock ? { ...block, color: event.target.value } : block))} /></label><label className="field"><span>Physics role</span><select value={selectedDefinition.roleId} onChange={(event) => updateBlockRole(selectedDefinition, event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label></div>
                  <div className="definition-row definition-row--equal"><label className="field"><span>Occupancy</span><select value={selectedDefinition.occupancy} onChange={(event) => setBlocks((current) => current.map((block) => block.id === selectedDefinition.id ? { ...block, occupancy: event.target.value as OccupancyProfile } : block))}>{OCCUPANCY_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label><label className="field"><span>Visual</span><select value={selectedDefinition.visual.kind} onChange={(event) => setBlocks((current) => current.map((block) => block.id === selectedDefinition.id ? { ...block, visual: visualDefinitionForKind(event.target.value) } : block))}><option value="cube">Outlined cube</option><option value="floating-floor">MazeBench floating floor</option><option value="slope">Outlined slope · 4 directions</option><option value="lift">MazeBench lift</option><option value="gate">MazeBench red gate</option><option value="puncher">MazeBench puncher</option><option value="button">Orange pressure button</option><option value="orange-wall">Orange lowering wall</option><option value="gem">MazeBench gem</option></select></label></div>
                  {selectedDefinition.visual.kind === "floating-floor" && <p className="engine-role-note"><b>MazeBench floating platform.</b> One has ordinary box weight. Over a Row-0 hole it remains suspended for the movement tick, then becomes permanent Floor on the following tick.</p>}
                  {selectedDefinition.visual.kind === "slope" && <p className="engine-role-note"><b>Painting follows the camera.</b> Every slope faces the far side of the current view, regardless of which cube face you click. Rotate the camera to choose another direction.</p>}
                  {selectedDefinition.visual.kind === "lift" && <p className="engine-role-note"><b>Painting chooses the mounting.</b> Click a cube’s top or one of its four side faces. The toolbar state stays 0 (lowered) or 1 (raised), while the saved lift receives the matching directional ID from 0–9.</p>}
                  {selectedDefinition.visual.kind === "gate" && <p className="engine-role-note"><b>Binary gate state.</b> Use state 0 for the lowered red slab and state 1 for the raised red cube. Left and right arrows toggle the selected state.</p>}
                  {selectedDefinition.visual.kind === "puncher" && <p className="engine-role-note"><b>Binary puncher state.</b> Use state 0 for unsprung or state 1 for sprung, and use left/right arrows to toggle it. Click one of a cube’s four side faces to choose the outward punch direction; top and bottom punchers are not part of this family.</p>}
                  {selectedDefinition.visual.kind === "button" && <p className="engine-role-note"><b>Painting chooses the mounting.</b> Click any top, bottom, or side face. A rigid occupant sharing the button’s cell activates it internally. {selectedDefinition.visual.buttonForm === "hidden" ? "This form is shown at 50% opacity in the editor and is invisible during play." : "This form is the visible cylinder."}</p>}
                  {selectedDefinition.roleId === "orange-wall" && <><label className="field"><span>Remaining rise</span><input type="number" min={0} step={1} value={selectedOrangeWallDepth ?? 0} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 0) setSelectedOrangeWallDepths((current) => ({ ...current, [selectedDefinition.id]: value })); }} /></label><p className="engine-role-note"><b>{selectedDefinition.visual.orangeForm === "hidden" ? "Invisible" : "Visible"} Orange Wall.</b> It may be painted or moved into any occupied cell. {selectedDefinition.visual.orangeForm === "hidden" ? "It is shown at 50% opacity in the editor and is invisible during play. " : ""}Zero will not rise; N means it still needs to rise N mechanism steps.</p></>}
                  <p className="engine-role-note"><b>Occupancy is editor metadata.</b> Sensors and decorations may share a cell with solid bodies. Physics behavior still comes from the C++ role until the generalized state ABI phase.</p>
                </div>
              ) : null}
            </div>
          </details>

          <details className="panel inspector-tool" open={addingRole || undefined}>
            <summary><span className="chevron">▸</span><span>Physics roles</span><button type="button" className="panel-add" aria-label="Add physics role" onClick={(event) => { event.preventDefault(); setAddingRole((value) => !value); }}>＋</button></summary>
            <div className="author-panel__body">
              {addingRole ? (
                <div className="definition-form new-definition">
                  <label className="field"><span>Role name</span><input value={newRole.name} placeholder="e.g. Ice" onChange={(event) => setNewRole((value) => ({ ...value, name: event.target.value }))} /></label>
                  <label className="field"><span>Description</span><textarea rows={3} value={newRole.description} placeholder="Describe what this role should do." onChange={(event) => setNewRole((value) => ({ ...value, description: event.target.value }))} /></label>
                  <div className="generic-toggle"><input aria-label="Make new role a generic numbered family" id="new-role-generic" type="checkbox" checked={newRole.generic} onChange={(event) => setNewRole((value) => ({ ...value, generic: event.target.checked }))} /><span><b>Generic numbered family</b><small>Blocks using this role receive object IDs 0, 1, 2, and beyond.</small></span></div>
                  <button className="tool-button tool-button--primary full" onClick={addRole}>Create physics role</button>
                </div>
              ) : selectedRole ? (
                <div className="definition-form role-definition">
                  <label className="field"><span>Role</span><select value={selectedRole.id} onChange={(event) => setSelectedRoleId(event.target.value)}>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
                  <label className="field"><span>Name</span><input value={selectedRole.name} onChange={(event) => updateSelectedRole({ name: event.target.value })} /></label>
                  <label className="field"><span>Description</span><textarea rows={3} value={selectedRole.description} onChange={(event) => updateSelectedRole({ description: event.target.value })} /></label>
                  <div className="generic-toggle"><input aria-label={`Make ${selectedRole.name} a generic numbered family`} id="selected-role-generic" type="checkbox" checked={selectedRole.generic} onChange={(event) => { const generic = event.target.checked; const affected = new Set(blocks.filter((block) => block.roleId === selectedRole.id).map((block) => block.id)); updateSelectedRole({ generic }); setTests((current) => current.map((test) => isTestLocked(test) ? test : { ...test, start: setGenericModeForBlocks(test.start, affected, generic), intermediate: test.intermediate.map((frame) => setGenericModeForBlocks(frame, affected, generic)), expected: setGenericModeForBlocks(test.expected, affected, generic) })); setResults({}); }} /><span><b>Generic numbered family</b><small>Select its N tool below, type an object ID, and press Enter before painting.</small></span></div>
                  <p className="engine-role-note"><b>Stable engine key preserved.</b> New roles occupy space but remain behaviorally inert until their rule is implemented in the C++ engine.</p>
                </div>
              ) : null}
            </div>
          </details>

          <details className="panel inspector-test">
            <summary><span className="chevron">▸</span><span>Room size</span><em>{activeWorld.width} × {activeWorld.height} × ∞</em></summary>
            <div className="author-panel__body">
              <TestWorldEditor key={`${activeTest.id}:${activeWorld.width}:${activeWorld.height}`} locked={activeTestLocked} test={activeTest} onSave={saveWorldDimensions} />
              <p className="axis-note"><b>This size belongs only to {activeTest.name}.</b> Draft values do nothing until Save dimensions is pressed; Cancel restores the saved values. Start and Expected then resize together while other tests keep their own dimensions. Shrinking crops this test&apos;s out-of-bounds voxels. <b>Z is unbounded</b> around floor layer 0.</p>
            </div>
          </details>
        </aside>
      </section>}
    </main>
  );
}
