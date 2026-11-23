const DIRECTION_NAMES = ["up", "right", "down", "left"];
const SEARCH_VOXEL_CAPACITY = 4096;
const SEARCH_COORDINATE_MAX = 32767;

let stopped = false;
let physicsPromise = null;
let evaluatorConfiguration = null;

function createEvaluationPool(configuration) {
  const available = Math.max(1, self.navigator?.hardwareConcurrency ?? 4);
  const requested = Math.floor(configuration.evaluatorWorkers ?? 0);
  const population = Math.max(1, Math.floor(configuration.population ?? 1));
  // Each evaluator owns one WASM engine. Auto leaves one logical core for the
  // UI/evolution worker and caps memory pressure; advanced users can override.
  const concurrency = Math.max(1, Math.min(
    16,
    population,
    requested > 0 ? requested : Math.min(8, Math.max(1, available - 1)),
  ));
  const workers = Array.from(
    { length: concurrency },
    () => new Worker("/search-worker.js", { type: "module" }),
  );
  workers.forEach((worker) => worker.postMessage({
    type: "initialize-evaluator",
    configuration,
  }));
  let requestId = 0;

  return {
    concurrency,
    async evaluate(jobs, onResult) {
      if (!jobs.length) return;
      let next = 0;
      let completed = 0;
      let finished = false;
      await new Promise((resolve) => {
        const finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        const assign = (worker) => {
          if (stopped) {
            finish();
            return;
          }
          if (next >= jobs.length) {
            if (completed >= jobs.length) finish();
            return;
          }
          const job = jobs[next++];
          const currentRequest = requestId++;
          worker.onmessage = (event) => {
            if (event.data?.type !== "evaluation" ||
                event.data.requestId !== currentRequest) return;
            completed += 1;
            onResult(job, event.data.result ?? null, event.data.error ?? null);
            if (completed >= jobs.length) finish();
            else assign(worker);
          };
          worker.onerror = (event) => {
            completed += 1;
            onResult(job, null, event.message || "Evaluation worker failed");
            if (completed >= jobs.length) finish();
            else assign(worker);
          };
          worker.postMessage({
            type: "evaluate",
            requestId: currentRequest,
            candidate: job.candidate,
            maximumNodes: job.maximumNodes,
            analyzeInteractions: job.analyzeInteractions,
          });
        };
        workers.slice(0, jobs.length).forEach(assign);
      });
    },
    close() {
      workers.forEach((worker) => worker.terminate());
    },
  };
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function integer(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function choose(random, values) {
  return values[Math.floor(random() * values.length)];
}

function keyOf(voxel) {
  return `${voxel.x},${voxel.y},${voxel.z}`;
}

function makeOccupancy(voxels) {
  const occupancy = new Map();
  for (const voxel of voxels) {
    const key = keyOf(voxel);
    const occupants = occupancy.get(key) ?? [];
    occupants.push(voxel);
    occupancy.set(key, occupants);
  }
  return occupancy;
}

function occupancyAdd(occupancy, voxel) {
  if (!occupancy) return;
  const key = keyOf(voxel);
  const occupants = occupancy.get(key) ?? [];
  occupants.push(voxel);
  occupancy.set(key, occupants);
}

function occupancyRemove(occupancy, voxel) {
  if (!occupancy) return;
  const key = keyOf(voxel);
  const occupants = occupancy.get(key);
  if (!occupants) return;
  const index = occupants.indexOf(voxel);
  if (index >= 0) occupants.splice(index, 1);
  if (!occupants.length) occupancy.delete(key);
}

function cloneCandidate(candidate) {
  return {
    ...candidate,
    voxels: candidate.voxels.map((voxel) => ({ ...voxel })),
    solution: [...(candidate.solution ?? [])],
  };
}

function candidateSignature(candidate) {
  const entries = candidate.voxels.map((voxel) =>
    `${voxel.blockId}:${voxel.genericId ?? -1}:${voxel.x},${voxel.y},${voxel.z}`)
    .sort();
  let first = 0x811C9DC5;
  let second = 0x9E3779B9;
  const metadata = `${candidate.world.width}x${candidate.world.height}x${candidate.layers}`;
  for (const entry of [metadata, ...entries]) {
    for (let index = 0; index < entry.length; index += 1) {
      const value = entry.charCodeAt(index);
      first = Math.imul(first ^ value, 0x01000193);
      second = Math.imul(second ^ value, 0x85EBCA6B);
    }
    first = Math.imul(first ^ 124, 0x01000193);
    second = Math.imul(second ^ 124, 0xC2B2AE35);
  }
  return `${candidate.voxels.length}:${(first >>> 0).toString(16).padStart(8, "0")}${
    (second >>> 0).toString(16).padStart(8, "0")}`;
}

function roleBlocks(configuration) {
  const enabled = new Set(configuration.enabledBlockIds);
  const byRole = new Map();
  for (const block of configuration.blocks) {
    if (!enabled.has(block.id)) continue;
    const values = byRole.get(block.roleId) ?? [];
    values.push(block);
    byRole.set(block.roleId, values);
  }
  return byRole;
}

function firstRoleBlock(byRole, roleId) {
  return byRole.get(roleId)?.[0] ?? null;
}

function put(voxels, voxel, occupancy = null) {
  const key = keyOf(voxel);
  const existing = occupancy?.get(key)?.[0];
  const index = existing
    ? voxels.indexOf(existing)
    : voxels.findIndex((item) => keyOf(item) === key);
  if (index >= 0) {
    occupancyRemove(occupancy, voxels[index]);
    voxels[index] = voxel;
  } else {
    voxels.push(voxel);
  }
  occupancyAdd(occupancy, voxel);
}

function removeAt(voxels, x, y, z, occupancy = null) {
  const key = `${x},${y},${z}`;
  const existing = occupancy?.get(key)?.[0];
  const index = existing
    ? voxels.indexOf(existing)
    : voxels.findIndex((voxel) => keyOf(voxel) === key);
  if (index >= 0) {
    occupancyRemove(occupancy, voxels[index]);
    voxels.splice(index, 1);
  }
}

function isCollectible(voxel, blockRoles) {
  return blockRoles.get(voxel.blockId) === "goal";
}

function rigidVoxelAt(
  voxels,
  x,
  y,
  z,
  blockRoles,
  ignored = null,
  occupancy = null,
) {
  const candidates = occupancy?.get(`${x},${y},${z}`) ?? voxels;
  return candidates.find((voxel) => voxel !== ignored &&
    (!ignored || !(ignored instanceof Set) || !ignored.has(voxel)) &&
    !isCollectible(voxel, blockRoles) &&
    voxel.x === x && voxel.y === y && voxel.z === z) ?? null;
}

function randomCell(random, width, depth) {
  return {
    x: integer(random, 0, Math.max(0, width - 1)),
    y: integer(random, 0, Math.max(0, depth - 1)),
  };
}

function validateRequiredBlocks(byRole) {
  const missing = ["player", "goal"]
    .filter((role) => !firstRoleBlock(byRole, role));
  if (!firstRoleBlock(byRole, "floor") && !firstRoleBlock(byRole, "ice")) {
    missing.unshift("floor or ice");
  }
  if (missing.length) {
    throw new Error(`Enable at least one ${missing.join(", ")} block before searching.`);
  }
}

const ADJACENT_3D = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function growthDirections(configuration, roleId) {
  if (configuration.terrainMode === "planar" &&
      ["ice", "weightless-pushable", "pushable"].includes(roleId)) {
    return ADJACENT_3D.slice(0, 4);
  }
  return ADJACENT_3D;
}

function insideVolume(voxel, configuration) {
  return voxel.x >= 0 && voxel.x < configuration.width &&
    voxel.y >= 0 && voxel.y < configuration.depth &&
    voxel.z >= 1 && voxel.z <= configuration.layers;
}

function insideStaticVolume(voxel, configuration) {
  return voxel.x >= 0 && voxel.x < configuration.width &&
    voxel.y >= 0 && voxel.y < configuration.depth &&
    voxel.z >= 0 && voxel.z <= configuration.layers;
}

function exactBlockClusters(voxels, blockIds) {
  const eligible = voxels.filter((voxel) => blockIds.has(voxel.blockId));
  const byKey = new Map(eligible.map((voxel) => [keyOf(voxel), voxel]));
  const visited = new Set();
  const clusters = [];
  for (const seed of eligible) {
    if (visited.has(seed)) continue;
    const members = [];
    const queue = [seed];
    visited.add(seed);
    while (queue.length) {
      const member = queue.pop();
      members.push(member);
      for (const [dx, dy, dz] of ADJACENT_3D) {
        const neighbor = byKey.get(`${member.x + dx},${member.y + dy},${member.z + dz}`);
        if (neighbor && neighbor.blockId === seed.blockId && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    clusters.push(members);
  }
  return clusters;
}

function remainsConnectedWithout(members, removed) {
  const remaining = members.filter((member) => member !== removed);
  if (remaining.length <= 1) return true;
  const byKey = new Map(remaining.map((member) => [keyOf(member), member]));
  const visited = new Set([remaining[0]]);
  const stack = [remaining[0]];
  while (stack.length) {
    const member = stack.pop();
    for (const [dx, dy, dz] of ADJACENT_3D) {
      const neighbor = byKey.get(`${member.x + dx},${member.y + dy},${member.z + dz}`);
      if (neighbor && !visited.has(neighbor)) {
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
  }
  return visited.size === remaining.length;
}

function growStaticCluster(
  voxels,
  members,
  configuration,
  random,
  blockRoles,
  floorBlock,
  occupancy = null,
) {
  if (!members.length) return false;
  const minimumZ = blockRoles.get(members[0].blockId) === "ice" ? 0 : 1;
  const candidates = [];
  const seen = new Set();
  const roleId = blockRoles.get(members[0].blockId);
  for (const origin of members) {
    for (const [dx, dy, dz] of growthDirections(configuration, roleId)) {
      const voxel = {
        x: origin.x + dx,
        y: origin.y + dy,
        z: origin.z + dz,
        blockId: origin.blockId,
      };
      const key = keyOf(voxel);
      if (seen.has(key) || !insideStaticVolume(voxel, configuration) ||
          voxel.z < minimumZ) continue;
      const occupant = rigidVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z, blockRoles, null, occupancy,
      );
      if (occupant && !(voxel.z === 0 && occupant.blockId === floorBlock.id)) continue;
      seen.add(key);
      candidates.push({ voxel, occupant });
    }
  }
  if (!candidates.length) return false;
  const { voxel, occupant } = choose(random, candidates);
  if (occupant) {
    occupancyRemove(occupancy, occupant);
    voxels.splice(voxels.indexOf(occupant), 1);
  }
  voxels.push(voxel);
  occupancyAdd(occupancy, voxel);
  members.push(voxel);
  return true;
}

function shrinkStaticCluster(
  voxels,
  members,
  random,
  floorBlock,
  configuration = null,
  blockRoles = null,
  occupancy = null,
) {
  if (members.length <= 1) return false;
  const removable = members.filter((member) => {
    const protectedPerimeterWall = configuration && blockRoles &&
      blockRoles.get(member.blockId) === "solid" && member.z === 1 &&
      (member.x === 0 || member.x === configuration.width - 1 ||
       member.y === 0 || member.y === configuration.depth - 1);
    return !protectedPerimeterWall && remainsConnectedWithout(members, member);
  });
  if (!removable.length) return false;
  const member = choose(random, removable);
  occupancyRemove(occupancy, member);
  voxels.splice(voxels.indexOf(member), 1);
  if (member.z === 0) {
    const floor = { x: member.x, y: member.y, z: 0, blockId: floorBlock.id };
    voxels.push(floor);
    occupancyAdd(occupancy, floor);
  }
  return true;
}

function seedWallTerrain(
  voxels,
  wallBlocks,
  configuration,
  random,
  blockRoles,
  occupancy = null,
) {
  if (!wallBlocks.length) return;
  const wall = choose(random, wallBlocks);
  const place = (x, y) => {
    if (!rigidVoxelAt(voxels, x, y, 1, blockRoles, null, occupancy)) {
      const voxel = { x, y, z: 1, blockId: wall.id };
      voxels.push(voxel);
      occupancyAdd(occupancy, voxel);
    }
  };
  // MazeBenchEngine3 classic rooms always begin with a closed perimeter.
  // It produces a legible playfield and prevents the evolutionary search
  // from spending generations rediscovering a useful boundary.
  for (let x = 0; x < configuration.width; x += 1) {
    place(x, 0);
    place(x, configuration.depth - 1);
  }
  for (let y = 1; y < configuration.depth - 1; y += 1) {
    place(0, y);
    place(configuration.width - 1, y);
  }

  const interiorArea = Math.max(
    1, (configuration.width - 2) * (configuration.depth - 2),
  );
  const density = Math.max(
    0.05, Math.min(0.9, (configuration.terrainDensity ?? 45) / 100),
  );
  // At the default density this matches MBE3's 0..10% initial interior-wall
  // range. The density control can deliberately make it sparser or denser.
  const maximumInternalWalls = Math.max(
    1, Math.floor(interiorArea * Math.min(0.3, density * 2 / 9)),
  );
  const target = integer(random, 0, maximumInternalWalls);
  for (let placed = 0, attempts = 0;
    placed < target && attempts < target * 20 + 20;
    attempts += 1) {
    const cell = {
      x: integer(random, 1, configuration.width - 2),
      y: integer(random, 1, configuration.depth - 2),
    };
    if (rigidVoxelAt(
      voxels, cell.x, cell.y, 1, blockRoles, null, occupancy,
    )) continue;
    const voxel = { ...cell, z: 1, blockId: wall.id };
    voxels.push(voxel);
    occupancyAdd(occupancy, voxel);
    placed += 1;
  }

  // Seed a few genuinely 3D columns whenever the selected volume permits it.
  // The amount stays sparse, but taller limits now provide visible vertical
  // terrain for evolution to extend instead of beginning as a flat wall mask.
  if (configuration.terrainMode !== "planar" && configuration.layers > 1) {
    const verticalTarget = integer(
      random,
      1,
      Math.max(1, Math.floor(maximumInternalWalls * Math.min(
        1, (configuration.layers - 1) / 4,
      ))),
    );
    const wallIds = new Set(wallBlocks.map((block) => block.id));
    for (let growth = 0; growth < verticalTarget; growth += 1) {
      if (!growWallUpward(
        voxels, wallIds, configuration, random, blockRoles, occupancy,
      )) break;
    }
  }
}

function growWallUpward(
  voxels,
  wallIds,
  configuration,
  random,
  blockRoles,
  occupancy = null,
) {
  if (configuration.terrainMode === "planar") return false;
  const candidates = voxels.filter((voxel) => wallIds.has(voxel.blockId) &&
    voxel.z >= 1 && voxel.z < configuration.layers &&
    !rigidVoxelAt(
      voxels, voxel.x, voxel.y, voxel.z + 1, blockRoles, null, occupancy,
    ));
  if (!candidates.length) return false;
  const highestZ = Math.max(...candidates.map((voxel) => voxel.z));
  // Usually continue an existing tall column, but sometimes begin another.
  // This lets a Row-20 volume actually explore Row 20 without making every
  // wall column equally tall.
  const pool = random() < 0.65
    ? candidates.filter((voxel) => voxel.z === highestZ)
    : candidates;
  const origin = choose(random, pool);
  const voxel = {
    x: origin.x,
    y: origin.y,
    z: origin.z + 1,
    blockId: origin.blockId,
  };
  voxels.push(voxel);
  occupancyAdd(occupancy, voxel);
  return true;
}

function mutateWallTerrain(
  voxels,
  wallBlocks,
  configuration,
  random,
  blockRoles,
  floorBlock,
  occupancy = null,
) {
  const wallIds = new Set(wallBlocks.map((block) => block.id));
  const operation = random();
  if (operation < 0.65) {
    // MBE3 treats walls as one terrain entity and toggles sparse interior
    // cells instead of growing every disconnected wall as its own blob.
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const cell = {
        x: integer(random, 1, configuration.width - 2),
        y: integer(random, 1, configuration.depth - 2),
      };
      const occupant = rigidVoxelAt(
        voxels, cell.x, cell.y, 1, blockRoles, null, occupancy,
      );
      if (occupant && wallIds.has(occupant.blockId)) {
        occupancyRemove(occupancy, occupant);
        voxels.splice(voxels.indexOf(occupant), 1);
        return true;
      }
      if (!occupant) {
        const voxel = {
          ...cell,
          z: 1,
          blockId: choose(random, wallBlocks).id,
        };
        voxels.push(voxel);
        occupancyAdd(occupancy, voxel);
        return true;
      }
    }
    return false;
  }

  if (operation < 0.9 && growWallUpward(
    voxels, wallIds, configuration, random, blockRoles, occupancy,
  )) return true;

  // The remaining share can still grow sideways/downward or shrink a
  // connected cluster, preserving full polycube editing rather than columns
  // being the only possible wall shape.
  const clusters = exactBlockClusters(voxels, wallIds);
  if (!clusters.length) return false;
  const members = choose(random, clusters);
  return random() < 0.5
    ? growStaticCluster(
      voxels, members, configuration, random, blockRoles, floorBlock, occupancy,
    )
    : shrinkStaticCluster(
      voxels,
      members,
      random,
      floorBlock,
      configuration,
      blockRoles,
      occupancy,
    );
}

function seedStaticCluster(
  voxels,
  block,
  configuration,
  random,
  blockRoles,
  floorBlock,
  seedZ,
  targetSize,
  occupancy = null,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const cell = randomCell(random, configuration.width, configuration.depth);
    const seed = { ...cell, z: seedZ, blockId: block.id };
    const occupant = rigidVoxelAt(
      voxels, seed.x, seed.y, seed.z, blockRoles, null, occupancy,
    );
    if (occupant && !(seed.z === 0 && occupant.blockId === floorBlock.id)) continue;
    if (ADJACENT_3D.some(([dx, dy, dz]) => voxels.some((voxel) =>
      voxel.blockId === block.id && voxel.x === seed.x + dx &&
      voxel.y === seed.y + dy && voxel.z === seed.z + dz))) continue;
    if (seedZ === 1 && !rigidVoxelAt(
      voxels, seed.x, seed.y, 0, blockRoles, null, occupancy,
    )) {
      const floor = { x: seed.x, y: seed.y, z: 0, blockId: floorBlock.id };
      voxels.push(floor);
      occupancyAdd(occupancy, floor);
    }
    if (occupant) {
      occupancyRemove(occupancy, occupant);
      voxels.splice(voxels.indexOf(occupant), 1);
    }
    voxels.push(seed);
    occupancyAdd(occupancy, seed);
    const members = [seed];
    for (let growth = members.length; growth < targetSize; growth += 1) {
      if (!growStaticCluster(
        voxels, members, configuration, random, blockRoles, floorBlock, occupancy,
      )) break;
    }
    return true;
  }
  return false;
}

function boxEntities(voxels, pushableBlocks) {
  const roles = new Map(pushableBlocks.map((block) => [block.id, block.roleId]));
  const entities = new Map();
  voxels.forEach((voxel, index) => {
    const role = roles.get(voxel.blockId);
    if (!role) return;
    const key = role === "weightless-pushable"
      ? `generic:${voxel.genericId ?? 0}`
      : `single:${index}`;
    const members = entities.get(key) ?? [];
    members.push(voxel);
    entities.set(key, members);
  });
  return [...entities.values()];
}

function growGenericBox(
  voxels,
  members,
  configuration,
  random,
  blockRoles,
  occupancy = null,
) {
  if (!members.length || blockRoles.get(members[0].blockId) !== "weightless-pushable") {
    return false;
  }
  const candidates = [];
  const seen = new Set();
  for (const origin of members) {
    for (const [dx, dy, dz] of growthDirections(
      configuration, blockRoles.get(origin.blockId),
    )) {
      const voxel = {
        x: origin.x + dx,
        y: origin.y + dy,
        z: origin.z + dz,
        blockId: origin.blockId,
        genericId: origin.genericId ?? 0,
      };
      const key = keyOf(voxel);
      if (seen.has(key) || !insideVolume(voxel, configuration) || rigidVoxelAt(
        voxels, voxel.x, voxel.y, voxel.z, blockRoles, null, occupancy,
      )) continue;
      seen.add(key);
      candidates.push(voxel);
    }
  }
  if (!candidates.length) return false;
  const voxel = choose(random, candidates);
  voxels.push(voxel);
  occupancyAdd(occupancy, voxel);
  members.push(voxel);
  return true;
}

function shrinkGenericBox(voxels, members, random, occupancy = null) {
  // MBE3's generated piece library begins at dominoes. Search-created
  // weightless pieces therefore keep at least two cubes, even though their
  // upper size remains uncapped.
  if (members.length <= 2) return false;
  const removable = members.filter((member) => remainsConnectedWithout(members, member));
  if (!removable.length) return false;
  const member = choose(random, removable);
  occupancyRemove(occupancy, member);
  voxels.splice(voxels.indexOf(member), 1);
  return true;
}

function translateBox(
  voxels, members, configuration, random, blockRoles, occupancy = null,
) {
  const memberSet = new Set(members);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const [dx, dy, dz] = choose(
      random,
      growthDirections(configuration, blockRoles.get(members[0].blockId)),
    );
    const translated = members.map((member) => ({
      ...member,
      x: member.x + dx,
      y: member.y + dy,
      z: member.z + dz,
    }));
    if (translated.some((voxel) => !insideVolume(voxel, configuration) ||
        rigidVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z, blockRoles, memberSet, occupancy,
        ))) {
      continue;
    }
    const hasDirectSupport = translated.some((voxel) => rigidVoxelAt(
      voxels, voxel.x, voxel.y, voxel.z - 1, blockRoles, memberSet, occupancy,
    ));
    if (!hasDirectSupport) continue;
    members.forEach((member) => occupancyRemove(occupancy, member));
    members.forEach((member, index) => Object.assign(member, translated[index]));
    members.forEach((member) => occupancyAdd(occupancy, member));
    return true;
  }
  return false;
}

function relocateBox(
  voxels, members, configuration, random, blockRoles, occupancy = null,
) {
  if (!members.length) return false;
  const memberSet = new Set(members);
  const origin = members[0];
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const target = randomCell(random, configuration.width, configuration.depth);
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    if (dx === 0 && dy === 0) continue;
    const translated = members.map((member) => ({
      ...member,
      x: member.x + dx,
      y: member.y + dy,
    }));
    if (translated.some((voxel) => !insideVolume(voxel, configuration) ||
        rigidVoxelAt(
          voxels, voxel.x, voxel.y, voxel.z, blockRoles, memberSet, occupancy,
        ))) {
      continue;
    }
    const hasDirectSupport = translated.some((voxel) => rigidVoxelAt(
      voxels, voxel.x, voxel.y, voxel.z - 1, blockRoles, memberSet, occupancy,
    ));
    if (!hasDirectSupport) continue;
    members.forEach((member) => occupancyRemove(occupancy, member));
    members.forEach((member, index) => Object.assign(member, translated[index]));
    members.forEach((member) => occupancyAdd(occupancy, member));
    return true;
  }
  return false;
}

function reshapeGenericBox(
  voxels,
  members,
  configuration,
  random,
  blockRoles,
  occupancy = null,
) {
  if (!members.length || blockRoles.get(members[0].blockId) !== "weightless-pushable") {
    return false;
  }
  const originalMembers = [...members];
  const block = { id: members[0].blockId, roleId: "weightless-pushable" };
  const genericId = members[0].genericId ?? 0;
  for (const member of originalMembers) {
    occupancyRemove(occupancy, member);
    voxels.splice(voxels.indexOf(member), 1);
  }
  const replacement = placeSupportedBox(
    voxels,
    block,
    genericId,
    integer(random, 2, 5),
    configuration,
    random,
    blockRoles,
    occupancy,
  );
  if (replacement.length) return true;
  voxels.push(...originalMembers);
  originalMembers.forEach((member) => occupancyAdd(occupancy, member));
  return false;
}

function dynamicsAreSettled(voxels, configuration, blockRoles, pushableBlocks) {
  const rigidCoordinates = new Set();
  for (const voxel of voxels) {
    if (isCollectible(voxel, blockRoles)) continue;
    const key = keyOf(voxel);
    if (rigidCoordinates.has(key)) return false;
    rigidCoordinates.add(key);
  }
  const player = voxels.find((voxel) => blockRoles.get(voxel.blockId) === "player");
  if (!player || !insideVolume(player, configuration) || !rigidVoxelAt(
    voxels, player.x, player.y, player.z - 1, blockRoles, player,
  )) return false;
  return boxEntities(voxels, pushableBlocks).every((members) => {
    const memberSet = new Set(members);
    return members.length > 0 && members.every((member) => insideVolume(member, configuration)) &&
      members.some((member) => rigidVoxelAt(
        voxels, member.x, member.y, member.z - 1, blockRoles, memberSet,
      ));
  });
}

function placeSupportedBox(
  voxels,
  block,
  genericId,
  targetSize,
  configuration,
  random,
  blockRoles,
  occupancy = null,
) {
  const anchors = [];
  for (let y = 0; y < configuration.depth; y += 1) {
    for (let x = 0; x < configuration.width; x += 1) {
      // Every generated box begins on the playable Row-1 surface. Its
      // polycube may grow upward without limit, but the object itself remains
      // reachable instead of being stranded on top of a random wall tower.
      if (rigidVoxelAt(voxels, x, y, 0, blockRoles, null, occupancy) &&
          !rigidVoxelAt(voxels, x, y, 1, blockRoles, null, occupancy)) {
        anchors.push({ x, y, z: 1 });
      }
    }
  }
  while (anchors.length) {
    const anchorIndex = integer(random, 0, anchors.length - 1);
    const [anchor] = anchors.splice(anchorIndex, 1);
    const voxel = {
      ...anchor,
      blockId: block.id,
      ...(block.roleId === "weightless-pushable" ? { genericId } : {}),
    };
    voxels.push(voxel);
    occupancyAdd(occupancy, voxel);
    const members = [voxel];
    for (let extra = 1; extra < targetSize; extra += 1) {
      if (!growGenericBox(
        voxels, members, configuration, random, blockRoles, occupancy,
      )) break;
    }
    if (members.length === targetSize) return members;
    for (const member of members) {
      occupancyRemove(occupancy, member);
      voxels.splice(voxels.indexOf(member), 1);
    }
  }
  return [];
}

function initialStaticClusterSize(random, configuration, clusterCount, familyCount) {
  const interiorArea = Math.max(1, configuration.width * configuration.depth);
  const density = Math.max(0.05, Math.min(0.9, (configuration.terrainDensity ?? 45) / 100));
  const verticalFactor = 1 + Math.min(configuration.layers, 8) * 0.1;
  const familyBudget = interiorArea * density * verticalFactor / Math.max(1, familyCount);
  const average = Math.max(2, Math.floor(familyBudget / clusterCount));
  return integer(random, Math.max(1, Math.floor(average * 0.65)),
    Math.max(2, Math.floor(average * 1.35)));
}

function seedPlanarIce(
  voxels,
  configuration,
  random,
  blockRoles,
  floorBlock,
  iceBlocks,
  occupancy,
) {
  if (!iceBlocks.length || floorBlock.roleId === "ice") return;
  const interiorArea = Math.max(
    1, (configuration.width - 2) * (configuration.depth - 2),
  );
  const maximum = Math.max(
    0,
    Math.min(
      Math.floor(interiorArea / 4),
      configuration.initialIceMax ?? 18,
    ),
  );
  const target = integer(random, 0, maximum);
  if (!target) return;
  const block = choose(random, iceBlocks);
  let cell = {
    x: integer(random, 1, Math.max(1, configuration.width - 2)),
    y: integer(random, 1, Math.max(1, configuration.depth - 2)),
  };
  for (let placed = 0, attempts = 0;
    placed < target && attempts < target * 30 + 30;
    attempts += 1) {
    const existing = occupancy.get(`${cell.x},${cell.y},0`)?.find((voxel) =>
      voxel.blockId === floorBlock.id || iceBlocks.some((ice) => ice.id === voxel.blockId));
    const hasStructureAbove = occupancy.get(`${cell.x},${cell.y},1`)?.some((voxel) =>
      !isCollectible(voxel, blockRoles));
    if (existing && !hasStructureAbove) {
      occupancyRemove(occupancy, existing);
      voxels.splice(voxels.indexOf(existing), 1);
      const ice = { x: cell.x, y: cell.y, z: 0, blockId: block.id };
      voxels.push(ice);
      occupancyAdd(occupancy, ice);
      placed += 1;
    }
    if (random() < 0.05) {
      cell = {
        x: integer(random, 1, Math.max(1, configuration.width - 2)),
        y: integer(random, 1, Math.max(1, configuration.depth - 2)),
      };
    } else {
      const [dx, dy] = choose(random, ADJACENT_3D.slice(0, 4));
      cell = {
        x: Math.max(1, Math.min(configuration.width - 2, cell.x + dx)),
        y: Math.max(1, Math.min(configuration.depth - 2, cell.y + dy)),
      };
    }
  }
}

function carveInitialHoles(
  voxels,
  configuration,
  random,
  blockRoles,
  floorBlock,
  iceBlocks,
  occupancy = null,
) {
  const area = Math.max(1, configuration.width * configuration.depth);
  const maximum = Math.max(
    0,
    configuration.initialHoleMax ?? Math.max(1, Math.floor(area * 0.1)),
  );
  const targetHoles = integer(random, 0, maximum);
  if (!targetHoles) return;
  const clusterCount = configuration.terrainMode === "planar"
    ? integer(random, 1, Math.min(2, targetHoles))
    : integer(random, 1, Math.max(1, Math.floor(area / 48) + 1));
  const rowZeroTerrain = new Set([floorBlock.id, ...iceBlocks.map((block) => block.id)]);
  let carved = 0;
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    let cell = randomCell(random, configuration.width, configuration.depth);
    const remainingClusters = clusterCount - cluster;
    const length = Math.max(1, Math.ceil((targetHoles - carved) / remainingClusters));
    for (let step = 0; step < length && carved < targetHoles; step += 1) {
      const occupant = occupancy?.get(`${cell.x},${cell.y},0`)?.[0] ??
        voxels.find((voxel) => voxel.x === cell.x && voxel.y === cell.y && voxel.z === 0);
      const hasStructureAbove = voxels.some((voxel) =>
        voxel.x === cell.x && voxel.y === cell.y && voxel.z > 0 &&
        !isCollectible(voxel, blockRoles));
      if (occupant && rowZeroTerrain.has(occupant.blockId) && !hasStructureAbove) {
        removeAt(voxels, cell.x, cell.y, 0, occupancy);
        carved += 1;
      }
      const [dx, dy] = choose(random, ADJACENT_3D.slice(0, 4));
      cell = {
        x: Math.max(0, Math.min(configuration.width - 1, cell.x + dx)),
        y: Math.max(0, Math.min(configuration.depth - 1, cell.y + dy)),
      };
    }
  }
  if (!carved) {
    const candidates = voxels.filter((voxel) => voxel.z === 0 &&
      rowZeroTerrain.has(voxel.blockId) && !voxels.some((other) =>
        other.x === voxel.x && other.y === voxel.y && other.z > 0 &&
        !isCollectible(other, blockRoles)));
    if (candidates.length) {
      const fallback = choose(random, candidates);
      removeAt(voxels, fallback.x, fallback.y, 0, occupancy);
    }
  }
}

