import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const DYNAMIC_ROLES = new Set([
  "player",
  "pushable",
  "weightless-pushable",
]);

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
    assert.equal(fields.length, 5, `invalid fixture row: ${line}`);
    rows.push({
      x: Number.parseInt(fields[0], 10),
      y: Number.parseInt(fields[1], 10),
      z: Number.parseInt(fields[2], 10),
      role: fields[3],
      genericId: Number.parseInt(fields[4], 10),
    });
  }
  return {
    width: Number.parseInt(metadata.get("width") ?? "0", 10),
    height: Number.parseInt(metadata.get("height") ?? "0", 10),
    expectedMoves: Number.parseInt(metadata.get("expected_moves") ?? "0", 10),
    rows,
  };
}

test("prepared passive commands exactly match full physics along mixed 3D solution", async () => {
  const fixture = loadFixture(await readFile(new URL(
    "../benchmarks/fixtures/mixed_3d_427.csv",
    import.meta.url,
  ), "utf8"));
  const bytes = await readFile(new URL(
    "../../apps/web/public/physics/voxel_physics.wasm",
    import.meta.url,
  ));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const engine = instance.exports;
  const encoder = new TextEncoder();
  const roleCodes = new Map();
  const roleCode = (name) => {
    if (roleCodes.has(name)) return roleCodes.get(name);
    const encoded = encoder.encode(name);
    new Uint8Array(
      engine.memory.buffer,
      engine.role_buffer(),
      engine.role_buffer_capacity(),
    ).set(encoded);
    const code = engine.role_code(encoded.length);
    roleCodes.set(name, code);
    return code;
  };

  const ordered = fixture.rows.toSorted((left, right) =>
    Number(DYNAMIC_ROLES.has(right.role)) -
    Number(DYNAMIC_ROLES.has(left.role)));
  const dynamicCount = ordered.filter((voxel) =>
    DYNAMIC_ROLES.has(voxel.role)).length;
  const stride = engine.voxel_stride();
  const buffer = new Int32Array(
    engine.memory.buffer,
    engine.voxel_buffer(),
    ordered.length * stride,
  );
  const write = (state) => state.forEach((voxel, index) => buffer.set([
    voxel.x,
    voxel.y,
    voxel.z,
    roleCode(voxel.role),
    voxel.genericId,
  ], index * stride));
  const read = (template) => template.map((voxel, index) => ({
    ...voxel,
    x: buffer[index * stride],
    y: buffer[index * stride + 1],
    z: buffer[index * stride + 2],
  }));
  const signature = (state) => state
    .map(({ x, y, z }) => `${x},${y},${z}`)
    .join(";");
  const prepare = () => assert.equal(engine.search_prepare_scene(
    ordered.length,
    fixture.width,
    fixture.height,
    dynamicCount,
  ), 1, "could not prepare the differential scene");

  write(ordered);
  assert.equal(engine.search_solve(
    ordered.length,
    fixture.width,
    fixture.height,
    engine.search_node_capacity(),
  ), 1, "the frozen differential fixture must remain solvable");
  assert.equal(engine.search_solution_length(), fixture.expectedMoves);
  const solution = Array.from(
    { length: fixture.expectedMoves },
    (_, index) => engine.search_solution_step(index),
  );

  let state = ordered;
  let handled = 0;
  for (let step = 0; step <= solution.length; step += 1) {
    for (let direction = 0; direction < 4; direction += 1) {
      write(state);
      prepare();
      assert.equal(engine.search_prepare_quiescent_snapshot(
        ordered.length,
        fixture.width,
        fixture.height,
      ), 1, "could not prepare a passive snapshot");
      const passive = engine.search_try_passive_quiescent_turn(
        ordered.length,
        fixture.width,
        fixture.height,
        direction,
      );
      if (passive !== 1) continue;
      handled += 1;
      const accelerated = read(state);

      write(state);
      prepare();
      assert.equal(engine.simulate_turn(
        ordered.length,
        fixture.width,
        fixture.height,
        direction,
      ), 0, `full command ${direction} failed at solution step ${step}`);
      assert.equal(
        signature(accelerated),
        signature(read(state)),
        `passive command ${direction} diverged at solution step ${step}`,
      );
    }
    if (step === solution.length) break;
    write(state);
    prepare();
    assert.equal(engine.simulate_turn(
      ordered.length,
      fixture.width,
      fixture.height,
      solution[step],
    ), 0, `solution command ${step} failed`);
    state = read(state);
  }
  assert.ok(handled > 1000, `expected broad passive coverage, got ${handled}`);
});
