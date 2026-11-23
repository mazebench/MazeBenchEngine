"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MazeBenchCanvas from "./MazeBenchCanvas";
import { simulateCommandWithCpp } from "./physicsEngine";
import { blockCanShareCell } from "./cellObjects.mjs";

export type SearchDirection = "up" | "right" | "down" | "left";
export type SearchVoxel = {
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
export type SearchWorld = { width: number; height: number; floorLayer: 0 };
export type SearchLevel = {
  id: string;
  name: string;
  createdAt: string;
  world: SearchWorld;
  layers: number;
  voxels: SearchVoxel[];
  solution: SearchDirection[];
  moves: number;
  expanded: number;
  generated: number;
  elapsedMs?: number;
  evaluatedNodes?: number;
  commandTransitions?: number;
  commandTransitionsPerSecond?: number;
  transpositions?: number;
  pushes?: number;
  iceSlides?: number;
  boxesDropped?: number;
  nodesPerSecond: number;
  solvesPerSecond: number;
  optimal: boolean;
  provisional?: boolean;
  limitHit?: boolean;
  seed: number;
};

type PhysicsRoleDefinition = {
  id: string;
  name: string;
  description: string;
  generic: boolean;
};

type BlockDefinition = {
  id: string;
  name: string;
  color: string;
  roleId: string;
  occupancy: string;
  visual: { kind: "button" | "cube" | "floating-floor" | "gate" | "gem" | "lift" | "orange-wall" | "puncher" | "slope"; modelUrl?: string };
};

type SearchBenchProps = {
  blocks: BlockDefinition[];
  roles: PhysicsRoleDefinition[];
  savedLevels: SearchLevel[];
  onSavedLevelsChange: (levels: SearchLevel[]) => void;
  onStatus: (message: string) => void;
};

type SearchProgress = {
  bestMoves: number;
  bestProvisionalMoves: number;
  cacheHits: number;
  evaluated: number;
  evaluatorCount: number;
  generation: number;
  generations: number;
  elapsedMs: number;
  generationElapsedMs: number;
  nodesPerSecond: number;
  commandTransitionsPerSecond: number;
  solverCommandTransitionsPerSecond: number;
  solverNodesPerSecond: number;
  solvesPerSecond: number;
  stagnation: number;
  uniqueCandidates: number;
};

type SearchOptions = {
  width: number;
  depth: number;
  layers: number;
  collectibles: number;
  minWeightlessBoxes: number;
  maxWeightlessBoxes: number;
  terrainDensity: number;
  targetMoves: number;
  population: number;
  generations: number;
  maxNodes: number;
  screeningNodes: number;
  proofCandidates: number;
  evaluatorWorkers: number;
  eliteCount: number;
  reverseScramblePercent: number;
  minimumScramblePulls: number;
  endpointMutationPercent: number;
  escapeStagnation: number;
  immigrantStagnation: number;
  initialIceMax: number;
  initialHoleMax: number;
  terrainMode: "planar" | "3d";
  analyzeInteractions: boolean;
  seedPopulationPercent: number;
  seed: number;
  evolveHoles: boolean;
};

type NumericSearchOption = Exclude<
  keyof SearchOptions,
  "evolveHoles" | "terrainMode" | "analyzeInteractions"
>;

type SolutionLengthPoint = {
  generation: number;
  length: number;
  provisional: boolean;
};

type GenerationTimingPoint = {
  generation: number;
  durationMs: number;
  elapsedMs: number;
};

const DEFAULT_OPTIONS: SearchOptions = {
  width: 16,
  depth: 16,
  layers: 1,
  collectibles: 1,
  minWeightlessBoxes: 3,
  maxWeightlessBoxes: 10,
  terrainDensity: 45,
  targetMoves: 600,
  population: 256,
  generations: 500,
  maxNodes: 180000,
  screeningNodes: 2000,
  proofCandidates: 24,
  evaluatorWorkers: 0,
  eliteCount: 24,
  reverseScramblePercent: 34,
  minimumScramblePulls: 1,
  endpointMutationPercent: 0,
  escapeStagnation: 50,
  immigrantStagnation: 100,
  initialIceMax: 18,
  initialHoleMax: 8,
  terrainMode: "planar",
  analyzeInteractions: false,
  seedPopulationPercent: 75,
  seed: 20260812,
  evolveHoles: true,
};

const SEARCH_VOXEL_CAPACITY = 4096;
const SEARCH_NODE_CAPACITY = 180000;
const SEARCH_COORDINATE_MAX = 32767;

const SEARCH_PRESETS = {
  "mbe3-planar": {
    label: "MazeBench 16×16×2",
    values: DEFAULT_OPTIONS,
  },
  "general-3d": {
    label: "General 3D",
    values: {
      ...DEFAULT_OPTIONS,
      width: 8,
      depth: 8,
      layers: 3,
      minWeightlessBoxes: 1,
      maxWeightlessBoxes: 4,
      terrainMode: "3d" as const,
      initialIceMax: 0,
      initialHoleMax: 12,
      endpointMutationPercent: 8,
      targetMoves: 500,
    },
  },
};

function finiteInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatClock(milliseconds: number) {
  const tenths = Math.max(0, Math.floor(milliseconds / 100));
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const decimal = tenths % 10;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${decimal}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${decimal}`;
}

function formatGenerationDuration(milliseconds: number) {
  return milliseconds < 1000
    ? `${Math.max(0, Math.round(milliseconds))}ms`
    : formatClock(milliseconds);
}

function normalizeDirection(value: unknown): SearchDirection | null {
  return value === "up" || value === "right" || value === "down" || value === "left"
    ? value
    : null;
}

export function normalizeSearchLevels(
  value: unknown,
  blocks: BlockDefinition[],
): SearchLevel[] {
  if (!Array.isArray(value)) return [];
  const blockIds = new Set(blocks.map((block) => block.id));
  const floorIds = new Set(blocks.filter((block) => block.roleId === "floor").map((block) => block.id));
  const shareableIds = new Set(blocks.filter(blockCanShareCell).map((block) => block.id));
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<SearchLevel>;
    if (!Array.isArray(candidate.voxels)) return [];
    const width = clamp(
      finiteInteger(candidate.world?.width, 8), 3, SEARCH_COORDINATE_MAX + 1,
    );
    const height = clamp(
      finiteInteger(candidate.world?.height, 8), 3, SEARCH_COORDINATE_MAX + 1,
    );
    const seenRigid = new Set<string>();
    const voxels = candidate.voxels.flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const voxel = raw as SearchVoxel;
      const x = finiteInteger(voxel.x, -1);
      const y = finiteInteger(voxel.y, -1);
      const z = finiteInteger(voxel.z, 0);
      const blockId = String(voxel.blockId ?? "");
      const key = `${x},${y},${z}`;
      const shareable = shareableIds.has(blockId);
      if (x < 0 || x >= width || y < 0 || y >= height || !blockIds.has(blockId) ||
          (floorIds.has(blockId) && z !== 0) || (!shareable && seenRigid.has(key))) return [];
      if (!shareable) seenRigid.add(key);
      const genericId = finiteInteger(voxel.genericId, -1);
      const groupId = finiteInteger(voxel.groupId, -1);
      const instanceId = String(voxel.instanceId ?? "").trim();
      const orientation = String(voxel.orientation ?? "").trim();
      return [{
        x,
        y,
        z,
        blockId,
        ...(genericId >= 0 ? { genericId } : {}),
        ...(groupId >= 0 ? { groupId } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(orientation ? { orientation } : {}),
        ...(voxel.stateId === undefined ? {} : {
          stateId: Math.max(0, finiteInteger(voxel.stateId, 0)),
        }),
        ...(voxel.variantId === undefined ? {} : {
          variantId: Math.max(0, finiteInteger(voxel.variantId, 0)),
        }),
      }];
    });
    const solution = Array.isArray(candidate.solution)
      ? candidate.solution.flatMap((step) => normalizeDirection(step) ?? [])
      : [];
    return [{
      id: String(candidate.id ?? `saved-search-${index}`),
      name: String(candidate.name ?? "Saved evolved level"),
      createdAt: String(candidate.createdAt ?? new Date(0).toISOString()),
      world: { width, height, floorLayer: 0 },
      layers: clamp(finiteInteger(candidate.layers, 3), 1, SEARCH_COORDINATE_MAX),
      voxels,
      solution,
      moves: Math.max(0, finiteInteger(candidate.moves, solution.length)),
      expanded: Math.max(0, finiteInteger(candidate.expanded, 0)),
      generated: Math.max(0, finiteInteger(candidate.generated, 0)),
      ...(candidate.elapsedMs === undefined ? {} : {
        elapsedMs: Math.max(0, Number(candidate.elapsedMs) || 0),
      }),
      ...(candidate.evaluatedNodes === undefined ? {} : {
        evaluatedNodes: Math.max(0, finiteInteger(candidate.evaluatedNodes, 0)),
      }),
      commandTransitions: Math.max(0, finiteInteger(candidate.commandTransitions, 0)),
      commandTransitionsPerSecond: Math.max(
        0, finiteInteger(candidate.commandTransitionsPerSecond, 0)),
      transpositions: Math.max(0, finiteInteger(candidate.transpositions, 0)),
      pushes: Math.max(0, finiteInteger(candidate.pushes, 0)),
      iceSlides: Math.max(0, finiteInteger(candidate.iceSlides, 0)),
      boxesDropped: Math.max(0, finiteInteger(candidate.boxesDropped, 0)),
      nodesPerSecond: Math.max(0, finiteInteger(candidate.nodesPerSecond, 0)),
      solvesPerSecond: Math.max(0, finiteInteger(candidate.solvesPerSecond, 0)),
      optimal: Boolean(candidate.optimal),
      provisional: Boolean(candidate.provisional),
      limitHit: Boolean(candidate.limitHit),
      seed: finiteInteger(candidate.seed, 0) >>> 0,
    }];
  });
}

function DirectionGlyph({ direction }: { direction: SearchDirection }) {
  return <span aria-label={direction}>{({ up: "↑", right: "→", down: "↓", left: "←" })[direction]}</span>;
}

function SolutionLengthChart({
  history,
  running,
}: {
  history: SolutionLengthPoint[];
  running: boolean;
}) {
  const width = 640;
  const height = 128;
  const left = 38;
  const right = 12;
  const top = 10;
  const bottom = 22;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const lastGeneration = Math.max(1, history.at(-1)?.generation ?? 1);
  const maximumLength = Math.max(0, ...history.map((point) => point.length));
  const coordinate = (point: SolutionLengthPoint) => ({
    x: left + (lastGeneration === 1
      ? 0
      : ((point.generation - 1) / (lastGeneration - 1)) * plotWidth),
    y: top + plotHeight - (point.length / Math.max(1, maximumLength)) * plotHeight,
  });
  const line = history.map(coordinate).map(({ x, y }) => `${x},${y}`).join(" ");
  const area = history.length
    ? `${left},${top + plotHeight} ${line} ${coordinate(history.at(-1)!).x},${top + plotHeight}`
    : "";
  const latest = history.at(-1)?.length ?? 0;
  const latestProvisional = history.at(-1)?.provisional ?? false;

  return (
    <section className="solution-length-chart" aria-label="Solution length history">
      <header>
        <div><span>EVOLUTION TRACE</span><strong>Solution length by generation</strong></div>
        <em>{latest > 0 ? `${latest} ${latestProvisional ? "provisional " : ""}commands` : running ? "Searching…" : history.length ? "No route found" : "No run yet"}</em>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={latest > 0
        ? `Best ${latestProvisional ? "provisional route" : "proven solution"} is ${latest} commands after generation ${lastGeneration}`
        : `No solution route after generation ${lastGeneration}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="solution-history-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--cyan)" stopOpacity=".28" />
            <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((ratio) => {
          const y = top + plotHeight * ratio;
          const value = Math.round(maximumLength * (1 - ratio));
          const label = maximumLength === 0
            ? ratio === 1 ? "0" : ""
            : maximumLength === 1 && ratio === 0.5 ? "" : String(value);
          return <g key={ratio}><line className="chart-grid-line" x1={left} y1={y} x2={width - right} y2={y} /><text className="chart-axis-label" x={left - 7} y={y + 3} textAnchor="end">{label}</text></g>;
        })}
        <text className="chart-axis-label" x={left} y={height - 5}>GEN 1</text>
        <text className="chart-axis-label" x={width - right} y={height - 5} textAnchor="end">GEN {lastGeneration}</text>
        {history.length > 0 && <polygon className="chart-area" points={area} />}
        {history.length > 1 && <polyline className="chart-line" points={line} />}
        {history.map((point, index) => {
          const { x, y } = coordinate(point);
          const showPoint = history.length <= 40 || index === history.length - 1 || index % Math.ceil(history.length / 40) === 0;
          return showPoint ? <circle className="chart-point" key={point.generation} cx={x} cy={y} r={index === history.length - 1 ? 3.2 : 1.8} /> : null;
        })}
      </svg>
    </section>
  );
}