function walkableSurfaceCells(
  voxels,
  configuration,
  blockRoles,
  ignored = null,
  ignoreMovingBodies = false,
) {
  const cells = [];
  const byKey = new Map();
  const ignoredVoxels = ignored instanceof Set
    ? ignored
    : ignored
      ? new Set([ignored])
      : null;
  const rigidKeys = new Set();
  for (const voxel of voxels) {
    const role = blockRoles.get(voxel.blockId);
    if (ignoredVoxels?.has(voxel) || isCollectible(voxel, blockRoles) ||
        (ignoreMovingBodies && ["player", "pushable", "weightless-pushable"].includes(role))) {
      continue;
    }
    rigidKeys.add(keyOf(voxel));
  }
  // Candidate surfaces exist only one voxel above rigid geometry. Enumerating
  // those supports scales with authored voxels instead of width × depth ×
  // vertical range, so tall sparse searches do not pay for empty space.
  for (const support of voxels) {
    const role = blockRoles.get(support.blockId);
    if (ignoredVoxels?.has(support) || isCollectible(support, blockRoles) ||
        (ignoreMovingBodies && ["player", "pushable", "weightless-pushable"].includes(role))) {
      continue;
    }
    const cell = { x: support.x, y: support.y, z: support.z + 1 };
    const key = keyOf(cell);
    if (cell.z < 1 || cell.z > configuration.layers || byKey.has(key) ||
        rigidKeys.has(key)) continue;
    cells.push(cell);
    byKey.set(key, cell);
  }
  const components = [];
  const visited = new Set();
  for (const seed of cells) {
    const seedKey = keyOf(seed);
    if (visited.has(seedKey)) continue;
    const component = [];
    const queue = [seed];
    visited.add(seedKey);
    while (queue.length) {
      const cell = queue.pop();
      component.push(cell);
      for (const [dx, dy] of ADJACENT_3D.slice(0, 4)) {
        const neighborKey = `${cell.x + dx},${cell.y + dy},${cell.z}`;
        const neighbor = byKey.get(neighborKey);
        if (neighbor && !visited.has(neighborKey)) {
          visited.add(neighborKey);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function surfaceDistances(component, start) {
  const byKey = new Map(component.map((cell) => [keyOf(cell), cell]));
  const distance = new Map([[keyOf(start), 0]]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    const nextDistance = distance.get(keyOf(cell)) + 1;
    for (const [dx, dy] of ADJACENT_3D.slice(0, 4)) {
      const neighborKey = `${cell.x + dx},${cell.y + dy},${cell.z}`;
      const neighbor = byKey.get(neighborKey);
      if (neighbor && !distance.has(neighborKey)) {
        distance.set(neighborKey, nextDistance);
        queue.push(neighbor);
      }
    }
  }
  return distance;
}

function placeReachableObjectives(
  voxels,
  configuration,
  random,
  blockRoles,
  playerBlock,
  goalBlocks,
) {
  const goalCount = Math.max(1, configuration.collectibles ?? 1);
  // Connectivity is checked through immutable terrain. Boxes may obstruct the
  // route and create the puzzle; requiring a box-free route made every fresh
  // seed trivially solvable without a push.
  const occupiedByMovingBody = new Set(voxels.filter((voxel) =>
    ["player", "pushable", "weightless-pushable"].includes(
      blockRoles.get(voxel.blockId),
    )).map(keyOf));
  const components = walkableSurfaceCells(
    voxels, configuration, blockRoles, null, true,
  )
    .map((component) => component.filter((cell) => !occupiedByMovingBody.has(keyOf(cell))))
    .filter((component) => component.length > goalCount)
    .sort((left, right) => right.length - left.length);
  if (!components.length) return false;
  const candidates = components.slice(0, Math.min(3, components.length));
  const component = choose(random, candidates);
  const first = choose(random, component);
  const firstDistances = surfaceDistances(component, first);
  const playerCell = component.reduce((best, cell) =>
    firstDistances.get(keyOf(cell)) > firstDistances.get(keyOf(best)) ? cell : best, first);
  const playerDistances = surfaceDistances(component, playerCell);
  const goalCells = [...component]
    .filter((cell) => keyOf(cell) !== keyOf(playerCell))
    .sort((left, right) =>
      playerDistances.get(keyOf(right)) - playerDistances.get(keyOf(left)));
  voxels.push({ ...playerCell, blockId: playerBlock.id });
  for (let index = 0; index < goalCount; index += 1) {
    const selectionBand = goalCells.slice(
      Math.min(index, goalCells.length - 1),
      Math.min(goalCells.length, Math.max(index + 1, Math.ceil(goalCells.length / 3))),
    );
    const goalCell = choose(random, selectionBand);
    goalCells.splice(goalCells.indexOf(goalCell), 1);
    voxels.push({ ...goalCell, blockId: choose(random, goalBlocks).id });
  }
  return true;
}

function relocateObjectives(
  voxels,
  configuration,
  random,
  blockRoles,
  playerBlock,
  goalBlocks,
) {
  const originals = voxels.filter((voxel) => {
    const role = blockRoles.get(voxel.blockId);
    return role === "player" || role === "goal";
  });
  if (!originals.length || !playerBlock || !goalBlocks.length) return false;
  const originalSignature = originals.map((voxel) =>
    `${voxel.blockId}:${keyOf(voxel)}`).sort().join("|");
  for (const voxel of originals) voxels.splice(voxels.indexOf(voxel), 1);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (placeReachableObjectives(
      voxels,
      configuration,
      random,
      blockRoles,
      playerBlock,
      goalBlocks,
    )) {
      const replacements = voxels.filter((voxel) => {
        const role = blockRoles.get(voxel.blockId);
        return role === "player" || role === "goal";
      });
      const replacementSignature = replacements.map((voxel) =>
        `${voxel.blockId}:${keyOf(voxel)}`).sort().join("|");
      if (replacementSignature !== originalSignature) return true;
      for (const voxel of replacements) voxels.splice(voxels.indexOf(voxel), 1);
    }
  }
  voxels.push(...originals);
  return false;
}

function objectivesShareStaticSurface(voxels, configuration, blockRoles) {
  const player = voxels.find((voxel) => blockRoles.get(voxel.blockId) === "player");
  const goals = voxels.filter((voxel) => blockRoles.get(voxel.blockId) === "goal");
  if (!player || !goals.length) return false;
  const required = new Set([keyOf(player), ...goals.map(keyOf)]);
  return walkableSurfaceCells(voxels, configuration, blockRoles, null, true)
    .some((component) => {
      const keys = new Set(component.map(keyOf));
      return [...required].every((key) => keys.has(key));
    });
}

function planarTerrainWithinLimits(voxels, configuration, blockRoles, iceBlocks) {
  if (configuration.terrainMode !== "planar") return true;
  const interior = Math.max(
    1, (configuration.width - 2) * (configuration.depth - 2),
  );
  const iceIds = new Set(iceBlocks.map((block) => block.id));
  const ice = voxels.filter((voxel) => iceIds.has(voxel.blockId));
  if (ice.some((voxel) => voxel.z !== 0) ||
      ice.length > Math.max(1, Math.floor(interior / 4)) ||
      exactBlockClusters(voxels, iceIds).length > 3) {
    return false;
  }
  const rowZeroTerrain = voxels.filter((voxel) => voxel.z === 0 &&
    ["floor", "ice"].includes(blockRoles.get(voxel.blockId))).length;
  const holes = configuration.width * configuration.depth - rowZeroTerrain;
  return holes <= Math.max(1, Math.floor(interior / 10));
}

function reverseWalkCandidate(
  candidate,
  configuration,
  player,
  dx,
  dy,
  blockRoles,
) {
  const x = player.x - dx;
  const y = player.y - dy;
  if (x < 0 || x >= configuration.width ||
      y < 0 || y >= configuration.depth ||
      rigidVoxelAt(candidate.voxels, x, y, player.z, blockRoles, player) ||
      !rigidVoxelAt(candidate.voxels, x, y, player.z - 1, blockRoles, player)) {
    return false;
  }
  Object.assign(player, { x, y });
  return true;
}

function reversePullCandidate(
  candidate,
  configuration,
  player,
  dx,
  dy,
  blockRoles,
  pushableBlocks,
) {
  const back = { x: player.x - dx, y: player.y - dy, z: player.z };
  const front = { x: player.x + dx, y: player.y + dy, z: player.z };
  if (back.x < 0 || back.x >= configuration.width ||
      back.y < 0 || back.y >= configuration.depth ||
      rigidVoxelAt(candidate.voxels, back.x, back.y, back.z, blockRoles, player) ||
      !rigidVoxelAt(candidate.voxels, back.x, back.y, back.z - 1, blockRoles, player)) {
    return false;
  }
  const entities = boxEntities(candidate.voxels, pushableBlocks);
  const first = entities.findIndex((members) => members.some((member) =>
    member.x === front.x && member.y === front.y && member.z === front.z));
  if (first < 0) return false;

  const moving = new Set([first]);
  if (blockRoles.get(entities[first][0].blockId) === "weightless-pushable") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entityIndex of [...moving]) {
        for (const member of entities[entityIndex]) {
          const forwardKey = `${member.x + dx},${member.y + dy},${member.z}`;
          for (let other = 0; other < entities.length; other += 1) {
            if (!moving.has(other) && entities[other].some((voxel) =>
              keyOf(voxel) === forwardKey)) {
              moving.add(other);
              changed = true;
            }
          }
        }
      }
    }
  }
  const movingMembers = [...moving].flatMap((index) => entities[index]);
  const ignored = new Set([player, ...movingMembers]);
  const translated = movingMembers.map((member) => ({
    member,
    x: member.x - dx,
    y: member.y - dy,
    z: member.z,
  }));
  if (translated.some((voxel) =>
    voxel.x < 0 || voxel.x >= configuration.width ||
    voxel.y < 0 || voxel.y >= configuration.depth ||
    rigidVoxelAt(candidate.voxels, voxel.x, voxel.y, voxel.z, blockRoles, ignored))) {
    return false;
  }
  for (const entityIndex of moving) {
    const entitySet = new Set(entities[entityIndex]);
    const supported = entities[entityIndex].some((member) =>
      rigidVoxelAt(
        candidate.voxels,
        member.x - dx,
        member.y - dy,
        member.z - 1,
        blockRoles,
        new Set([...entitySet, player]),
      ));
    if (!supported) return false;
  }
  for (const voxel of translated) {
    Object.assign(voxel.member, { x: voxel.x, y: voxel.y });
  }
  Object.assign(player, back);
  return true;
}

function dynamicCandidateSignature(candidate, blockRoles) {
  return candidate.voxels.filter((voxel) => {
    const role = blockRoles.get(voxel.blockId);
    return role === "player" || role === "pushable" || role === "weightless-pushable";
  }).map((voxel) =>
    `${voxel.blockId}:${voxel.genericId ?? -1}:${voxel.x},${voxel.y},${voxel.z}`)
    .sort().join("|");
}

function reverseScrambleCandidate(candidate, configuration, random) {
  const blockRoles = new Map(configuration.blocks.map((block) => [block.id, block.roleId]));
  const goals = candidate.voxels.filter((voxel) => isCollectible(voxel, blockRoles));
  const player = candidate.voxels.find((voxel) => blockRoles.get(voxel.blockId) === "player");
  const pushableBlocks = configuration.blocks.filter((block) =>
    block.roleId === "pushable" || block.roleId === "weightless-pushable");
  if (!player || goals.length !== 1 || !pushableBlocks.length ||
      candidate.voxels.some((voxel) => blockRoles.get(voxel.blockId) === "ice")) {
    return 0;
  }
  Object.assign(goals[0], { x: player.x, y: player.y, z: player.z });
  const visited = new Set([dynamicCandidateSignature(candidate, blockRoles)]);
  const targetMoves = Math.max(1, configuration.targetMoves ?? 500);
  const steps = Math.max(120, Math.min(1200, targetMoves * 3));
  const movingVoxels = candidate.voxels.filter((voxel) => {
    const role = blockRoles.get(voxel.blockId);
    return role === "player" || role === "pushable" || role === "weightless-pushable";
  });
  const captureCoordinates = () => movingVoxels.map((voxel) => [
    voxel.x, voxel.y, voxel.z,
  ]);
  const restoreCoordinates = (coordinates) => movingVoxels.forEach(
    (voxel, index) => {
      [voxel.x, voxel.y, voxel.z] = coordinates[index];
    },
  );
  let pulls = 0;
  for (let step = 0; step < steps; step += 1) {
    const choices = [];
    const sourceCoordinates = captureCoordinates();
    for (const [dx, dy] of ADJACENT_3D.slice(0, 4)) {
      if (reversePullCandidate(
        candidate,
        configuration,
        player,
        dx,
        dy,
        blockRoles,
        pushableBlocks,
      )) {
        const signature = dynamicCandidateSignature(candidate, blockRoles);
        if (!visited.has(signature)) {
          choices.push({ coordinates: captureCoordinates(), pull: true, signature });
        }
      }
      restoreCoordinates(sourceCoordinates);
      if (reverseWalkCandidate(
        candidate, configuration, player, dx, dy, blockRoles,
      )) {
        const signature = dynamicCandidateSignature(candidate, blockRoles);
        if (!visited.has(signature)) {
          choices.push({ coordinates: captureCoordinates(), pull: false, signature });
        }
      }
      restoreCoordinates(sourceCoordinates);
    }
    if (!choices.length) break;
    const totalWeight = choices.reduce((sum, choice) => sum + (choice.pull ? 5 : 1), 0);
    let selectedWeight = integer(random, 1, totalWeight);
    let selected = choices[0];
    for (const choice of choices) {
      selectedWeight -= choice.pull ? 5 : 1;
      if (selectedWeight <= 0) {
        selected = choice;
        break;
      }
    }
    restoreCoordinates(selected.coordinates);
    visited.add(selected.signature);
    if (selected.pull) pulls += 1;
  }
  return pulls;
}

function addDeferredTerrain(candidate, configuration, random) {
  const byRole = roleBlocks(configuration);
  const iceBlocks = byRole.get("ice") ?? [];
  const floor = firstRoleBlock(byRole, "floor");
  const startingSurface = floor ?? iceBlocks[0];
  const blockRoles = new Map(configuration.blocks.map((block) => [block.id, block.roleId]));
  const occupancy = makeOccupancy(candidate.voxels);
  if (configuration.terrainMode === "planar") {
    seedPlanarIce(
      candidate.voxels,
      configuration,
      random,
      blockRoles,
      startingSurface,
      iceBlocks,
      occupancy,
    );
  } else {
    const staticClusterMaximum = Math.max(
      2,
      Math.min(8, Math.floor((configuration.width * configuration.depth) / 12)),
    );
    for (const ice of iceBlocks) {
      const clusterCount = integer(random, 2, staticClusterMaximum);
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        seedStaticCluster(
          candidate.voxels,
          ice,
          configuration,
          random,
          blockRoles,
          startingSurface,
          0,
          initialStaticClusterSize(
            random, configuration, clusterCount, Math.max(1, iceBlocks.length),
          ),
          occupancy,
        );
      }
    }
  }
  if (configuration.evolveHoles) {
    carveInitialHoles(
      candidate.voxels,
      configuration,
      random,
      blockRoles,
      startingSurface,
      iceBlocks,
      occupancy,
    );
  }
  const pushableBlocks = configuration.blocks.filter((block) =>
    block.roleId === "pushable" || block.roleId === "weightless-pushable");
  return planarTerrainWithinLimits(
    candidate.voxels, configuration, blockRoles, iceBlocks,
  ) && objectivesShareStaticSurface(
    candidate.voxels, configuration, blockRoles,
  ) && dynamicsAreSettled(
    candidate.voxels, configuration, blockRoles, pushableBlocks,
  );
}

