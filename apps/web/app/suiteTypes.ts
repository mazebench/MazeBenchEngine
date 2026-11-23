import { createCellObjectMultisetDiffer } from "./cellObjects.mjs";

export type Direction = "up" | "down" | "left" | "right";

export type PhysicsRoleDefinition = {
  id: string;
  name: string;
  description: string;
  generic: boolean;
};

export type BlockDefinition = {
  id: string;
  name: string;
  color: string;
  roleId: string;
  occupancy: OccupancyProfile;
  genericMax?: number;
  variantMax?: number;
  visual: BlockVisualDefinition;
};

export type OccupancyProfile = "solid" | "sensor" | "support" | "decoration" | "inactive";

export type BlockVisualDefinition = {
  buttonForm?: "visible" | "hidden";
  kind: "button" | "cube" | "floating-floor" | "gate" | "gem" | "lift" | "orange-wall" | "puncher" | "slope";
  modelUrl?: string;
  orangeForm?: "visible" | "hidden";
};

export type Voxel = {
  x: number;
  y: number;
  z: number;
  blockId: string;
  genericId?: number;
  groupId?: number;
  instanceId?: string;
  mechanismDepth?: number;
  orientation?: string;
  stateId?: number;
  variantId?: number;
};

export type Frame = { voxels: Voxel[] };

export type WorldSettings = { width: number; height: number; floorLayer: 0 };

export type CycleExpectation = {
  startTick: number;
  repeatTick: number;
  onCycle: "rollback-command";
};

export type TestCase = {
  cycle?: CycleExpectation;
  description: string;
  folderId: string;
  hidden: boolean;
  tagIds: string[];
  id: string;
  locked: boolean;
  name: string;
  input: Direction;
  intermediate: Frame[];
  start: Frame;
  expected: Frame;
  world: WorldSettings;
};

export type FrameComparison = {
  actual: Frame;
  pass: boolean;
  missing: Voxel[];
  unexpected: Voxel[];
};

export type FrameComparisonContext = {
  blocksById: Map<string, BlockDefinition>;
  differ: ReturnType<typeof createCellObjectMultisetDiffer>;
};

export type RotationDegrees = 0 | 90 | 180 | 270;

export type RotationCheck = FrameComparison & {
  cycleDifference: string | null;
  expected: Frame;
  firstMismatchFrame: number | null;
  input: Direction;
  rotation: RotationDegrees;
  trace: Array<FrameComparison & {
    actualPresent: boolean;
    expected: Frame;
    expectedPresent: boolean;
  }>;
  tick?: number;
  world: WorldSettings;
};

export type TestResult = RotationCheck & { checks: RotationCheck[] };