function GenerationTimeChart({
  history,
  running,
  activeGeneration,
  activeDurationMs,
}: {
  history: GenerationTimingPoint[];
  running: boolean;
  activeGeneration: number;
  activeDurationMs: number;
}) {
  const width = 640;
  const height = 128;
  const left = 42;
  const right = 12;
  const top = 10;
  const bottom = 22;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const completedGeneration = history.at(-1)?.generation ?? 0;
  const hasActivePoint = running && activeGeneration > completedGeneration;
  const points = hasActivePoint
    ? [...history, {
      generation: activeGeneration,
      durationMs: activeDurationMs,
      elapsedMs: 0,
    }]
    : history;
  const lastGeneration = Math.max(1, points.at(-1)?.generation ?? 1);
  const maximumDuration = Math.max(1, ...points.map((point) => point.durationMs));
  const coordinate = (point: GenerationTimingPoint) => ({
    x: left + (lastGeneration === 1
      ? 0
      : ((point.generation - 1) / (lastGeneration - 1)) * plotWidth),
    y: top + plotHeight - (point.durationMs / maximumDuration) * plotHeight,
  });
  const line = points.map(coordinate).map(({ x, y }) => `${x},${y}`).join(" ");
  const latestDuration = hasActivePoint
    ? activeDurationMs
    : history.at(-1)?.durationMs ?? 0;

  return (
    <section className="solution-length-chart generation-time-chart" aria-label="Generation wall time history">
      <header>
        <div><span>GENERATION CLOCK</span><strong>Wall time per generation</strong></div>
        <em>{points.length ? formatGenerationDuration(latestDuration) : "No run yet"}</em>
      </header>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={points.length
        ? `${lastGeneration} generations timed; latest generation took ${formatGenerationDuration(latestDuration)}`
        : "No generation timing recorded"} preserveAspectRatio="none">
        {[0, 0.5, 1].map((ratio) => {
          const y = top + plotHeight * ratio;
          const value = maximumDuration * (1 - ratio);
          return <g key={ratio}><line className="chart-grid-line" x1={left} y1={y} x2={width - right} y2={y} /><text className="chart-axis-label" x={left - 7} y={y + 3} textAnchor="end">{value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`}</text></g>;
        })}
        <text className="chart-axis-label" x={left} y={height - 5}>GEN 1</text>
        <text className="chart-axis-label" x={width - right} y={height - 5} textAnchor="end">GEN {lastGeneration}</text>
        {points.length > 1 && <polyline className="generation-time-line" points={line} />}
        {points.map((point) => {
          const { x, y } = coordinate(point);
          return <circle className={point.generation > completedGeneration ? "generation-time-point active" : "generation-time-point"} key={point.generation} cx={x} cy={y} r={point.generation === lastGeneration ? 3.2 : 1.8}><title>{`Generation ${point.generation}: ${formatGenerationDuration(point.durationMs)}`}</title></circle>;
        })}
      </svg>
    </section>
  );
}

export default function SearchBench({
  blocks,
  roles,
  savedLevels,
  onSavedLevelsChange,
  onStatus,
}: SearchBenchProps) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [preset, setPreset] = useState<keyof typeof SEARCH_PRESETS | "custom">(
    "mbe3-planar",
  );
  const [enabledBlockIds, setEnabledBlockIds] = useState(() => blocks.map((block) => block.id));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SearchProgress>({
    bestMoves: 0,
    bestProvisionalMoves: 0,
    cacheHits: 0,
    evaluated: 0,
    evaluatorCount: 0,
    generation: 0,
    generations: DEFAULT_OPTIONS.generations,
    elapsedMs: 0,
    generationElapsedMs: 0,
    nodesPerSecond: 0,
    commandTransitionsPerSecond: 0,
    solverCommandTransitionsPerSecond: 0,
    solverNodesPerSecond: 0,
    solvesPerSecond: 0,
    stagnation: 0,
    uniqueCandidates: 0,
  });
  const [best, setBest] = useState<SearchLevel | null>(null);
  const [solutionLengthHistory, setSolutionLengthHistory] = useState<SolutionLengthPoint[]>([]);
  const [generationTimingHistory, setGenerationTimingHistory] = useState<GenerationTimingPoint[]>([]);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"inspect" | "solution" | "play">("inspect");
  const [solutionFrames, setSolutionFrames] = useState<Array<{ voxels: SearchVoxel[] }>>([]);
  const [solutionFrameIndex, setSolutionFrameIndex] = useState(0);
  const [buildingTrace, setBuildingTrace] = useState(false);
  const [playingTrace, setPlayingTrace] = useState(false);
  const [playFrame, setPlayFrame] = useState<{ voxels: SearchVoxel[] } | null>(null);
  const [playMoves, setPlayMoves] = useState(0);
  const [playBusy, setPlayBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const runStartedAtRef = useRef<number | null>(null);
  const generationStartedAtRef = useRef<number | null>(null);

  const genericRoleIds = useMemo(
    () => new Set(roles.filter((role) => role.generic).map((role) => role.id)),
    [roles],
  );
  const genericBlockIds = useMemo(
    () => new Set(blocks.filter((block) => genericRoleIds.has(block.roleId)).map((block) => block.id)),
    [blocks, genericRoleIds],
  );
  const weightlessEnabled = blocks.some((block) =>
    block.roleId === "weightless-pushable" && enabledBlockIds.includes(block.id));
  const selectedSaved = savedLevels.find((level) => level.id === selectedSavedId) ?? null;
  const activeLevel = selectedSaved ?? best;
  const displayFrame = viewMode === "solution" && solutionFrames.length
    ? solutionFrames[solutionFrameIndex]
    : viewMode === "play" && playFrame
      ? playFrame
      : { voxels: activeLevel?.voxels ?? [] };
  const world = activeLevel?.world ?? {
    width: options.width,
    height: options.depth,
    floorLayer: 0 as const,
  };
  const elapsedClockMs = running && runStartedAt !== null
    ? clockNow - runStartedAt
    : progress.elapsedMs;
  const generationClockMs = running && generationStartedAt !== null
    ? clockNow - generationStartedAt
    : progress.generationElapsedMs;

  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    // A newly selected/generated level owns a fresh trace and play session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSolutionFrames([]);
    setSolutionFrameIndex(0);
    setPlayingTrace(false);
    setPlayFrame(activeLevel ? { voxels: activeLevel.voxels.map((voxel) => ({ ...voxel })) } : null);
    setPlayMoves(0);
  }, [activeLevel]);

  useEffect(() => {
    if (!playingTrace || solutionFrames.length <= 1) return;
    const timer = window.setInterval(() => {
      setSolutionFrameIndex((current) => {
        if (current >= solutionFrames.length - 1) {
          setPlayingTrace(false);
          return current;
        }
        return current + 1;
      });
    }, 320);
    return () => window.clearInterval(timer);
  }, [playingTrace, solutionFrames.length]);

  const updateOption = (key: NumericSearchOption, value: string) => {
    setPreset("custom");
    const ranges: Record<NumericSearchOption, [number, number]> = {
      width: [4, SEARCH_COORDINATE_MAX + 1],
      depth: [4, SEARCH_COORDINATE_MAX + 1],
      layers: [1, SEARCH_COORDINATE_MAX],
      collectibles: [1, 16],
      minWeightlessBoxes: [0, 32],
      maxWeightlessBoxes: [0, 32],
      terrainDensity: [5, 90],
      targetMoves: [1, 4096],
      population: [4, 1024],
      generations: [1, 10000],
      maxNodes: [100, SEARCH_NODE_CAPACITY],
      screeningNodes: [100, SEARCH_NODE_CAPACITY],
      proofCandidates: [1, 256],
      evaluatorWorkers: [0, 16],
      eliteCount: [2, 256],
      reverseScramblePercent: [0, 100],
      minimumScramblePulls: [1, 1000],
      endpointMutationPercent: [0, 100],
      escapeStagnation: [1, 10000],
      immigrantStagnation: [1, 10000],
      initialIceMax: [0, 4096],
      initialHoleMax: [0, 4096],
      seedPopulationPercent: [0, 100],
      seed: [0, 0xFFFFFFFF],
    };
    const [minimum, maximum] = ranges[key];
    setOptions((current) => {
      const nextValue = clamp(finiteInteger(value, current[key]), minimum, maximum);
      if (key === "minWeightlessBoxes") {
        return {
          ...current,
          minWeightlessBoxes: nextValue,
          maxWeightlessBoxes: Math.max(current.maxWeightlessBoxes, nextValue),
        };
      }
      if (key === "maxWeightlessBoxes") {
        return {
          ...current,
          maxWeightlessBoxes: nextValue,
          minWeightlessBoxes: Math.min(current.minWeightlessBoxes, nextValue),
        };
      }
      return { ...current, [key]: nextValue };
    });
  };

  const applyPreset = (key: keyof typeof SEARCH_PRESETS) => {
    setPreset(key);
    setOptions({ ...SEARCH_PRESETS[key].values });
  };

  const toggleBlock = (blockId: string) => {
    setEnabledBlockIds((current) => current.includes(blockId)
      ? current.filter((id) => id !== blockId)
      : [...current, blockId]);
  };

  const stopSearch = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    const stoppedAt = Date.now();
    setProgress((current) => ({
      ...current,
      elapsedMs: runStartedAtRef.current === null
        ? current.elapsedMs
        : stoppedAt - runStartedAtRef.current,
      generationElapsedMs: generationStartedAtRef.current === null
        ? current.generationElapsedMs
        : stoppedAt - generationStartedAtRef.current,
    }));
    runStartedAtRef.current = null;
    generationStartedAtRef.current = null;
    setRunStartedAt(null);
    setGenerationStartedAt(null);
    setRunning(false);
    onStatus("Evolution stopped · current best retained");
  }, [onStatus]);

  const startSearch = (startingCandidate: SearchLevel | null = null) => {
    const blockRolesById = new Map(blocks.map((block) => [block.id, block.roleId]));
    const startingCandidateNeeds3D = Boolean(startingCandidate?.voxels.some((voxel) =>
      voxel.z > 1 ||
      (voxel.z > 0 && blockRolesById.get(voxel.blockId) === "ice")));
    const runOptions = startingCandidate
      ? {
        ...options,
        width: startingCandidate.world.width,
        depth: startingCandidate.world.height,
        layers: startingCandidate.layers,
        terrainMode: startingCandidateNeeds3D ? "3d" as const : options.terrainMode,
      }
      : options;
    if (startingCandidate) {
      setPreset("custom");
      setOptions(runOptions);
    }
    const runEnabledBlockIds = startingCandidate
      ? [...new Set([
        ...enabledBlockIds,
        ...startingCandidate.voxels.map((voxel) => voxel.blockId),
      ])]
      : enabledBlockIds;
    const enabledRoles = new Set(blocks
      .filter((block) => runEnabledBlockIds.includes(block.id))
      .map((block) => block.roleId));
    const missing = ["player", "goal"].filter((role) => !enabledRoles.has(role));
    if (!enabledRoles.has("floor") && !enabledRoles.has("ice")) {
      missing.unshift("floor or ice");
    }
    if (missing.length) {
      onStatus(`Enable Player, Goal, and either Floor or Ice before searching · missing ${missing.join(", ")}`);
      return;
    }
    const footprint = runOptions.width * runOptions.depth;
    const minimumSceneVoxels = footprint + 1 + runOptions.collectibles;
    if (!Number.isSafeInteger(footprint) || minimumSceneVoxels > SEARCH_VOXEL_CAPACITY) {
      onStatus(`${runOptions.width}×${runOptions.depth} needs at least ${minimumSceneVoxels.toLocaleString()} voxels · exact search supports ${SEARCH_VOXEL_CAPACITY.toLocaleString()} total scene voxels`);
      return;
    }
    workerRef.current?.terminate();
    const worker = new Worker("/search-worker.js", { type: "module" });
    workerRef.current = worker;
    setRunning(true);
    const startedAt = Date.now();
    runStartedAtRef.current = startedAt;
    generationStartedAtRef.current = startedAt;
    setRunStartedAt(startedAt);
    setGenerationStartedAt(startedAt);
    setClockNow(startedAt);
    setBest(null);
    setSolutionLengthHistory([]);
    setGenerationTimingHistory([]);
    setSelectedSavedId(null);
    setProgress({
      bestMoves: 0,
      bestProvisionalMoves: 0,
      cacheHits: 0,
      evaluated: 0,
      evaluatorCount: 0,
      generation: 0,
      generations: runOptions.generations,
      elapsedMs: 0,
      generationElapsedMs: 0,
      nodesPerSecond: 0,
      commandTransitionsPerSecond: 0,
      solverCommandTransitionsPerSecond: 0,
      solverNodesPerSecond: 0,
      solvesPerSecond: 0,
      stagnation: 0,
      uniqueCandidates: 0,
    });
    onStatus(startingCandidate
      ? `Continuing evolution from ${startingCandidate.name}…`
      : "Starting evolutionary search in the C++ exact solver…");
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === "best") {
        setBest(message.candidate as SearchLevel);
        onStatus(message.candidate.optimal
          ? `New proven record · ${message.candidate.moves} commands at generation ${message.generation}`
          : message.candidate.provisional
            ? `New provisional route · ${message.candidate.moves} commands · proof budget exhausted`
            : `New search-effort record · ${message.candidate.expanded} global states explored`);
      } else if (message?.type === "progress") {
        const receivedAt = Date.now();
        runStartedAtRef.current = receivedAt - Math.max(0, Number(message.elapsedMs) || 0);
        generationStartedAtRef.current = receivedAt - Math.max(
          0, Number(message.generationElapsedMs) || 0,
        );
        setRunStartedAt(runStartedAtRef.current);
        setGenerationStartedAt(generationStartedAtRef.current);
        setProgress(message as SearchProgress);
      } else if (message?.type === "generation") {
        const point = {
          generation: finiteInteger(message.generation, 0),
          length: Math.max(0, finiteInteger(message.solutionLength, 0)),
          provisional: Boolean(message.provisional),
        };
        setSolutionLengthHistory((current) => {
          if (point.generation <= 0) return current;
          const previous = current.at(-1);
          if (previous?.generation === point.generation) {
            return [...current.slice(0, -1), point];
          }
          return [...current, point];
        });
        const timingPoint = {
          generation: finiteInteger(message.generation, 0),
          durationMs: Math.max(0, Number(message.durationMs) || 0),
          elapsedMs: Math.max(0, Number(message.elapsedMs) || 0),
        };
        setGenerationTimingHistory((current) => {
          if (timingPoint.generation <= 0) return current;
          const previous = current.at(-1);
          if (previous?.generation === timingPoint.generation) {
            return [...current.slice(0, -1), timingPoint];
          }
          return [...current, timingPoint];
        });
        setProgress((current) => ({
          ...current,
          generation: Math.min(current.generations, timingPoint.generation + 1),
          elapsedMs: timingPoint.elapsedMs,
          generationElapsedMs: 0,
        }));
        generationStartedAtRef.current = Date.now();
        setGenerationStartedAt(generationStartedAtRef.current);
      } else if (message?.type === "done") {
        if (message.candidate) setBest(message.candidate as SearchLevel);
        setProgress((current) => ({
          ...current,
          ...message,
          generation: current.generation,
          generations: current.generations,
          evaluatorCount: current.evaluatorCount,
          generationElapsedMs: current.generationElapsedMs,
        }));
        runStartedAtRef.current = null;
        generationStartedAtRef.current = null;
        setRunStartedAt(null);
        setGenerationStartedAt(null);
        setRunning(false);
        workerRef.current = null;
        onStatus(message.candidate?.optimal
          ? `Evolution complete · best proven puzzle is ${message.candidate.moves} commands`
          : message.candidate?.provisional
            ? `Evolution complete · best route is ${message.candidate.moves} commands but still needs a larger proof budget`
            : "Evolution complete · no solution found within the selected limits");
      } else if (message?.type === "error") {
        runStartedAtRef.current = null;
        generationStartedAtRef.current = null;
        setRunStartedAt(null);
        setGenerationStartedAt(null);
        setRunning(false);
        workerRef.current = null;
        onStatus(message.message ?? "Search worker failed");
      }
    };
    worker.onerror = (event) => {
      runStartedAtRef.current = null;
      generationStartedAtRef.current = null;
      setRunStartedAt(null);
      setGenerationStartedAt(null);
      setRunning(false);
      workerRef.current = null;
      onStatus(event.message || "Search worker crashed");
    };
    worker.postMessage({
      type: "start",
      configuration: {
        ...options,
        ...runOptions,
        blocks,
        roles,
        enabledBlockIds: runEnabledBlockIds,
        startingCandidate: startingCandidate
          ? {
            ...startingCandidate,
            voxels: startingCandidate.voxels.map((voxel) => ({ ...voxel })),
            solution: [],
          }
          : null,
      },
    });
  };

  const saveBest = () => {
    if (!best) return;
    const saved: SearchLevel = {
      ...best,
      id: `saved-search-${Date.now()}`,
      name: best.optimal
        ? `${best.moves}-command 3D puzzle`
        : best.provisional
          ? `${best.moves}-command provisional puzzle`
          : `Unproven 3D candidate`,
      createdAt: new Date().toISOString(),
      voxels: best.voxels.map((voxel) => ({ ...voxel })),
      solution: [...best.solution],
    };
    onSavedLevelsChange([saved, ...savedLevels]);
    setSelectedSavedId(saved.id);
    onStatus(`${saved.name} saved into project data`);
  };

  const deleteSaved = (id: string) => {
    onSavedLevelsChange(savedLevels.filter((level) => level.id !== id));
    if (selectedSavedId === id) setSelectedSavedId(null);
    onStatus("Saved search level deleted");
  };

  const buildSolutionTrace = useCallback(async () => {
    if (!activeLevel?.solution.length) {
      onStatus("This candidate has no proven solution trace");
      return;
    }
    setBuildingTrace(true);
    setViewMode("solution");
    setPlayingTrace(false);
    try {
      let frame = { voxels: activeLevel.voxels.map((voxel) => ({ ...voxel })) };
      const frames = [frame];
      for (const direction of activeLevel.solution) {
        const simulation = await simulateCommandWithCpp(
          frame,
          direction,
          blocks,
          roles,
          activeLevel.world,
        );
        for (const tick of simulation.frames) {
          frames.push({ voxels: tick.voxels.map((voxel) => ({ ...voxel })) });
        }
        frame = simulation.final;
        if (!simulation.frames.length) {
          frames.push({ voxels: frame.voxels.map((voxel) => ({ ...voxel })) });
        }
      }
      setSolutionFrames(frames);
      setSolutionFrameIndex(0);
      onStatus(`${activeLevel.solution.length} commands expanded into ${frames.length - 1} animation frames`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Could not build the solution animation");
    } finally {
      setBuildingTrace(false);
    }
  }, [activeLevel, blocks, onStatus, roles]);

  const resetPlay = useCallback(() => {
    if (!activeLevel) return;
    setPlayFrame({ voxels: activeLevel.voxels.map((voxel) => ({ ...voxel })) });
    setPlayMoves(0);
    setViewMode("play");
    onStatus("Play reset · use arrow keys or the direction pad");
  }, [activeLevel, onStatus]);

  const playDirection = useCallback(async (direction: SearchDirection) => {
    if (!activeLevel || !playFrame || playBusy) return;
    setPlayBusy(true);
    try {
      const simulation = await simulateCommandWithCpp(
        playFrame,
        direction,
        blocks,
        roles,
        activeLevel.world,
      );
      setPlayFrame(simulation.final);
      setPlayMoves((value) => value + 1);
      const playerIds = new Set(blocks.filter((block) => block.roleId === "player").map((block) => block.id));
      const goalIds = new Set(blocks.filter((block) => block.roleId === "goal").map((block) => block.id));
      const player = simulation.final.voxels.find((voxel) =>
        playerIds.has(voxel.blockId) && voxel.x >= 0);
      const hadCollectible = playFrame.voxels.some((voxel) =>
        goalIds.has(voxel.blockId) && voxel.x >= 0);
      const collectibleRemains = simulation.final.voxels.some((voxel) =>
        goalIds.has(voxel.blockId) && voxel.x >= 0);
      if (player && hadCollectible && !collectibleRemains) {
        onStatus(`Solved in ${playMoves + 1} commands${activeLevel.optimal ? ` · optimum ${activeLevel.moves}` : ""}`);
      }
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "The C++ engine could not play that move");
    } finally {
      setPlayBusy(false);
    }
  }, [activeLevel, blocks, onStatus, playBusy, playFrame, playMoves, roles]);

  useEffect(() => {
    if (viewMode !== "play") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) return;
      const direction = ({
        ArrowUp: "up",
        ArrowRight: "right",
        ArrowDown: "down",
        ArrowLeft: "left",
      } as Record<string, SearchDirection>)[event.key];
      if (!direction) return;
      event.preventDefault();
      void playDirection(direction);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playDirection, viewMode]);

  return (
    <section className="search-layout" aria-label="Evolutionary puzzle search">
      <aside className="search-controls">
        <div className="search-panel-heading">
          <span>EVOLUTION CONFIGURATION</span>
          <h2>Grow a difficult 3D puzzle</h2>
          <p>C++ screens each candidate, then exactly proves the strongest routes. Fitness maximizes the shortest proven command sequence.</p>
        </div>
        <label className="field search-preset">
          <span>Strategy preset</span>
          <select
            value={preset}
            disabled={running}
            onChange={(event) => {
              const value = event.target.value;
              if (value !== "custom") {
                applyPreset(value as keyof typeof SEARCH_PRESETS);
              }
            }}
          >
            {Object.entries(SEARCH_PRESETS).map(([key, definition]) => (
              <option key={key} value={key}>{definition.label}</option>
            ))}
            {preset === "custom" && <option value="custom">Custom</option>}
          </select>
        </label>
        <small className="search-capacity-note">The MazeBench preset recreates its sparse planar terrain and evolution schedule while retaining this project&apos;s one generalized C++ physics solver.</small>
        <div className="search-dimensions">
          <label className="field"><span>Width</span><input type="number" min="4" max={SEARCH_COORDINATE_MAX + 1} value={options.width} disabled={running} onChange={(event) => updateOption("width", event.target.value)} /></label>
          <label className="field"><span>Depth</span><input type="number" min="4" max={SEARCH_COORDINATE_MAX + 1} value={options.depth} disabled={running} onChange={(event) => updateOption("depth", event.target.value)} /></label>
          <label className="field"><span>Rows above floor</span><input type="number" min="1" max={SEARCH_COORDINATE_MAX} value={options.layers} disabled={running} onChange={(event) => updateOption("layers", event.target.value)} /></label>
        </div>
        <small className="search-capacity-note">No 16-cell axis cap · dimensions may use any shape that fits the C++ solver&apos;s {SEARCH_VOXEL_CAPACITY.toLocaleString()}-voxel scene capacity.</small>
        <div className="search-dimensions">
          <label className="field"><span>Population</span><input type="number" min="4" max="1024" value={options.population} disabled={running} onChange={(event) => updateOption("population", event.target.value)} /></label>
          <label className="field"><span>Generations</span><input type="number" min="1" max="10000" value={options.generations} disabled={running} onChange={(event) => updateOption("generations", event.target.value)} /></label>
          <label className="field"><span>Proof states</span><input type="number" min="100" max={SEARCH_NODE_CAPACITY} step="100" value={options.maxNodes} disabled={running} onChange={(event) => updateOption("maxNodes", event.target.value)} /></label>
        </div>
        <div className="search-dimensions">
          <label className="field"><span>Collectibles</span><input type="number" min="1" max="16" value={options.collectibles} disabled={running} onChange={(event) => updateOption("collectibles", event.target.value)} /></label>
          <label className="field"><span>Target commands</span><input type="number" min="1" max="4096" value={options.targetMoves} disabled={running} onChange={(event) => updateOption("targetMoves", event.target.value)} /></label>
          <label className="field"><span>Deterministic seed</span><input type="number" min="0" max="4294967295" value={options.seed} disabled={running} onChange={(event) => updateOption("seed", event.target.value)} /></label>
        </div>
        <label className="field search-density"><span>Initial wall density</span><input type="range" min="5" max="90" value={options.terrainDensity} disabled={running} onChange={(event) => updateOption("terrainDensity", event.target.value)} /><strong>{options.terrainDensity}%</strong></label>
        {weightlessEnabled && (
          <div className="search-weightless-options">
            <div className="search-dimensions search-dimensions--two">
              <label className="field"><span>Min distinct box IDs</span><input type="number" min="0" max="32" value={options.minWeightlessBoxes} disabled={running} onChange={(event) => updateOption("minWeightlessBoxes", event.target.value)} /></label>
              <label className="field"><span>Max distinct box IDs</span><input type="number" min="0" max="32" value={options.maxWeightlessBoxes} disabled={running} onChange={(event) => updateOption("maxWeightlessBoxes", event.target.value)} /></label>
            </div>
            <small>Counts separate numbered polycubes. Fresh pieces use 2–5 cubes; later growth remains uncapped within the selected volume.</small>
          </div>
        )}
        <label className="search-hole-toggle" htmlFor="search-evolve-holes" aria-label="Evolve holes in the floor">
          <input id="search-evolve-holes" type="checkbox" checked={options.evolveHoles} disabled={running} onChange={(event) => { setPreset("custom"); setOptions((current) => ({ ...current, evolveHoles: event.target.checked })); }} />
          <span><b>Evolve holes in the floor</b><small>Empty Row-0 cells become bottomless voids; this terrain gets equal mutation opportunity.</small></span>
        </label>
        <details className="search-advanced">
          <summary>Advanced evolution controls</summary>
          <div className="search-dimensions search-dimensions--two">
            <label className="field"><span>Terrain geometry</span><select value={options.terrainMode} disabled={running} onChange={(event) => { setPreset("custom"); setOptions((current) => ({ ...current, terrainMode: event.target.value as "planar" | "3d" })); }}><option value="planar">Planar / 2D</option><option value="3d">Unrestricted 3D</option></select></label>
            <label className="field"><span>Evaluator workers</span><input type="number" min="0" max="16" value={options.evaluatorWorkers} disabled={running} onChange={(event) => updateOption("evaluatorWorkers", event.target.value)} /><small>0 = automatic</small></label>
            <label className="field"><span>Initial Ice max</span><input type="number" min="0" max="4096" value={options.initialIceMax} disabled={running} onChange={(event) => updateOption("initialIceMax", event.target.value)} /></label>
            <label className="field"><span>Initial holes max</span><input type="number" min="0" max="4096" value={options.initialHoleMax} disabled={running} onChange={(event) => updateOption("initialHoleMax", event.target.value)} /></label>
            <label className="field"><span>Screening states</span><input type="number" min="100" max={SEARCH_NODE_CAPACITY} step="100" value={options.screeningNodes} disabled={running} onChange={(event) => updateOption("screeningNodes", event.target.value)} /></label>
            <label className="field"><span>Proofs / generation</span><input type="number" min="1" max="256" value={options.proofCandidates} disabled={running} onChange={(event) => updateOption("proofCandidates", event.target.value)} /></label>
            <label className="field"><span>Elite survivors</span><input type="number" min="2" max="256" value={options.eliteCount} disabled={running} onChange={(event) => updateOption("eliteCount", event.target.value)} /></label>
            <label className="field"><span>Reverse seeds %</span><input type="number" min="0" max="100" value={options.reverseScramblePercent} disabled={running} onChange={(event) => updateOption("reverseScramblePercent", event.target.value)} /></label>
            <label className="field"><span>Minimum reverse pulls</span><input type="number" min="1" max="1000" value={options.minimumScramblePulls} disabled={running} onChange={(event) => updateOption("minimumScramblePulls", event.target.value)} /></label>
            <label className="field"><span>Endpoint mutation %</span><input type="number" min="0" max="100" value={options.endpointMutationPercent} disabled={running} onChange={(event) => updateOption("endpointMutationPercent", event.target.value)} /></label>
            <label className="field"><span>Escape after stagnant</span><input type="number" min="1" max="10000" value={options.escapeStagnation} disabled={running} onChange={(event) => updateOption("escapeStagnation", event.target.value)} /></label>
            <label className="field"><span>More immigrants after</span><input type="number" min="1" max="10000" value={options.immigrantStagnation} disabled={running} onChange={(event) => updateOption("immigrantStagnation", event.target.value)} /></label>
            <label className="field"><span>Continue-seed population %</span><input type="number" min="0" max="100" value={options.seedPopulationPercent} disabled={running} onChange={(event) => updateOption("seedPopulationPercent", event.target.value)} /></label>
          </div>
          <label className="search-hole-toggle" htmlFor="search-score-interactions" aria-label="Reward physics interactions">
            <input id="search-score-interactions" type="checkbox" checked={options.analyzeInteractions} disabled={running} onChange={(event) => { setPreset("custom"); setOptions((current) => ({ ...current, analyzeInteractions: event.target.checked })); }} />
            <span><b>Reward physics interactions</b><small>Replays promoted solutions to prefer pushes, Ice slides, and drops. Leave off for maximum throughput.</small></span>
          </label>
          <small>Screen every board cheaply, then re-run the strongest routes at the proof budget. A route found after pruning is labeled provisional and never presented as optimal.</small>
        </details>
        <div className="search-blocks">
          <div><strong>Blocks allowed in evolution</strong><small>Floor stays on Row 0. If Floor is off, enabled Ice fills the starting Row-0 plane.</small></div>
          {blocks.map((block) => (
            <label key={block.id} className="search-block-toggle" htmlFor={`search-block-${block.id}`} aria-label={`Allow ${block.name} in evolution`}>
              <input id={`search-block-${block.id}`} type="checkbox" checked={enabledBlockIds.includes(block.id)} disabled={running} onChange={() => toggleBlock(block.id)} />
              <span className="search-block-swatch" style={{ background: block.color }} />
              <span><b>{block.name}</b><small>{roles.find((role) => role.id === block.roleId)?.name ?? block.roleId}</small></span>
            </label>
          ))}
        </div>
        <div className="search-primary-actions">
          {running
            ? <button className="tool-button search-stop" onClick={stopSearch}>Stop evolution</button>
            : <button className="tool-button tool-button--primary" onClick={() => startSearch()}>Start evolution</button>}
          <button className="tool-button" disabled={!best} onClick={saveBest}>Save current best</button>
          <button className="tool-button" disabled={running || !activeLevel} onClick={() => activeLevel && startSearch(activeLevel)}>Evolve selected</button>
        </div>
      </aside>

      <section className="search-main">
        <div className="search-metrics">
          <article><span>Generation</span><strong>{progress.generation}<small> / {progress.generations}</small></strong></article>
          <article><span>Unique solves</span><strong>{progress.uniqueCandidates.toLocaleString()}<small> · {progress.cacheHits.toLocaleString()} cached · {progress.solvesPerSecond}/sec</small></strong></article>
          <article><span>Solution length</span><strong>{activeLevel?.optimal || activeLevel?.provisional ? activeLevel.moves : progress.bestMoves || progress.bestProvisionalMoves || "—"}<small>{activeLevel?.provisional ? " provisional commands" : " commands"}</small></strong></article>
          <article><span>C++ solver</span><strong>{formatRate(progress.solverCommandTransitionsPerSecond || activeLevel?.commandTransitionsPerSecond || 0)}<small> command sims/sec · {formatRate(progress.solverNodesPerSecond || activeLevel?.nodesPerSecond || 0)} global states/sec</small></strong></article>
          <article><span>End-to-end</span><strong>{formatRate(progress.commandTransitionsPerSecond)}<small> command sims/sec · {formatRate(progress.nodesPerSecond)} global states/sec · {Math.max(1, progress.evaluatorCount)} workers</small></strong></article>
          <article className={running ? "search-clock active" : "search-clock"}><span>Run clock</span><strong>{formatClock(elapsedClockMs)}<small>{running ? `● ACTIVE · Gen ${Math.max(1, progress.generation)} · ${formatGenerationDuration(generationClockMs)}` : progress.generation ? `Complete · ${progress.generation} generations` : "Not running"}</small></strong></article>
        </div>

        <div className="search-trace-charts">
          <SolutionLengthChart history={solutionLengthHistory} running={running} />
          <GenerationTimeChart
            history={generationTimingHistory}
            running={running}
            activeGeneration={Math.max(1, progress.generation)}
            activeDurationMs={generationClockMs}
          />
        </div>

        <section className="search-stage">
          <div className="search-stage-toolbar">
            <div>
              <span>{selectedSaved ? "SAVED LEVEL" : running ? "LIVE INCUMBENT" : "CURRENT BEST"}</span>
              <strong>{activeLevel?.name ?? "Waiting for the first candidate"}</strong>
            </div>
            {activeLevel && <div className="search-view-tabs">
              <button className={viewMode === "inspect" ? "active" : ""} onClick={() => setViewMode("inspect")}>Inspect</button>
              <button className={viewMode === "solution" ? "active" : ""} disabled={!activeLevel.solution.length} onClick={() => solutionFrames.length ? setViewMode("solution") : void buildSolutionTrace()}>Solution</button>
              <button className={viewMode === "play" ? "active" : ""} onClick={resetPlay}>Play</button>
            </div>}
          </div>
          {activeLevel ? (
            <MazeBenchCanvas
              cameraSceneKey={activeLevel.id}
              frame={displayFrame}
              blocks={blocks}
              genericBlockIds={genericBlockIds}
              world={world}
              layer={1}
              interactive
              paintable={false}
            />
          ) : (
            <div className="search-empty-stage"><span>◇</span><strong>No candidate yet</strong><p>Choose the 3D volume and allowed blocks, then start evolution.</p></div>
          )}
          {viewMode === "solution" && activeLevel && (
            <div className="solution-controls">
              <button onClick={() => setSolutionFrameIndex((value) => Math.max(0, value - 1))} disabled={!solutionFrames.length || solutionFrameIndex === 0}>←</button>
              <button className="solution-play" disabled={buildingTrace || !solutionFrames.length} onClick={() => setPlayingTrace((value) => !value)}>{buildingTrace ? "Building…" : playingTrace ? "Pause" : "Play solution"}</button>
              <span>{solutionFrames.length ? `${solutionFrameIndex + 1} / ${solutionFrames.length}` : "No frames"}</span>
              <button onClick={() => setSolutionFrameIndex((value) => Math.min(solutionFrames.length - 1, value + 1))} disabled={!solutionFrames.length || solutionFrameIndex >= solutionFrames.length - 1}>→</button>
            </div>
          )}
          {viewMode === "play" && activeLevel && (
            <div className="play-controls">
              <span>{playMoves} commands</span>
              <div className="direction-pad">
                <button onClick={() => void playDirection("up")}><DirectionGlyph direction="up" /></button>
                <button onClick={() => void playDirection("left")}><DirectionGlyph direction="left" /></button>
                <button onClick={() => void playDirection("down")}><DirectionGlyph direction="down" /></button>
                <button onClick={() => void playDirection("right")}><DirectionGlyph direction="right" /></button>
              </div>
              <button className="tool-button" onClick={resetPlay}>Reset play</button>
            </div>
          )}
        </section>

        {activeLevel && (
          <section className="search-record-detail">
            <div><span>Proof</span><strong>{activeLevel.optimal ? "Shortest path proven" : activeLevel.provisional ? "Valid route · proof incomplete" : activeLevel.limitHit ? "State limit reached" : "Not solved"}</strong></div>
            <div><span>Expanded</span><strong>{activeLevel.expanded.toLocaleString()}</strong></div>
            <div><span>Generated</span><strong>{activeLevel.generated.toLocaleString()}</strong></div>
            <div><span>Pushes</span><strong>{(activeLevel.pushes ?? 0).toLocaleString()}</strong></div>
            <div><span>Solution</span><strong className="solution-sequence">{activeLevel.solution.length ? activeLevel.solution.map((direction, index) => <DirectionGlyph key={`${index}-${direction}`} direction={direction} />) : "—"}</strong></div>
          </section>
        )}
      </section>

      <aside className="saved-searches">
        <div className="saved-searches-heading"><span>PROJECT LIBRARY</span><strong>Saved searches</strong><em>{savedLevels.length}</em></div>
        <div className="saved-search-list">
          {savedLevels.length ? savedLevels.map((level) => (
            <article key={level.id} className={selectedSavedId === level.id ? "active" : ""}>
              <button className="saved-search-select" onClick={() => { setSelectedSavedId(level.id); setViewMode("inspect"); }}>
                <span className="saved-search-score">{level.optimal || level.provisional ? level.moves : "?"}</span>
                <span><strong>{level.name}</strong><small>{level.world.width}×{level.world.height}×{level.layers} · {level.expanded.toLocaleString()} expanded</small></span>
              </button>
              <button className="saved-search-delete" aria-label={`Delete ${level.name}`} onClick={() => deleteSaved(level.id)}>×</button>
            </article>
          )) : <p>No evolved levels saved yet. Records saved here are written into the repo-backed project JSON.</p>}
        </div>
      </aside>
    </section>
  );
}
