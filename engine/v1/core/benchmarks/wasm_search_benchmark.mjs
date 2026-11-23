import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const EXPECTED_FIXTURE_HASH = 0xab2b3428d9df8632n;
const SAMPLE_COUNT = 5;
const TARGET_SAMPLE_SECONDS = 0.5;
const WARMUP_SECONDS = 0.25;

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

function loadFixture(text) {
  const metadata = new Map();
  const rows = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const match = /^#\s*([^=]+)=(.*)$/u.exec(line);
      if (match) metadata.set(match[1].trim(), match[2].trim());
      continue;
    }
    if (line === "x,y,z,role,generic_id") continue;
    const fields = line.split(",");
    if (fields.length !== 5) throw new Error(`Invalid fixture voxel row: ${line}`);
    const [x, y, z, roleName, genericId] = fields;
    rows.push({
      x: Number.parseInt(x, 10),
      y: Number.parseInt(y, 10),
      z: Number.parseInt(z, 10),
      roleName,
      genericId: Number.parseInt(genericId, 10),
    });
  }
  const fixture = {
    name: metadata.get("fixture") ?? "",
    width: Number.parseInt(metadata.get("width") ?? "0", 10),
    height: Number.parseInt(metadata.get("height") ?? "0", 10),
    expectedMoves: Number.parseInt(metadata.get("expected_moves") ?? "0", 10),
    expectedVoxels: Number.parseInt(metadata.get("expected_voxels") ?? "0", 10),
    rows,
  };
  if (!fixture.name || fixture.width <= 0 || fixture.height <= 0 ||
      fixture.expectedMoves <= 0 || fixture.expectedVoxels !== rows.length) {
    throw new Error("Incomplete or inconsistent benchmark fixture");
  }
  const canonicalRows = rows.map((row) =>
    `${row.x},${row.y},${row.z},${row.roleName},${row.genericId}`);
  fixture.hash = fnv1a64(
    `${fixture.name}|${fixture.width}|${fixture.height}|` +
    `${fixture.expectedMoves}|${fixture.expectedVoxels}\n` +
    `${canonicalRows.join("\n")}\n`,
  );
  if (fixture.hash !== EXPECTED_FIXTURE_HASH) {
    throw new Error("Benchmark fixture hash does not match its frozen value");
  }
  return fixture;
}

const fixture = loadFixture(await readFile(
  new URL("./fixtures/mixed_3d_427.csv", import.meta.url),
  "utf8",
));
const bytes = await readFile(new URL(
  "../../apps/web/public/physics/voxel_physics.wasm",
  import.meta.url,
));
const { instance } = await WebAssembly.instantiate(bytes, {});
const physics = instance.exports;
const encoder = new TextEncoder();

function role(name) {
  const encoded = encoder.encode(name);
  new Uint8Array(
    physics.memory.buffer,
    physics.role_buffer(),
    physics.role_buffer_capacity(),
  ).set(encoded);
  return physics.role_code(encoded.length);
}

const roleCodes = new Map(
  [...new Set(fixture.rows.map((row) => row.roleName))]
    .map((roleName) => [roleName, role(roleName)]),
);
const stride = physics.voxel_stride();
if (fixture.rows.length > physics.search_voxel_capacity()) {
  throw new Error("Fixture exceeds the WebAssembly search voxel capacity");
}
const buffer = new Int32Array(
  physics.memory.buffer,
  physics.voxel_buffer(),
  fixture.rows.length * stride,
);

function writeFixture() {
  fixture.rows.forEach((voxel, index) => {
    buffer.set([
      voxel.x,
      voxel.y,
      voxel.z,
      roleCodes.get(voxel.roleName),
      voxel.genericId,
    ], index * stride);
  });
}

function readResult(status, includeSolution = false) {
  const result = {
    status,
    moves: physics.search_moves(),
    expanded: physics.search_expanded(),
    generated: physics.search_generated(),
    transpositions: physics.search_transpositions(),
    localExpanded: physics.search_local_expanded(),
    commandTransitions: physics.search_command_transitions(),
    fullPhysicsTransitions: physics.search_full_physics_transitions(),
    solution: [],
  };
  const solutionLength = physics.search_solution_length();
  if (includeSolution) {
    for (let index = 0; index < solutionLength; index += 1) {
      result.solution.push(physics.search_solution_step(index));
    }
  }
  if (status !== 1 || result.moves !== fixture.expectedMoves ||
      solutionLength !== fixture.expectedMoves) {
    throw new Error(
      `Exact-search correctness failure: expected ${fixture.expectedMoves} moves, ` +
      `got status ${status} and ${result.moves} moves`,
    );
  }
  return result;
}

