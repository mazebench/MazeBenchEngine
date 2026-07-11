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
  console.log("world-solver-worker: OK — gem, location, and edge routes use the built-in solver.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
