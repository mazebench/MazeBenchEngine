const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const messages = [];
const context = {
  console,
  Date,
  Number,
  WebAssembly,
  Uint8Array,
  Int32Array,
  setTimeout,
  clearTimeout,
  postMessage(message) {
    messages.push(message);
  }
};
context.self = context;
vm.createContext(context);
context.importScripts = (...names) => {
  for (const name of names) {
    const source = fs.readFileSync(path.join(root, "public", name), "utf8");
    vm.runInContext(source, context, { filename: name });
  }
};

vm.runInContext(
  fs.readFileSync(path.join(root, "public", "world-solver-worker.js"), "utf8"),
  context,
  { filename: "world-solver-worker.js" }
);

function floorTerrain(width, height) {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ type: "floor" }))
  );
}

(async () => {
  await context.onmessage({
    data: {
      type: "analyze_room",
      id: 7,
      playData: {
        width: 3,
        height: 1,
        terrain: floorTerrain(3, 1),
        actors: [
          { type: "player", x: 0, y: 0, removed: false },
          { type: "gem", x: 2, y: 0, removed: false }
        ]
      },
      gemTargets: [{ id: "gem", type: "gem", x: 2, y: 0, elevation: 0 }],
      positionTargets: [
        { id: "cell:0", kind: "cell", x: 0, y: 0, elevation: 0 },
        { id: "exit:right", kind: "exit", direction: "right", x: 2, y: 0, elevation: 0 }
      ]
    }
  });

  const done = messages.find((message) => message.type === "done" && message.id === 7);
  assert.ok(done);
  assert.equal(done.result.exhaustive, true);
  assert.equal(done.result.gemResults[0].status, "solved");
  assert.equal(done.result.gemResults[0].path, "RR");
  assert.equal(done.result.positionResult.reachable.length, 2);

  await context.onmessage({
    data: {
      type: "analyze_room",
      id: 8,
      playData: {
        width: 3,
        height: 1,
        terrain: floorTerrain(3, 1),
        actors: [
          { type: "player", x: 0, y: 0, removed: false },
          { type: "gem", x: 1, y: 0, removed: false }
        ]
      },
      gemTargets: [{
        id: "location:2,0,0",
        kind: "gem",
        type: "gem",
        x: 2,
        y: 0,
        elevation: 0,
        removed: false
      }],
      positionTargets: []
    }
  });

  const locationDone = messages.find((message) => message.type === "done" && message.id === 8);
  assert.ok(locationDone);
  assert.equal(locationDone.result.gemResults[0].status, "solved");
  assert.equal(locationDone.result.gemResults[0].path, "RR");

  await context.onmessage({
    data: {
      type: "analyze_room",
      id: 9,
      maxExpandedStates: 1,
      playData: {
        width: 4,
        height: 1,
        terrain: floorTerrain(4, 1),
        actors: [
          { type: "player", x: 0, y: 0, removed: false },
          { type: "gem", x: 3, y: 0, removed: false }
        ]
      },
      gemTargets: [{ id: "gem", type: "gem", x: 3, y: 0, elevation: 0 }],
      positionTargets: []
    }
  });

  const capped = messages.find((message) => message.type === "done" && message.id === 9);
  assert.ok(capped);
  assert.equal(capped.result.exhaustive, false);
  assert.equal(capped.result.gemResults[0].status, "capped");
  assert.ok(capped.continuationId);

  await context.onmessage({
    data: {
      type: "continue_analysis",
      id: 10,
      continuationId: capped.continuationId,
      additionalExpandedStates: 100
    }
  });

  const continued = messages.find((message) => message.type === "done" && message.id === 10);
  assert.ok(continued);
  assert.equal(continued.result.exhaustive, true);
  assert.equal(continued.result.gemResults[0].status, "solved");
  assert.equal(continued.result.gemResults[0].path, "RRR");
  assert.equal(continued.continuationId, "");

  await context.MazeEngineVersions.load("v1.1", {
    bytes: fs.readFileSync(path.join(root, "public", "physics", "v1.1.wasm"))
  });
  const nativeData = {
    engineVersion: "v1.1", physicsTrace: false, width: 5, height: 1,
    terrain: [[{type:"floor"}, {type:"floor"}, {type:"hole"}, {type:"floor"}, {type:"floor"}]],
    actors: [{type:"player",x:0,y:0}, {type:"floating_floor",x:1,y:0}]
  };
  const nativeGem = { id:"native-goal", type:"gem", x:4, y:0, elevation:0 };
  await context.onmessage({data:{
    type:"analyze_room", id:11, playData:nativeData, gemTargets:[nativeGem],
    positionTargets:[], maxExpandedStates:1
  }});
  const nativeCapped = messages.find(message => message.type === "done" && message.id === 11);
  assert.ok(nativeCapped?.continuationId, "native searches remain bounded and resumable");
  await context.onmessage({data:{
    type:"continue_analysis", id:12, continuationId:nativeCapped.continuationId, additionalExpandedStates:100
  }});
  const nativeDone = messages.find(message => message.type === "done" && message.id === 12);
  const nativeRoute = nativeDone?.result.gemResults[0];
  assert.equal(nativeRoute?.status, "solved");
  assert.equal(nativeRoute.path, "RRRR");
  const nativeEngine = context.MazeEngineVersions.createEngine({...nativeData, actors:[...nativeData.actors,nativeGem]});
  const nativeState = nativeEngine.cloneState(nativeEngine.initialState);
  for (const step of nativeRoute.path) {
    const direction = {U:[0,-1],R:[1,0],D:[0,1],L:[-1,0]}[step];
    nativeEngine.move(nativeState,...direction);
  }
  assert.equal(nativeEngine.isSolved(nativeState),true, "solver output replays under the selected native physics");
  assert.equal(nativeState.terrainState[0][2].type,"floor", "native filled-hole state survives search branches");
  console.log("world-solver-worker: OK — gem, location, and edge routes use the built-in solver.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