function makeCandidateAttempt(configuration, random, deferTerrain = false) {
  const { width, depth, layers } = configuration;
  const byRole = roleBlocks(configuration);
  validateRequiredBlocks(byRole);
  const player = firstRoleBlock(byRole, "player");
  const goals = byRole.get("goal") ?? [];
  const iceBlocks = byRole.get("ice") ?? [];
  const floor = firstRoleBlock(byRole, "floor");
  const startingSurface = floor ?? iceBlocks[0];
  const wallBlocks = byRole.get("solid") ?? [];
  const normalPushables = byRole.get("pushable") ?? [];
  const weightlessPushables = byRole.get("weightless-pushable") ?? [];
  const structural = configuration.blocks.filter((block) =>
    configuration.enabledBlockIds.includes(block.id) &&
    !["floor", "player", "goal", "ice", "solid", "pushable", "weightless-pushable"]
      .includes(block.roleId));
  const voxels = [];
  const blockRoles = new Map(configuration.blocks.map((block) => [block.id, block.roleId]));

  for (let y = 0; y < depth; y += 1) {
    for (let x = 0; x < width; x += 1) {
      voxels.push({ x, y, z: 0, blockId: startingSurface.id });
    }
  }
  const occupancy = makeOccupancy(voxels);

  seedWallTerrain(
    voxels, wallBlocks, configuration, random, blockRoles, occupancy,
  );

  const staticClusterMaximum = Math.max(
    2, Math.min(8, Math.floor((width * depth) / 12)),
  );
  const staticFamilyCount = Math.max(1, iceBlocks.length + structural.length);
  if (!deferTerrain && configuration.terrainMode === "planar") {
    seedPlanarIce(
      voxels,
      configuration,
      random,
      blockRoles,
      startingSurface,
      iceBlocks,
      occupancy,
    );
  } else if (!deferTerrain) {
    for (const ice of iceBlocks) {
      const clusterCount = integer(random, 2, staticClusterMaximum);
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        seedStaticCluster(
          voxels,
          ice,
          configuration,
          random,
          blockRoles,
          startingSurface,
          0,
          initialStaticClusterSize(
            random, configuration, clusterCount, staticFamilyCount,
          ),
          occupancy,
        );
      }
    }
  }

  for (const block of structural) {
    const clusterCount = integer(random, 2, staticClusterMaximum);
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      seedStaticCluster(
        voxels,
        block,
        configuration,
        random,
        blockRoles,
        startingSurface,
        1,
        initialStaticClusterSize(
          random, configuration, clusterCount, staticFamilyCount,
        ),
        occupancy,
      );
    }
  }

  if (!deferTerrain && configuration.evolveHoles) {
    carveInitialHoles(
      voxels,
      configuration,
      random,
      blockRoles,
      startingSurface,
      iceBlocks,
      occupancy,
    );
  }

  if (weightlessPushables.length) {
    const minimumBoxes = Math.max(0, configuration.minWeightlessBoxes ?? 1);
    const maximumBoxes = Math.max(minimumBoxes, configuration.maxWeightlessBoxes ?? 4);
    const boxCount = integer(random, minimumBoxes, maximumBoxes);
    for (let genericId = 0; genericId < boxCount; genericId += 1) {
      const placed = placeSupportedBox(
        voxels,
        choose(random, weightlessPushables),
        genericId,
        // MBE3 seeds compact domino-through-pentomino pieces. This is only a
        // clean starting distribution; grow mutations remain uncapped.
        integer(random, 2, 5),
        configuration,
        random,
        blockRoles,
        occupancy,
      );
      if (!placed.length) {
        return null;
      }
    }
  }

  if (normalPushables.length) {
    const boxCount = integer(
      random, 0, Math.min(4, Math.max(1, Math.floor(width * depth / 20))),
    );
    for (let index = 0; index < boxCount; index += 1) {
      placeSupportedBox(
        voxels,
        choose(random, normalPushables),
        -1,
        1,
        configuration,
        random,
        blockRoles,
        occupancy,
      );
    }
  }

  if (!placeReachableObjectives(
    voxels, configuration, random, blockRoles, player, goals,
  )) return null;
  if (!planarTerrainWithinLimits(
    voxels, configuration, blockRoles, iceBlocks,
  ) || !objectivesShareStaticSurface(voxels, configuration, blockRoles)) {
    return null;
  }

  return {
    id: `candidate-${Date.now()}-${integer(random, 0, 0xFFFFFF).toString(16)}`,
    name: "Evolution candidate",
    createdAt: new Date().toISOString(),
    world: { width, height: depth, floorLayer: 0 },
    layers,
    voxels,
    solution: [],
    moves: 0,
    expanded: 0,
    generated: 0,
    commandTransitions: 0,
    commandTransitionsPerSecond: 0,
    nodesPerSecond: 0,
    optimal: false,
    seed: configuration.seed,
  };
}