function solve(includeSolution = false) {
  writeFixture();
  const started = performance.now();
  const status = physics.search_solve(
    fixture.rows.length,
    fixture.width,
    fixture.height,
    physics.search_node_capacity(),
  );
  const seconds = Math.max(0.000001, (performance.now() - started) / 1000);
  return { result: readResult(status, includeSolution), seconds };
}

function checkReplay(solution) {
  writeFixture();
  for (const direction of solution) {
    if (physics.simulate_turn(
      fixture.rows.length,
      fixture.width,
      fixture.height,
      direction,
    ) !== 0) {
      throw new Error("Solution replay rejected a command");
    }
  }
  let playerActive = false;
  let goalActive = false;
  fixture.rows.forEach((voxel, index) => {
    const x = buffer[index * stride];
    const y = buffer[index * stride + 1];
    if (voxel.roleName === "player" && x >= 0 && y >= 0) playerActive = true;
    if (voxel.roleName === "goal" && x >= 0 && y >= 0) goalActive = true;
  });
  if (!playerActive || goalActive) {
    throw new Error(
      "Solution replay did not leave an active player with every gem collected",
    );
  }
}

const warmup = solve(true);
checkReplay(warmup.result.solution);
let warmupSeconds = warmup.seconds;
while (warmupSeconds < WARMUP_SECONDS) warmupSeconds += solve().seconds;
const samples = [];
for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
  let expanded = 0;
  let generated = 0;
  let transpositions = 0;
  let localExpanded = 0;
  let commandTransitions = 0;
  let fullPhysicsTransitions = 0;
  let seconds = 0;
  let solves = 0;
  do {
    const timed = solve();
    const { result } = timed;
    seconds += timed.seconds;
    solves += 1;
    expanded += result.expanded;
    generated += result.generated;
    transpositions += result.transpositions;
    localExpanded += result.localExpanded;
    commandTransitions += result.commandTransitions;
    fullPhysicsTransitions += result.fullPhysicsTransitions;
  } while (seconds < TARGET_SAMPLE_SECONDS);
  samples.push({
    seconds,
    solves,
    expanded,
    generated,
    transpositions,
    localExpanded,
    commandTransitions,
    fullPhysicsTransitions,
  });
}
samples.sort((left, right) =>
  (left.solves / left.seconds) - (right.solves / right.seconds));
const median = samples[Math.floor(SAMPLE_COUNT / 2)];
console.log([
  `workload=wasm_${fixture.name}`,
  `fixture_hash=${fixture.hash.toString(16).padStart(16, "0")}`,
  `voxels=${fixture.rows.length}`,
  `expected_moves=${fixture.expectedMoves}`,
  `samples=${SAMPLE_COUNT}`,
  `median_sample_solves=${median.solves}`,
  `median_exact_solves_per_second=${Math.round(median.solves / median.seconds)}`,
  `median_global_dynamic_states_per_second=${Math.round(median.expanded / median.seconds)}`,
  `median_attempted_dynamic_successors_per_second=${Math.round(median.generated / median.seconds)}`,
  `median_local_player_states_per_second=${Math.round(median.localExpanded / median.seconds)}`,
  `median_attempted_command_simulations_per_second=${Math.round(median.commandTransitions / median.seconds)}`,
  `global_dynamic_states_per_solve=${Math.round(median.expanded / median.solves)}`,
  `attempted_dynamic_successors_per_solve=${Math.round(median.generated / median.solves)}`,
  `transpositions_per_solve=${Math.round(median.transpositions / median.solves)}`,
  `local_player_states_per_solve=${Math.round(median.localExpanded / median.solves)}`,
  `attempted_command_simulations_per_solve=${Math.round(median.commandTransitions / median.solves)}`,
  `full_physics_transitions_per_solve=${Math.round(median.fullPhysicsTransitions / median.solves)}`,
  `median_sample_seconds=${median.seconds.toFixed(6)}`,
].join(" "));
