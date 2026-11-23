import { performance } from "node:perf_hooks";

import {
  boxEntities,
  makeCandidate,
  mulberry32,
  mutateCandidate,
} from "../public/search-worker.js";

const blocks = [
  { id: "floor", roleId: "floor" },
  { id: "wall", roleId: "solid" },
  { id: "ice", roleId: "ice" },
  { id: "player", roleId: "player" },
  { id: "gem", roleId: "goal" },
  { id: "box", roleId: "weightless-pushable" },
];
const configuration = {
  width: 16,
  depth: 16,
  layers: 1,
  collectibles: 1,
  minWeightlessBoxes: 10,
  maxWeightlessBoxes: 10,
  terrainDensity: 45,
  initialIceMax: 18,
  initialHoleMax: 8,
  terrainMode: "planar",
  reverseScramblePercent: 34,
  minimumScramblePulls: 1,
  endpointMutationPercent: 0,
  evolveHoles: true,
  targetMoves: 600,
  blocks,
  roles: [],
  enabledBlockIds: blocks.map((block) => block.id),
  seed: 20260812,
};

const sampleCount = 256;
const random = mulberry32(configuration.seed);
const started = performance.now();
const candidates = Array.from(
  { length: sampleCount },
  () => makeCandidate(configuration, random),
);
const constructionSeconds = (performance.now() - started) / 1000;
let ice = 0;
let holes = 0;
let voxels = 0;
for (const candidate of candidates) {
  const candidateIce = candidate.voxels.filter((voxel) => voxel.blockId === "ice");
  if (candidateIce.some((voxel) => voxel.z !== 0)) {
    throw new Error("Planar benchmark generated raised Ice");
  }
  const boxes = boxEntities(candidate.voxels, [blocks.at(-1)]);
  if (boxes.length !== 10) throw new Error("Distinct box count drifted");
  ice += candidateIce.length;
  holes += 256 - candidate.voxels.filter((voxel) => voxel.z === 0 &&
    (voxel.blockId === "floor" || voxel.blockId === "ice")).length;
  voxels += candidate.voxels.length;
}

let mutated = candidates[0];
const mutationRandom = mulberry32(configuration.seed + 1);
const mutationCount = 1000;
const mutationStarted = performance.now();
for (let index = 0; index < mutationCount; index += 1) {
  mutated = mutateCandidate(mutated, configuration, mutationRandom);
}
const mutationSeconds = (performance.now() - mutationStarted) / 1000;

console.log([
  "workload=evolution_planar_16x16x2_10_boxes",
  `seed=${configuration.seed}`,
  `candidates=${sampleCount}`,
  `candidates_per_second=${(sampleCount / constructionSeconds).toFixed(1)}`,
  `average_voxels=${(voxels / sampleCount).toFixed(1)}`,
  `average_ice=${(ice / sampleCount).toFixed(1)}`,
  `average_holes=${(holes / sampleCount).toFixed(1)}`,
  `mutations_per_second=${(mutationCount / mutationSeconds).toFixed(1)}`,
].join(" "));