function makeCandidate(configuration, random) {
  const canReverseScramble = Boolean(firstRoleBlock(roleBlocks(configuration), "floor"));
  for (let restart = 0; restart < 80; restart += 1) {
    const wantsScramble = canReverseScramble && random() < Math.max(
      0, Math.min(1, (configuration.reverseScramblePercent ?? 34) / 100),
    );
    const candidate = makeCandidateAttempt(configuration, random, wantsScramble);
    if (candidate) {
      if (wantsScramble) {
        const pulls = reverseScrambleCandidate(candidate, configuration, random);
        if (pulls < Math.max(1, configuration.minimumScramblePulls ?? 1)) {
          continue;
        }
        candidate.scramblePulls = pulls;
        if (!addDeferredTerrain(candidate, configuration, random)) continue;
      }
      return candidate;
    }
  }
  throw new Error(
    "Could not construct a connected playable candidate. Reduce terrain density or object count.",
  );
}

function mutateCandidate(candidate, configuration, random) {
  const next = cloneCandidate(candidate);
  next.solution = [];
  next.optimal = false;
  const byRole = roleBlocks(configuration);
  const floorBlock = firstRoleBlock(byRole, "floor");
  const iceBlocks = byRole.get("ice") ?? [];
  const startingSurface = floorBlock ?? iceBlocks[0];
  const playerBlock = firstRoleBlock(byRole, "player");
  const goalBlocks = byRole.get("goal") ?? [];
  const wallBlocks = byRole.get("solid") ?? [];
  const weightlessPushableBlocks = byRole.get("weightless-pushable") ?? [];
  const pushableBlocks = [
    ...(byRole.get("pushable") ?? []),
    ...(byRole.get("weightless-pushable") ?? []),
  ];
  const structural = configuration.blocks.filter((block) =>
    configuration.enabledBlockIds.includes(block.id) &&
    !["floor", "player", "goal", "ice", "solid", "pushable", "weightless-pushable"]
      .includes(block.roleId));
  const blockRoles = new Map(configuration.blocks.map((block) => [block.id, block.roleId]));
  const occupancy = makeOccupancy(next.voxels);
  const iceClusters = exactBlockClusters(
    next.voxels, new Set(iceBlocks.map((block) => block.id)),
  );
  const structureClusters = exactBlockClusters(
    next.voxels, new Set(structural.map((block) => block.id)),
  );
  const weightlessBoxes = boxEntities(next.voxels, weightlessPushableBlocks);
  const minimumWeightlessBoxes = Math.max(0, configuration.minWeightlessBoxes ?? 1);
  const maximumWeightlessBoxes = Math.max(
    minimumWeightlessBoxes, configuration.maxWeightlessBoxes ?? 4,
  );
  // One terrain family receives one lottery slot, regardless of how many
  // disconnected clusters it contains. This preserves equal opportunity with
  // each individual box instead of fragmented Ice dominating mutation.
  const entities = [
    ...(wallBlocks.length ? [{ kind: "walls" }] : []),
    ...structureClusters.map((members) => ({ kind: "static", members })),
    ...(iceClusters.length ? [{ kind: "ice-family", clusters: iceClusters }] : []),
    ...(weightlessPushableBlocks.length &&
        (weightlessBoxes.length !== minimumWeightlessBoxes ||
         weightlessBoxes.length !== maximumWeightlessBoxes)
      ? [{ kind: "weightless-population" }]
      : []),
    ...(configuration.evolveHoles ? [{ kind: "holes" }] : []),
    ...boxEntities(next.voxels, pushableBlocks).map((members) => ({ kind: "box", members })),
  ];
  const mutateEndpoints = random() < Math.max(
    0, Math.min(1, (configuration.endpointMutationPercent ?? 0) / 100),
  );
  const entity = mutateEndpoints
    ? { kind: "endpoints" }
    : choose(random, entities);

  for (let attempt = 0; attempt < 18; attempt += 1) {
    if (entity.kind === "endpoints") {
      if (relocateObjectives(
        next.voxels,
        configuration,
        random,
        blockRoles,
        playerBlock,
        goalBlocks,
      )) break;
    } else if (entity.kind === "walls") {
      if (mutateWallTerrain(
        next.voxels,
        wallBlocks,
        configuration,
        random,
        blockRoles,
        startingSurface,
        occupancy,
      )) break;
    } else if (entity.kind === "static" || entity.kind === "ice-family") {
      const members = entity.kind === "ice-family"
        ? choose(random, entity.clusters)
        : entity.members;
      const changed = random() < 0.5
        ? growStaticCluster(
          next.voxels,
          members,
          configuration,
          random,
          blockRoles,
          startingSurface,
          occupancy,
        )
        : shrinkStaticCluster(
          next.voxels,
          members,
          random,
          startingSurface,
          configuration,
          blockRoles,
          occupancy,
        );
      if (changed) break;
    } else if (entity.kind === "holes") {
      const cell = randomCell(random, configuration.width, configuration.depth);
      const existing = next.voxels.find((voxel) =>
        voxel.x === cell.x && voxel.y === cell.y && voxel.z === 0);
      const hasStructureAbove = next.voxels.some((voxel) =>
        voxel.x === cell.x && voxel.y === cell.y && voxel.z > 0 &&
        !isCollectible(voxel, blockRoles));
      if (existing && (existing.blockId === startingSurface.id ||
          iceBlocks.some((block) => block.id === existing.blockId))) {
        if (hasStructureAbove) continue;
        removeAt(next.voxels, cell.x, cell.y, 0, occupancy);
      } else if (!existing) {
        put(
          next.voxels,
          { ...cell, z: 0, blockId: startingSurface.id },
          occupancy,
        );
      } else {
        continue;
      }
      break;
    } else if (entity.kind === "weightless-population") {
      const shouldAdd = weightlessBoxes.length < minimumWeightlessBoxes ||
        (weightlessBoxes.length < maximumWeightlessBoxes &&
         (weightlessBoxes.length <= minimumWeightlessBoxes || random() < 0.5));
      if (shouldAdd) {
        const usedIds = new Set(weightlessBoxes.map((members) => members[0].genericId ?? 0));
        let genericId = 0;
        while (usedIds.has(genericId)) genericId += 1;
        if (placeSupportedBox(
          next.voxels,
          choose(random, weightlessPushableBlocks),
          genericId,
          integer(random, 2, 5),
          configuration,
          random,
          blockRoles,
          occupancy,
        ).length) break;
      } else if (weightlessBoxes.length > minimumWeightlessBoxes) {
        const removed = choose(random, weightlessBoxes);
        for (const member of removed) {
          occupancyRemove(occupancy, member);
          next.voxels.splice(next.voxels.indexOf(member), 1);
        }
        break;
      }
    } else if (entity.kind === "box") {
      const operation = random();
      const changed = operation < 0.2
        ? translateBox(
          next.voxels,
          entity.members,
          configuration,
          random,
          blockRoles,
          occupancy,
        )
        : operation < 0.4
          ? relocateBox(
            next.voxels,
            entity.members,
            configuration,
            random,
            blockRoles,
            occupancy,
          )
          : operation < 0.7
            ? reshapeGenericBox(
              next.voxels,
              entity.members,
              configuration,
              random,
              blockRoles,
              occupancy,
            )
            : operation < 0.85
              ? growGenericBox(
                next.voxels,
                entity.members,
                configuration,
                random,
                blockRoles,
                occupancy,
              )
              : shrinkGenericBox(
                next.voxels, entity.members, random, occupancy,
              );
      if (changed) break;
    }
  }

  // Floor is a plane-only material. This final guard also protects imported
  // candidates and future mutation operators.
  if (floorBlock) {
    next.voxels = next.voxels.filter((voxel) =>
      voxel.blockId !== floorBlock.id || voxel.z === 0);
  }
  if (next.voxels.some((voxel) =>
    voxel.x < 0 || voxel.x >= configuration.width ||
    voxel.y < 0 || voxel.y >= configuration.depth ||
    voxel.z < 0 || voxel.z > configuration.layers)) {
    return cloneCandidate(candidate);
  }
  if (!planarTerrainWithinLimits(
    next.voxels, configuration, blockRoles, iceBlocks,
  ) || !objectivesShareStaticSurface(next.voxels, configuration, blockRoles)) {
    return cloneCandidate(candidate);
  }
  if (!dynamicsAreSettled(next.voxels, configuration, blockRoles, pushableBlocks)) {
    return cloneCandidate(candidate);
  }
  return next;
}

async function loadPhysics() {
  if (!physicsPromise) {
    physicsPromise = fetch("/physics/voxel_physics.wasm")
      .then((response) => {
        if (!response.ok) throw new Error(`C++ search engine failed to load (${response.status})`);
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.instantiate(bytes, {}))
      .then(({ instance }) => instance.exports);
  }
  return physicsPromise;
}

function roleCodes(physics, roles) {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(
    physics.memory.buffer,
    physics.role_buffer(),
    physics.role_buffer_capacity(),
  );
  const codes = new Map();
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
    buffer.set(bytes.subarray(0, physics.role_buffer_capacity()));
    codes.set(roleId, physics.role_code(bytes.length));
  }
  return codes;
}

function slopePhysicsRoleId(baseRoleId, direction) {
  if (baseRoleId === "orange-wall") return `orange-wall-slope-${direction}`;
  if (baseRoleId === "weightless-pushable") return `blue-box-slope-${direction}`;
  if (baseRoleId === "clone") return `yellow-clone-slope-${direction}`;
  return `ice-slope-${direction}`;
}

function solutionInteractionStats(
  physics,
  buffer,
  count,
  stride,
  width,
  height,
  solution,
  codes,
) {
  const pushableCodes = new Set([
    codes.get("pushable"), codes.get("weightless-pushable"),
  ].filter((code) => code !== undefined));
  const playerCode = codes.get("player");
  const groups = new Map();
  let playerIndex = -1;
  for (let index = 0; index < count; index += 1) {
    const offset = index * stride;
    const role = buffer[offset + 3];
    if (role === playerCode) playerIndex = index;
    if (!pushableCodes.has(role)) continue;
    const genericId = buffer[offset + 4];
    const key = genericId >= 0 ? `${role}:${genericId}` : `${role}:voxel:${index}`;
    const members = groups.get(key) ?? [];
    members.push(index);
    groups.set(key, members);
  }

  let pushes = 0;
  let iceSlides = 0;
  let boxesDropped = 0;
  for (const direction of solution) {
    const beforeGroups = [...groups.values()].map((members) => members.map((index) => {
      const offset = index * stride;
      return [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
    }));
    const playerOffset = playerIndex * stride;
    const playerBefore = playerIndex >= 0
      ? [buffer[playerOffset], buffer[playerOffset + 1]]
      : null;
    physics.simulate_turn(count, width, height, DIRECTION_NAMES.indexOf(direction));
    [...groups.values()].forEach((members, groupIndex) => {
      let moved = false;
      let wasActive = false;
      let isActive = false;
      members.forEach((index, memberIndex) => {
        const offset = index * stride;
        const before = beforeGroups[groupIndex][memberIndex];
        const after = [buffer[offset], buffer[offset + 1], buffer[offset + 2]];
        if (before.some((coordinate, axis) => coordinate !== after[axis])) moved = true;
        if (before[0] >= 0 && before[1] >= 0) wasActive = true;
        if (after[0] >= 0 && after[1] >= 0) isActive = true;
      });
      if (moved) pushes += 1;
      if (wasActive && !isActive) boxesDropped += 1;
    });
    if (playerBefore && buffer[playerOffset] >= 0 && buffer[playerOffset + 1] >= 0 &&
        Math.abs(buffer[playerOffset] - playerBefore[0]) +
        Math.abs(buffer[playerOffset + 1] - playerBefore[1]) > 1) {
      iceSlides += 1;
    }
  }
  return { pushes, iceSlides, boxesDropped };
}

async function evaluate(
  candidate,
  configuration,
  physics,
  codes,
  maximumNodes = configuration.maxNodes,
  analyzeInteractions = false,
) {
  if (candidate.voxels.length > physics.search_voxel_capacity()) {
    throw new Error(
      `Candidate has ${candidate.voxels.length} voxels; exact search supports ${physics.search_voxel_capacity()}.`,
    );
  }
  const blocksById = new Map(configuration.blocks.map((block) => [block.id, block]));
  const slopeDirections = ["up", "right", "down", "left"];
  const voxelRole = (voxel) => {
    const block = blocksById.get(voxel.blockId);
    if (!block) return 0;
    if (block.visual?.kind === "slope") {
      const direction = slopeDirections.includes(voxel.orientation)
        ? voxel.orientation
        : slopeDirections[Math.max(0, Math.floor(voxel.variantId ?? 0)) % 4];
      return codes.get(slopePhysicsRoleId(block.roleId, direction)) ?? 0;
    }
    return codes.get(block.roleId) ?? 0;
  };
  const genericRoles = new Set(configuration.roles.filter((role) => role.generic).map((role) => role.id));
  const genericBlocks = new Set(configuration.blocks
    .filter((block) => genericRoles.has(block.roleId)).map((block) => block.id));
  const stride = physics.voxel_stride();
  const buffer = new Int32Array(
    physics.memory.buffer,
    physics.voxel_buffer(),
    candidate.voxels.length * stride,
  );
  candidate.voxels.forEach((voxel, index) => {
    const orangeWall = blocksById.get(voxel.blockId)?.roleId === "orange-wall";
    const depth = Math.max(0, Math.floor(voxel.mechanismDepth ?? voxel.stateId ?? 0));
    buffer.set([
      voxel.x,
      voxel.y,
      orangeWall ? voxel.z + (voxel.stateId === 0 ? Math.max(0, depth - 1) : depth) : voxel.z,
      voxelRole(voxel),
      orangeWall ? depth : genericBlocks.has(voxel.blockId) ? Math.max(0, voxel.genericId ?? 0) : -1,
    ], index * stride);
  });
  const initialState = buffer.slice();
  const started = performance.now();
  const status = physics.search_solve(
    candidate.voxels.length,
    candidate.world.width,
    candidate.world.height,
    Math.min(maximumNodes, physics.search_node_capacity()),
  );
  const elapsedMs = Math.max(0.001, performance.now() - started);
  const expanded = physics.search_expanded();
  const commandTransitions = physics.search_command_transitions();
  const length = physics.search_solution_length();
  const solution = [];
  for (let index = 0; index < length; index += 1) {
    solution.push(DIRECTION_NAMES[physics.search_solution_step(index)]);
  }
  const interactions = analyzeInteractions && solution.length
    ? (() => {
      buffer.set(initialState);
      return solutionInteractionStats(
        physics,
        buffer,
        candidate.voxels.length,
        stride,
        candidate.world.width,
        candidate.world.height,
        solution,
        codes,
      );
    })()
    : { pushes: 0, iceSlides: 0, boxesDropped: 0 };
  return {
    ...candidate,
    solution,
    moves: physics.search_moves(),
    expanded,
    generated: physics.search_generated(),
    transpositions: physics.search_transpositions(),
    commandTransitions,
    commandTransitionsPerSecond: Math.round(
      commandTransitions / (elapsedMs / 1000),
    ),
    nodesPerSecond: Math.round(expanded / (elapsedMs / 1000)),
    elapsedMs,
    optimal: status === 1,
    provisional: status === 3,
    limitHit: status === 2 || status === 3,
    evaluatedNodes: Math.min(maximumNodes, physics.search_node_capacity()),
    ...interactions,
  };
}

function better(left, right) {
  if (!right) return true;
  const leftQuality = left.optimal ? 3 : left.provisional ? 2 : left.limitHit ? 1 : 0;
  const rightQuality = right.optimal ? 3 : right.provisional ? 2 : right.limitHit ? 1 : 0;
  if (leftQuality !== rightQuality) return leftQuality > rightQuality;
  if ((left.optimal || left.provisional) && left.moves !== right.moves) {
    return left.moves > right.moves;
  }
  const leftTerrain = (left.iceSlides ?? 0) + (left.boxesDropped ?? 0);
  const rightTerrain = (right.iceSlides ?? 0) + (right.boxesDropped ?? 0);
  if (leftQuality > 0 && leftTerrain !== rightTerrain) return leftTerrain > rightTerrain;
  if (leftQuality > 0 && (left.pushes ?? 0) !== (right.pushes ?? 0)) {
    return (left.pushes ?? 0) > (right.pushes ?? 0);
  }
  return left.expanded > right.expanded;
}

function evaluationSnapshot(candidate) {
  return {
    solution: [...candidate.solution],
    moves: candidate.moves,
    expanded: candidate.expanded,
    generated: candidate.generated,
    transpositions: candidate.transpositions,
    commandTransitions: candidate.commandTransitions,
    commandTransitionsPerSecond: candidate.commandTransitionsPerSecond,
    nodesPerSecond: candidate.nodesPerSecond,
    elapsedMs: candidate.elapsedMs,
    optimal: candidate.optimal,
    provisional: candidate.provisional ?? false,
    limitHit: candidate.limitHit,
    evaluatedNodes: candidate.evaluatedNodes ?? 0,
    pushes: candidate.pushes ?? 0,
    iceSlides: candidate.iceSlides ?? 0,
    boxesDropped: candidate.boxesDropped ?? 0,
  };
}

function structuralNiche(candidate, configuration) {
  const roles = new Map(configuration.blocks.map((block) => [block.id, block.roleId]));
  const counts = new Map();
  let maximumZ = 0;
  for (const voxel of candidate.voxels) {
    const role = roles.get(voxel.blockId) ?? "unknown";
    counts.set(role, (counts.get(role) ?? 0) + 1);
    maximumZ = Math.max(maximumZ, voxel.z);
  }
  const boxes = boxEntities(
    candidate.voxels,
    configuration.blocks.filter((block) =>
      block.roleId === "pushable" || block.roleId === "weightless-pushable"),
  );
  const player = candidate.voxels.find((voxel) => roles.get(voxel.blockId) === "player");
  const goals = candidate.voxels.filter((voxel) => roles.get(voxel.blockId) === "goal");
  const endpointDistance = player && goals.length
    ? Math.min(...goals.map((goal) =>
      Math.abs(goal.x - player.x) + Math.abs(goal.y - player.y) +
      Math.abs(goal.z - player.z)))
    : 0;
  const rowZeroTerrain = candidate.voxels.filter((voxel) => voxel.z === 0 &&
    (roles.get(voxel.blockId) === "floor" || roles.get(voxel.blockId) === "ice")).length;
  const holes = candidate.world.width * candidate.world.height - rowZeroTerrain;
  return [
    boxes.length,
    Math.floor((counts.get("weightless-pushable") ?? 0) / 8),
    Math.floor((counts.get("ice") ?? 0) / 8),
    Math.floor((counts.get("solid") ?? 0) / 8),
    Math.floor(holes / 4),
    Math.floor(endpointDistance / 3),
    Math.floor(maximumZ / 2),
  ].join(":");
}

async function evolve(configuration) {
  const footprint = Number(configuration.width) * Number(configuration.depth);
  const minimumSceneVoxels = footprint + 1 + Math.max(
    1, configuration.collectibles ?? 1,
  );
  if (!Number.isSafeInteger(footprint) || footprint <= 0 ||
      minimumSceneVoxels > SEARCH_VOXEL_CAPACITY) {
    throw new Error(
      `The ${configuration.width}×${configuration.depth} base plus player and gems requires at least ${minimumSceneVoxels.toLocaleString()} voxels; exact search currently supports ${SEARCH_VOXEL_CAPACITY.toLocaleString()} total scene voxels.`,
    );
  }
  if (configuration.width - 1 > SEARCH_COORDINATE_MAX ||
      configuration.depth - 1 > SEARCH_COORDINATE_MAX ||
      configuration.layers > SEARCH_COORDINATE_MAX) {
    throw new Error(
      `Search coordinates currently range from 0 through ${SEARCH_COORDINATE_MAX.toLocaleString()} on each axis.`,
    );
  }
  const evaluationPool = createEvaluationPool(configuration);
  const random = mulberry32(configuration.seed);
  const populationSize = Math.max(4, Math.min(1024, configuration.population));
  let population = [];
  const initialSignatures = new Set();
  const addInitial = (candidate) => {
    const signature = candidateSignature(candidate);
    if (initialSignatures.has(signature)) return false;
    initialSignatures.add(signature);
    population.push(candidate);
    return true;
  };
  if (configuration.startingCandidate) {
    const seed = cloneCandidate({
      ...configuration.startingCandidate,
      world: {
        width: configuration.width,
        height: configuration.depth,
        floorLayer: 0,
      },
      layers: configuration.layers,
      solution: [],
      optimal: false,
      provisional: false,
    });
    addInitial(seed);
    const seededTarget = Math.max(1, Math.floor(
      populationSize * Math.max(
        0, Math.min(1, (configuration.seedPopulationPercent ?? 75) / 100),
      ),
    ));
    for (let attempts = 0;
      population.length < seededTarget && attempts < seededTarget * 30;
      attempts += 1) {
      let candidate = cloneCandidate(seed);
      const mutations = integer(random, 1, configuration.seedMutationMax ?? 12);
      for (let mutation = 0; mutation < mutations; mutation += 1) {
        candidate = mutateCandidate(candidate, configuration, random);
      }
      addInitial(candidate);
    }
  }
  while (population.length < populationSize) {
    const candidate = makeCandidate(configuration, random);
    addInitial(candidate);
  }
  let best = null;
  let evaluated = 0;
  let cacheHits = 0;
  let totalExpanded = 0;
  let totalCommandTransitions = 0;
  let totalSolverMs = 0;
  let stagnation = 0;
  const evaluationCache = new Map();
  const evaluatedSignatures = new Set();
  const cacheLimit = Math.max(0, configuration.cacheEntries ?? 4096);
  const cacheSet = (key, value) => {
    if (cacheLimit <= 0) return;
    if (evaluationCache.has(key)) evaluationCache.delete(key);
    evaluationCache.set(key, value);
    while (evaluationCache.size > cacheLimit) {
      evaluationCache.delete(evaluationCache.keys().next().value);
    }
  };
  const evolutionStartedAt = performance.now();

  for (let generation = 1; generation <= configuration.generations; generation += 1) {
    if (stopped) {
      evaluationPool.close();
      return;
    }
    const scoredByIndex = new Array(population.length).fill(null);
    const generationStartedAt = performance.now();
    let generationImproved = false;
    let processed = 0;
    const reportProgress = () => {
      const elapsedSeconds = Math.max(
        0.001, (performance.now() - evolutionStartedAt) / 1000,
      );
      self.postMessage({
        type: "progress",
        generation,
        generations: configuration.generations,
        evaluated,
        bestMoves: best?.optimal ? best.moves : 0,
        bestProvisionalMoves: best?.provisional ? best.moves : 0,
        nodesPerSecond: Math.round(totalExpanded / elapsedSeconds),
        solverNodesPerSecond: Math.round(
          totalExpanded / Math.max(0.001, totalSolverMs / 1000),
        ),
        commandTransitionsPerSecond: Math.round(
          totalCommandTransitions / elapsedSeconds,
        ),
        solverCommandTransitionsPerSecond: Math.round(
          totalCommandTransitions / Math.max(0.001, totalSolverMs / 1000),
        ),
        solvesPerSecond: Math.round(evaluated / elapsedSeconds),
        cacheHits,
        uniqueCandidates: evaluatedSignatures.size,
        stagnation,
        evaluatorCount: evaluationPool.concurrency,
        elapsedMs: performance.now() - evolutionStartedAt,
        generationElapsedMs: performance.now() - generationStartedAt,
      });
    };
    const finishGeneration = () => {
      const completedAt = performance.now();
      self.postMessage({
        type: "generation",
        generation,
        solutionLength: best?.optimal || best?.provisional ? best.moves : 0,
        provisional: Boolean(best?.provisional),
        durationMs: completedAt - generationStartedAt,
        elapsedMs: completedAt - evolutionStartedAt,
      });
    };
    const record = (index, result) => {
      processed += 1;
      if (result) scoredByIndex[index] = result;
      if (processed % 4 === 0 || processed === population.length) reportProgress();
    };
    const jobs = [];
    const screeningNodes = Math.max(
      1,
      Math.min(configuration.screeningNodes ?? configuration.maxNodes, configuration.maxNodes),
    );
    const screeningAnalyzesInteractions =
      screeningNodes === configuration.maxNodes && Boolean(configuration.analyzeInteractions);
    for (let index = 0; index < population.length; index += 1) {
      const signature = candidateSignature(population[index]);
      const cacheKey = `${signature}:${screeningNodes}:${screeningAnalyzesInteractions ? 1 : 0}`;
      const cached = evaluationCache.get(cacheKey);
      if (cached) {
        cacheHits += 1;
        evaluationCache.delete(cacheKey);
        evaluationCache.set(cacheKey, cached);
        record(index, {
          ...cloneCandidate(population[index]),
          ...cached,
          solution: [...cached.solution],
        });
      } else {
        jobs.push({
          candidate: population[index],
          signature,
          index,
          maximumNodes: screeningNodes,
          analyzeInteractions: screeningAnalyzesInteractions,
        });
      }
    }
    await evaluationPool.evaluate(jobs, (job, result) => {
      if (result) {
        cacheSet(
          `${job.signature}:${screeningNodes}:${screeningAnalyzesInteractions ? 1 : 0}`,
          evaluationSnapshot(result),
        );
        evaluatedSignatures.add(job.signature);
        evaluated += 1;
        totalExpanded += result.expanded;
        totalCommandTransitions += result.commandTransitions;
        totalSolverMs += result.elapsedMs;
      }
      record(job.index, result);
    });

    // Cheap screening prevents one pathological candidate from monopolizing a
    // generation. The most promising provisional or exact routes are then
    // re-run at the full proof budget before selection and record publication.
    if (!stopped && screeningNodes < configuration.maxNodes) {
      const promotionCount = Math.max(
        1,
        Math.min(
          population.length,
          configuration.proofCandidates ?? configuration.eliteCount ?? 24,
        ),
      );
      const promotionIndices = scoredByIndex.map((result, index) => ({ result, index }))
        .filter(({ result }) => result)
        .sort((left, right) => {
          const leftHasRoute = left.result.optimal || left.result.provisional;
          const rightHasRoute = right.result.optimal || right.result.provisional;
          if (leftHasRoute !== rightHasRoute) return leftHasRoute ? -1 : 1;
          if (leftHasRoute && left.result.moves !== right.result.moves) {
            return right.result.moves - left.result.moves;
          }
          return better(left.result, right.result) ? -1 : 1;
        })
        .slice(0, promotionCount)
        .map(({ index }) => index);
      const proofJobs = [];
      for (const index of promotionIndices) {
        const candidate = population[index];
        const signature = candidateSignature(candidate);
        const analyze = Boolean(configuration.analyzeInteractions);
        const cacheKey = `${signature}:${configuration.maxNodes}:${analyze ? 1 : 0}`;
        const cached = evaluationCache.get(cacheKey);
        if (cached) {
          cacheHits += 1;
          evaluationCache.delete(cacheKey);
          evaluationCache.set(cacheKey, cached);
          scoredByIndex[index] = {
            ...cloneCandidate(candidate),
            ...cached,
            solution: [...cached.solution],
          };
        } else {
          proofJobs.push({
            candidate,
            signature,
            cacheKey,
            index,
            maximumNodes: configuration.maxNodes,
            analyzeInteractions: analyze,
          });
        }
      }
      await evaluationPool.evaluate(proofJobs, (job, result) => {
        if (!result) return;
        cacheSet(job.cacheKey, evaluationSnapshot(result));
        evaluatedSignatures.add(job.signature);
        evaluated += 1;
        totalExpanded += result.expanded;
        totalCommandTransitions += result.commandTransitions;
        totalSolverMs += result.elapsedMs;
        scoredByIndex[job.index] = result;
        reportProgress();
      });
    }
    if (stopped) {
      evaluationPool.close();
      return;
    }
    const scored = scoredByIndex.filter(Boolean);
    for (const result of scored) {
      if (!better(result, best)) continue;
      best = cloneCandidate(result);
      generationImproved = true;
      self.postMessage({ type: "best", candidate: best, generation, evaluated });
    }
    stagnation = generationImproved ? 0 : stagnation + 1;
    scored.sort((left, right) => better(left, right) ? -1 : better(right, left) ? 1 : 0);
    if (best?.optimal && best.moves >= Math.max(1, configuration.targetMoves ?? 500)) {
      finishGeneration();
      break;
    }
    const eliteCount = Math.max(2, Math.min(
      scored.length,
      Math.max(2, populationSize - 1),
      configuration.eliteCount ?? Math.ceil(populationSize * 0.1),
    ));
    const eliteIndices = [];
    const retainedNiches = new Set();
    const nicheSlots = Math.max(2, Math.floor(
      eliteCount * Math.max(0, Math.min(1, configuration.nichePercent ?? 25)) / 100,
    ));
    for (let index = 0; index < scored.length && eliteIndices.length < nicheSlots; index += 1) {
      const niche = structuralNiche(scored[index], configuration);
      if (retainedNiches.has(niche)) continue;
      retainedNiches.add(niche);
      eliteIndices.push(index);
    }
    for (let index = 0; index < scored.length && eliteIndices.length < eliteCount; index += 1) {
      if (!eliteIndices.includes(index)) eliteIndices.push(index);
    }
    const elites = eliteIndices.map((index) => scored[index]);
    const next = [];
    const nextSignatures = new Set();
    for (const elite of elites) {
      const signature = candidateSignature(elite);
      if (nextSignatures.has(signature)) continue;
      nextSignatures.add(signature);
      next.push(cloneCandidate(elite));
    }
    const immigrantCount = Math.max(
      1,
      stagnation > (configuration.immigrantStagnation ?? 100)
        ? Math.floor(populationSize * (configuration.stagnantImmigrantPercent ?? 20) / 100)
        : Math.floor(populationSize * (configuration.immigrantPercent ?? 8) / 100),
    );
    while (next.length < populationSize - immigrantCount) {
      if (!elites.length) break;
      let accepted = null;
      for (let attempt = 0; attempt < 16 && !accepted; attempt += 1) {
        const globalParent = scored[integer(
          random, 0, Math.min(scored.length, Math.max(eliteCount * 2, 2)) - 1,
        )];
        const nicheParent = choose(random, elites);
        const parent = random() < 0.25 ? nicheParent :
          better(globalParent, nicheParent) ? globalParent : nicheParent;
        let child = cloneCandidate(parent);
        const escape = stagnation > (configuration.escapeStagnation ?? 50) &&
          random() < Math.max(
            0, Math.min(1, (configuration.escapeMutationPercent ?? 34) / 100),
          );
        const mutations = escape
          ? integer(
            random,
            configuration.escapeMutationMin ?? 6,
            configuration.escapeMutationMax ?? 18,
          )
          : integer(
            random,
            configuration.mutationMin ?? 1,
            configuration.mutationMax ?? 5,
          );
        for (let mutation = 0; mutation < mutations; mutation += 1) {
          child = mutateCandidate(child, configuration, random);
        }
        const signature = candidateSignature(child);
        if (!nextSignatures.has(signature)) {
          nextSignatures.add(signature);
          accepted = child;
        }
      }
      if (accepted) next.push(accepted);
      else break;
    }
    while (next.length < populationSize) {
      const immigrant = makeCandidate(configuration, random);
      const signature = candidateSignature(immigrant);
      if (nextSignatures.has(signature)) continue;
      nextSignatures.add(signature);
      next.push(immigrant);
    }
    population = next;
    finishGeneration();
  }

  evaluationPool.close();
  const elapsedSeconds = Math.max(
    0.001, (performance.now() - evolutionStartedAt) / 1000,
  );
  self.postMessage({
    type: "done",
    candidate: best,
    evaluated,
    nodesPerSecond: Math.round(totalExpanded / elapsedSeconds),
    solverNodesPerSecond: Math.round(
      totalExpanded / Math.max(0.001, totalSolverMs / 1000),
    ),
    commandTransitionsPerSecond: Math.round(
      totalCommandTransitions / elapsedSeconds,
    ),
    solverCommandTransitionsPerSecond: Math.round(
      totalCommandTransitions / Math.max(0.001, totalSolverMs / 1000),
    ),
    solvesPerSecond: Math.round(evaluated / elapsedSeconds),
    cacheHits,
    uniqueCandidates: evaluatedSignatures.size,
    stagnation,
    elapsedMs: performance.now() - evolutionStartedAt,
    generationElapsedMs: 0,
  });
}

if (typeof self !== "undefined") {
  self.addEventListener("message", (event) => {
    if (event.data?.type === "stop") {
      stopped = true;
      return;
    }
    if (event.data?.type === "initialize-evaluator") {
      evaluatorConfiguration = event.data.configuration;
      return;
    }
    if (event.data?.type === "evaluate") {
      const {
        candidate,
        configuration = evaluatorConfiguration,
        requestId,
        maximumNodes,
        analyzeInteractions,
      } = event.data;
      if (!configuration) {
        self.postMessage({
          type: "evaluation",
          requestId,
          result: null,
          error: "Evaluator was not initialized",
        });
        return;
      }
      loadPhysics()
        .then((physics) => evaluate(
          candidate,
          configuration,
          physics,
          roleCodes(physics, configuration.roles),
          maximumNodes ?? configuration.maxNodes,
          analyzeInteractions ?? configuration.analyzeInteractions,
        ))
        .then((result) => self.postMessage({ type: "evaluation", requestId, result }))
        .catch((error) => self.postMessage({
          type: "evaluation",
          requestId,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        }));
      return;
    }
    if (event.data?.type !== "start") return;
    stopped = false;
    evolve(event.data.configuration).catch((error) => {
      self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });
  });
}

export {
  boxEntities,
  candidateSignature,
  exactBlockClusters,
  growGenericBox,
  growWallUpward,
  makeCandidate,
  mulberry32,
  mutateCandidate,
  relocateObjectives,
  shrinkGenericBox,
  shrinkStaticCluster,
  reverseScrambleCandidate,
};
