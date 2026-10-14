const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { loadBrowserScript } = require("./helpers/browser-module-loader");
const frames = new Map(); let nextFrame = 1;
function createStubCanvasContext() {
  const noop = () => {};
  return {
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
    clip: noop,
    quadraticCurveTo: noop,
    arc: noop,
    ellipse: noop,
    drawImage: noop,
    setTransform: noop,
    rect: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    closePath: noop,
    imageSmoothingEnabled: false,
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: ""
  };
}

function createStubCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      return type === "webgl" ? null : createStubCanvasContext();
    }
  };
}

global.performance = performance;
global.document = {
  title: "",
  createElement(tag) {
    return tag === "canvas" ? createStubCanvas() : {};
  }
};
global.window = {
  location: { pathname: "/play/maze/level_AxA", search: "" },
  history: { replaceState: () => {} },
  devicePixelRatio: 1,
  requestAnimationFrame: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
  cancelAnimationFrame: (id) => frames.delete(id),
  setTimeout(fn) {
    // window.fetch is intentionally undefined, so neighbor-level queue
    // callbacks all bail out immediately; running them inline is safe.
    fn();
    return 0;
  },
  localStorage: {
    getItem: () => null,
    setItem: () => {}
  },
  PlayModules: {}
};

loadBrowserScript("public/play-rules.js");
loadBrowserScript("public/maze-engine.js");
loadBrowserScript("public/maze-engine-versions.js");
loadBrowserScript("public/play-core.js");
loadBrowserScript("public/play-movement.js");
loadBrowserScript("public/play-render-compositor.js");
loadBrowserScript("public/play-world-transitions.js");
loadBrowserScript("public/play-gameplay.js");


function fixture() {
  return {
    engineVersion: "v1.1", gameId: "maze", levelId: "__v11_test__", width: 7, height: 3,
    terrain: Array.from({length:3},()=>Array.from({length:7},()=>({type:"floor",layers:[{type:"floor",elevation:0}]}))),
    actors: [{type:"player",x:1,y:1,elevation:0},{type:"weightless_box",groupId:"M0",x:3,y:1,elevation:0}]
  };
}
function runtime(data) {
  const app = window.PlayModules.createPlayCore({playData:data,canvas:createStubCanvas(),playShell:null,playHeader:null,playStage:null,mazeFrame:null,fuzzyToggle:null});
  app.renderTerrain={paintGround:()=>{}}; app.renderActors={paintDepthSortedScene:()=>{},actorDepthRow:()=>0,paintRaisedPlayer:()=>{}};
  window.PlayModules.registerRenderCompositorFunctions(app);
  window.PlayModules.registerGameplayFunctions(app); app.render=()=>{}; app.renderOncePerFrame=()=>{};
  return app;
}
function drainUntil(done) {
  for(let step=0;step<1000&&!done();step++) {
    const entry=frames.entries().next().value;
    assert.ok(entry,"animation must schedule its next frame"); frames.delete(entry[0]); entry[1](step*40);
  }
  assert.ok(done(),"animation must terminate"); frames.clear();
}
(async()=>{
  await window.MazeEngineVersions.load("v1.1",{bytes:fs.readFileSync(path.join(__dirname,"../public/physics/v1.1.wasm"))});
  const data=fixture(); data.terrain[1][2]={type:"player_lift",layers:[{type:"floor",elevation:0},{type:"player_lift",elevation:0}]};
  const app=runtime(data);
  const engine=window.MazeEngineVersions.createEngine(data), state=engine.cloneState(engine.initialState);
  for (const [dx,dy] of [[1,0],[-1,0],[1,0],[1,0],[0,1],[1,0],[-1,0],[0,-1]]) {
    engine.move(state,dx,dy);
    app.movement.performPlayerMove(dx,dy,{animate:false});
    for(let i=0;i<data.actors.length;i++) {
      assert.equal(app.state.actors[i].x,state.actorX[i]); assert.equal(app.state.actors[i].y,state.actorY[i]);
      assert.equal(app.state.actors[i].elevation,state.actorElevation[i]); assert.equal(app.state.actors[i].removed,!!state.actorRemoved[i]);
      assert.equal(app.state.actors[i].v11GenericId,state.actorGenericId[i]);
    }
    assert.deepEqual(app.state.terrain.map(row=>row.map(cell=>cell.layers)),state.terrainState.map(row=>row.map(cell=>cell.layers)));
  }
  const undo=runtime(data); undo.movement.performPlayerMove(1,0,{animate:false});
  assert.equal(undo.state.terrain[1][2].raised,true); assert.equal(undo.state.actors[0].elevation,1);
  undo.undoMove({instantRestore:true}); assert.equal(undo.state.actors[0].x,1); assert.equal(undo.state.actors[0].elevation,0);
  assert.notEqual(undo.state.terrain[1][2].raised,true);
  undo.movement.performPlayerMove(1,0,{animate:false}); assert.equal(undo.state.actors[0].elevation,1);
  const animatedData=fixture(); animatedData.actors=[{type:"player",x:0,y:1,elevation:0}];
  for(let x=1;x<5;x++) animatedData.terrain[1][x]={type:"ice",layers:[{type:"ice",elevation:0}]};
  const animated=runtime(animatedData); let finished=false;
  animated.movement.performPlayerMove(1,0,{onFinish:()=>{finished=true;}});
  drainUntil(()=>finished); assert.equal(animated.state.actors[0].x,5); assert.equal(animated.isAnimating,false);
  assert.equal(animated.moveHistory.length,1,"a multi-tick command is one undo action");
  animated.undoMove({instantRestore:true}); assert.equal(animated.state.actors[0].x,0);
  const roomIds = ["level_AxA", "level_BxA", "level_CxA"];
  const rooms = Object.fromEntries(roomIds.map(levelId => [levelId, {
    engineVersion: "v1.1", gameId: "maze", levelId, width: 3, height: 1,
    worldColumns: ["A", "B", "C"], worldRows: ["A"], worldLevelIds: roomIds,
    terrain: [[0, 1, 2].map(() => ({ type: "ice", layers: [{ type: "ice", elevation: 0 }] }))], actors: []
  }]));
  rooms.level_AxA.terrain[0][0] = { type: "floor", layers: [{ type: "floor", elevation: 0 }] };
  rooms.level_CxA.terrain[0][1] = { type: "floor", layers: [{ type: "floor", elevation: 0 }] };
  rooms.level_CxA.terrain[0][2] = { type: "wall", layers: [{ type: "wall", elevation: 0 }] };
  rooms.level_AxA.actors = [{ type: "player", x: 0, y: 0, elevation: 0 }];
  rooms.level_CxA.actors = [{ type: "gem", x: 1, y: 0, elevation: 0 }];
  const world = runtime(rooms.level_AxA);
  for (const room of Object.values(rooms)) world.rememberHorizontalNeighborLevelState(room);
  let notified = null;
  world.onModernWorldCommand = plan => { notified = plan; assert.equal(world.isAnimating, true, "save observes completed physics before input unlock"); };
  async function moveWorld(dx, inspect = null) {
    world.movePlayers(dx, 0);
    for (let i = 0; i < 100 && world.isPlanningWorldAction; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(world.isPlanningWorldAction, false);
    assert.ok(world.isAnimating, "composed movement uses canonical animated world rendering");
    inspect?.(world.worldActionAnimation);
    drainUntil(() => !world.isAnimating);
  }
  let animatedRooms, animatedStates, nativeSamples = [];
  world.renderOncePerFrame = () => {
    const action = world.worldActionAnimation;
    if (!action) return;
    assert.equal(action.rooms, animatedRooms, "room presentation is stable across animation frames");
    action.rooms.forEach((room, i) => assert.equal(room.levelState, animatedStates[i]));
    nativeSamples.push({ elapsed: action.elapsedMs, x: action.currentPoint.x });
  };
  await moveWorld(1, action => {
    animatedRooms = action.rooms;
    animatedStates = action.rooms.map(room => room.levelState);
    assert.equal(action.timeline.segments.length, 1, "straight native ice ticks form one continuous tween");
    assert.equal(action.timeline.segments[0].distance, 7);
    assert.equal(action.timeline.segments[0].continuous, true);
    assert.ok(Math.abs(action.timeline.motionEndMs - (7.5 + 1 + 3) * world.MOVE_DURATION_MS / 2.67) < 1e-8, "forced motion uses v1 ice timing");
    assert.equal(action.rooms.find(room => room.levelId === "level_BxA").renderDynamic, false, "unchanged intermediate rooms reuse cached rendering");
    assert.equal(action.rooms.find(room => room.levelId === "level_CxA").renderDynamic, true, "gem collection remains animated");
    const gem = action.rooms.find(room => room.levelId === "level_CxA").levelState.actors.find(actor => actor.type === "gem");
    assert.equal(gem.hoverSeed, world.cachedHorizontalNeighborLevelState("level_CxA").actors[0].hoverSeed, "native frames preserve the gem's continuous rotation phase");
  });
  const slope = nativeSamples[1].x / nativeSamples[1].elapsed;
  assert.ok(nativeSamples.slice(1, -1).every(sample => Math.abs(sample.x / sample.elapsed - slope) < 1e-8), "native tick boundaries do not restart easing on a straight forced path");
  world.renderOncePerFrame = () => {};
  assert.equal(world.currentLevelId, "level_CxA");
  assert.equal(world.state.actors.find(a => a.type === "player").x, 1);
  assert.deepEqual(notified.visitedLevelIds, ["level_CxA"], "only the settled living endpoint is a visit");
  assert.equal(world.collectedGemIds.size, 1);
  assert.equal(world.state.actors.find(a => a.type === "gem").showCollectedGhost, false, "a freshly collected gem stays hidden during this visit");
  assert.equal(world.state.actors.find(a => a.type === "gem").renderAlpha, 0);
  assert.equal(world.moveHistory.length, 1);
  world.undoMove({ instantRestore: true });
  assert.equal(world.currentLevelId, "level_AxA");
  assert.equal(world.state.actors[0].x, 0);
  await moveWorld(1);
  assert.equal(world.currentLevelId, "level_CxA");
  assert.equal(world.collectedGemIds.size, 1, "undo and replay must not duplicate the gem");
  assert.equal(notified.collectedGems.length, 0);
  assert.equal(world.state.actors.find(a => a.type === "gem").showCollectedGhost, true, "returning to a previously collected gem uses the canonical ghost visual");
  world.resetCollectionProgress();
  assert.equal(world.collectedGemIds.size,0);
  assert.equal(world.v11WorldRooms.level_CxA.actors.find(a=>a.type==="gem").removed,false,"reset progress revives gems in the persistent native world state");
  const borderRooms = Object.fromEntries(["level_AxA", "level_BxA"].map(levelId => [levelId, {
    ...rooms.level_AxA, levelId, worldLevelIds: ["level_AxA", "level_BxA"],
    terrain: [[0, 1, 2].map(() => ({ type: "floor", layers: [{ type: "floor", elevation: 0 }] }))],
    actors: levelId === "level_AxA" ? [{type:"player",x:2,y:0,elevation:0}] : []
  }]));
  const border = runtime(borderRooms.level_AxA);
  Object.values(borderRooms).forEach(room => border.rememberHorizontalNeighborLevelState(room));
  const borderFrames = [];
  border.renderOncePerFrame = () => {
    const action = border.worldActionAnimation;
    borderFrames.push({ elapsed: action.elapsedMs, player: action.currentPoint.x, camera: action.cameraPoint.x });
  };
  border.movePlayers(1,0);
  for (let i=0;i<100&&border.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(border.worldActionAnimation.timeline.motionEndMs, border.MOVE_DURATION_MS);
  assert.equal(border.worldActionAnimation.timeline.cameraDurationMs, border.LEVEL_TRANSITION_DURATION_MS);
  drainUntil(() => !border.isAnimating);
  const handedOff = borderFrames.find(frame => frame.elapsed >= border.MOVE_DURATION_MS);
  assert.equal(handedOff.player,3,"the player completes an ordinary border step in98ms");
  assert.ok(handedOff.camera > 1.5 && handedOff.camera < 4.5,"the camera continues its full v1 room transition after the player arrives");
  const cameraFraction = handedOff.elapsed / border.LEVEL_TRANSITION_DURATION_MS;
  assert.ok(Math.abs(handedOff.camera - (1.5 + 3 * cameraFraction ** 3 * (cameraFraction * (cameraFraction * 6 - 15) + 10))) < 1e-8,"ordinary room camera uses canonical smootherStep easing");
  const turnData = { ...fixture(), width:7, height:7,
    terrain:Array.from({length:7},()=>Array.from({length:7},()=>({type:"floor",layers:[{type:"floor",elevation:0}]}))),
    actors:[{type:"player",x:1,y:3,elevation:0},{type:"puncher",x:2,y:3,elevation:0,direction:"up"}] };
  const turn = runtime(turnData), turnFrames = [];
  turn.renderOncePerFrame = () => turnFrames.push({...turn.worldActionAnimation.currentPoint});
  turn.movePlayers(1,0);
  for(let i=0;i<100&&turn.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  const turnSegments = turn.worldActionAnimation.timeline.segments.filter(segment => segment.key !== "stationary");
  assert.equal(turnSegments.length,2,"a native 90-degree punch preserves the corner instead of smoothing diagonally across it");
  assert.equal(turnSegments[0].durationMs,turn.MOVE_DURATION_MS);
  assert.equal(turnSegments[0].continuous,false,"the initial approach keeps normal v1 easing");
  assert.equal(turnSegments[1].continuous,true,"the resulting straight punch flight keeps one continuous tween");
  drainUntil(()=>!turn.isAnimating);
  assert.ok(turnFrames.every(point=>point.y===3||point.x===2),"the rendered player always remains on the authoritative L-shaped native path");
  assert.equal(turn.state.actors[0].x,2); assert.equal(turn.state.actors[0].y,0);
  const gravityRooms = Object.fromEntries(["level_AxA", "level_BxA"].map(levelId => [levelId, {
    engineVersion: "v1.1", gameId: "maze", levelId, width: 3, height: 3,
    worldColumns: ["A", "B"], worldRows: ["A"], worldLevelIds: ["level_AxA", "level_BxA"],
    terrain: Array.from({length:3},()=>Array.from({length:3},()=>({type:"floor",layers:[{type:"floor",elevation:0}]}))),
    actors: levelId === "level_AxA" ? [{type:"player",x:1,y:0,elevation:0}] : [{type:"box",x:2,y:2,elevation:2}]
  }]));
  const gravity = runtime(gravityRooms.level_AxA);
  for (const room of Object.values(gravityRooms)) gravity.rememberHorizontalNeighborLevelState(room);
  gravity.movePlayers(1,0);
  for (let i=0;i<100&&gravity.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  drainUntil(()=>!gravity.isAnimating);
  assert.equal(gravity.v11WorldRooms.level_BxA.actors[0].elevation,0);
  gravity.undoMove({instantRestore:true});
  assert.equal(gravity.v11WorldRooms.level_BxA.actors[0].elevation,2,"first-command undo restores newly discovered remote physical state");
  assert.equal(gravity.cachedHorizontalNeighborLevelState("level_BxA").actors[0].elevation,2,"neighbor rendering restores the same remote physical state");
  const freshReset = runtime(rooms.level_AxA);
  for (const room of Object.values(rooms)) freshReset.rememberHorizontalNeighborLevelState(room);
  freshReset.movePlayers(1,0);
  for(let i=0;i<100&&freshReset.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  drainUntil(()=>!freshReset.isAnimating);
  assert.equal(freshReset.collectedGemIds.size,1);
  freshReset.resetCollectionProgress();
  assert.equal(freshReset.v11WorldRooms.level_CxA.actors.find(a=>a.type==="gem").removed,false,"first native collection also resets before another command normalizes flags");
  const renderFailure = runtime(rooms.level_AxA);
  for (const room of Object.values(rooms)) renderFailure.rememberHorizontalNeighborLevelState(room);
  let errors = 0;
  renderFailure.onEngineError = () => { errors++; };
  renderFailure.renderOncePerFrame = () => { throw new Error("injected render failure"); };
  renderFailure.movePlayers(1,0);
  for(let i=0;i<100&&renderFailure.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  const originalError = console.error; console.error=()=>{};
  try { drainUntil(()=>!renderFailure.isAnimating); } finally { console.error=originalError; }
  assert.equal(errors,1);
  assert.equal(renderFailure.currentLevelId,"level_CxA","render failure still commits authoritative completed physics");
  assert.equal(renderFailure.state.actors.find(a=>a.type==="player").x,1);
  assert.equal(renderFailure.collectedGemIds.size,1);
  assert.equal(renderFailure.moveHistory.length,1);
  const pitData = fixture(); pitData.autoUndoPlayerFalls = true;
  pitData.actors = [{type:"player",x:1,y:1,elevation:0}];
  pitData.terrain[1][2] = {type:"hole",layers:[]};
  const pitFailure = runtime(pitData);
  let pitErrorCount=0, pitUndoCount=0, sawReviveBlink=false;
  pitFailure.render=()=>{ if (!pitFailure.state.actors[0].removed && pitFailure.state.actors[0].renderAlpha === 0) sawReviveBlink=true; };
  pitFailure.onModernWorldCommand=plan=>{ assert.deepEqual(plan.visitedLevelIds, [], "a terminal fall never unlocks its destination room"); throw new Error("injected completion callback failure"); };
  pitFailure.onPlayerPitAutoUndo=()=>{pitUndoCount++;throw new Error("injected pit notification failure");};
  pitFailure.onEngineError=()=>{pitErrorCount++;};
  pitFailure.movePlayers(1,0);
  for(let i=0;i<100&&pitFailure.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  console.error=()=>{};
  try { drainUntil(()=>!pitFailure.isAnimating); } finally { console.error=originalError; }
  assert.equal(pitErrorCount,1);
  assert.equal(pitUndoCount,1);
  assert.equal(pitFailure.state.actors[0].removed,false,"host callback errors never skip authoritative pit auto-undo");
  assert.equal(pitFailure.state.actors[0].x,1);
  assert.equal(pitFailure.moveHistory.length,0);
  assert.equal(sawReviveBlink,true,"native death uses the same one-blink revive even after a host callback fails");
  assert.equal(pitFailure.state.actors[0].renderAlpha,1);
  const blinkFailure = runtime(pitData);
  let blinkErrors = 0;
  blinkFailure.onEngineError = () => { blinkErrors++; };
  blinkFailure.render = () => {
    if (blinkFailure.state.actors[0].renderAlpha === 0) throw new Error("injected hidden revive-frame render failure");
  };
  blinkFailure.movePlayers(1,0);
  for(let i=0;i<100&&blinkFailure.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  console.error=()=>{};
  try { drainUntil(()=>!blinkFailure.isAnimating); } finally { console.error=originalError; }
  assert.equal(blinkErrors,1,"errors in the separate revive RAF are reported");
  assert.equal(blinkFailure.state.actors[0].removed,false);
  assert.equal(blinkFailure.state.actors[0].renderAlpha,1,"revive render failure never leaves an invisible player");
  assert.equal(blinkFailure.state.actors[0].renderScale,1);
  assert.equal(blinkFailure.moveHistory.length,0);
  assert.equal(blinkFailure.animationFrameId,null);
  blinkFailure.movePlayers(0,-1);
  for(let i=0;i<100&&blinkFailure.isPlanningWorldAction;i++) await new Promise(resolve=>setImmediate(resolve));
  drainUntil(()=>!blinkFailure.isAnimating);
  assert.equal(blinkFailure.state.actors[0].y,0,"the next input remains playable after revive rendering recovers");
  const resumeSource = runtime(rooms.level_AxA);
  for(const room of Object.values(rooms)) resumeSource.rememberHorizontalNeighborLevelState(room);
  await resumeSource.replaySavedAction({command:"move",direction:"right"},{worldDirections:true});
  assert.equal(resumeSource.currentLevelId,"level_CxA");
  assert.equal(resumeSource.isAnimating,false);
  const nativeSnapshot = JSON.parse(JSON.stringify(resumeSource.exportResumeState()));
  const resumed = runtime(rooms.level_AxA);
  await resumed.restoreResumeState(nativeSnapshot);
  assert.equal(resumed.currentLevelId,"level_CxA");
  assert.equal(resumed.state.actors.find(a=>a.type==="player").x,1);
  assert.equal(resumed.collectedGemIds.size,1);
  assert.equal(resumed.state.actors.find(a=>a.type==="gem").showCollectedGhost,false,"exact resume retains hidden gems from the current visit");
  assert.equal(resumed.state.actors.find(a=>a.type==="gem").renderAlpha,0);
  assert.equal(resumed.moveHistory.length,1,"exact resume preserves cross-room undo history");
  await resumed.replaySavedAction({command:"undo"});
  assert.equal(resumed.currentLevelId,"level_AxA");
  assert.equal(resumed.state.actors[0].x,0);
  assert.equal(resumed.collectedGemIds.size,1);
  await resumed.replaySavedAction({command:"move",dx:1,dy:0});
  assert.equal(resumed.currentLevelId,"level_CxA");
  assert.equal(resumed.collectedGemIds.size,1);
  const revisitedResume = runtime(rooms.level_AxA);
  await revisitedResume.restoreResumeState(JSON.parse(JSON.stringify(resumed.exportResumeState())));
  assert.equal(revisitedResume.state.actors.find(a=>a.type==="gem").showCollectedGhost,true,"exact resume also retains ghosts after an actual room revisit");
  const gemUndoData = fixture();
  gemUndoData.actors = [{type:"player",x:1,y:1,elevation:0},{type:"gem",x:2,y:1,elevation:0}];
  const gemUndo = runtime(gemUndoData);
  await gemUndo.replaySavedAction({command:"move",dx:1,dy:0});
  await gemUndo.replaySavedAction({command:"undo"});
  assert.equal(gemUndo.collectedGemIds.size,1);
  assert.equal(gemUndo.state.actors[1].removed,true);
  assert.equal(gemUndo.state.actors[1].showCollectedGhost,false,"undoing within the same room is not a revisit that reveals a collected gem");
  assert.equal(gemUndo.state.actors[1].renderAlpha,0);
  const legacyResumeData = fixture(); legacyResumeData.engineVersion="v1";
  const legacySource=runtime(legacyResumeData);
  await legacySource.replaySavedAction({command:"move",dx:1,dy:0});
  await legacySource.replaySavedAction({command:"move",dx:1,dy:0});
  const legacySnapshot=JSON.parse(JSON.stringify(legacySource.exportResumeState()));
  const legacyRestored=runtime(legacyResumeData);
  await legacyRestored.restoreResumeState(legacySnapshot);
  assert.equal(legacyRestored.state.actors[0].x,3);
  assert.equal(legacyRestored.state.actors[1].x,4,"v1 resume restores moved boxes exactly");
  for (const engineVersion of ["v1", "v1.1"]) {
    frames.clear();
    const resumeData = { ...fixture(), engineVersion };
    const source = runtime(resumeData);
    source.state.actors[1].x = 5;
    source.threeRenderer = { getDebugCameraYaw: () => Math.PI / 2, getDebugCameraTilt: () => 0.9, getDebugCameraZoom: () => 1 };
    const snapshot = JSON.parse(JSON.stringify(source.exportResumeState()));
    const target = runtime(resumeData), painted = [];
    let camera = { yaw: 0, tilt: 0.22, zoom: 1 };
    target.threeRenderer = { getDebugCameraYaw: () => camera.yaw, getDebugCameraTilt: () => camera.tilt,
      getDebugCameraZoom: () => camera.zoom, setDebugCameraView: view => { camera = { ...camera, ...view }; } };
    target.render = target.renderOncePerFrame = () => painted.push({ x: target.state.actors[1].renderX, yaw: camera.yaw });
    let done = false;
    const restore = target.restoreResumeState(snapshot, { animate: true, beforeReveal: async () => {
      target.state.actors[1].x = target.state.actors[1].renderX = 6;
      target.render();
    } }).then(() => { done = true; });
    for (let tick = 0; tick < 100 && !done; tick++) {
      await Promise.resolve();
      const pending = frames.entries().next().value;
      if (pending) { frames.delete(pending[0]); pending[1](tick * 50); }
    }
    await restore;
    assert.equal(painted[0].x, 3, `${engineVersion}: snapshot and offline tail never paint before the tween`);
    assert.equal(painted[0].yaw, 0);
    assert.ok(painted.some(frame => frame.x > 3 && frame.x < 6 && frame.yaw > 0 && frame.yaw < Math.PI / 2));
    assert.equal(target.state.actors[1].x, 6);
    assert.equal(painted.at(-1).x, 6);
    assert.equal(painted.at(-1).yaw, Math.PI / 2);
    assert.equal(target.isAnimating, false);
  }
  await legacyRestored.replaySavedAction({command:"undo"});
  assert.equal(legacyRestored.state.actors[0].x,2);
  assert.equal(legacyRestored.state.actors[1].x,3);
  await assert.rejects(()=>legacyRestored.restoreResumeState(nativeSnapshot),/different engine/);
  const invalid=JSON.parse(JSON.stringify(legacySnapshot)); invalid.root={r:invalid.nodes.length};
  await assert.rejects(()=>legacyRestored.restoreResumeState(invalid),/invalid reference/);
  assert.equal(legacyRestored.state.actors[0].x,2,"failed restore leaves the live board untouched");
  const legacyRooms=Object.fromEntries(["level_AxA","level_BxA"].map(levelId=>[levelId,{
    engineVersion:"v1",gameId:"maze",levelId,width:2,height:1,worldColumns:["A","B"],worldRows:["A"],
    terrain:[[{type:"floor"},{type:"floor"}]],actors:[{type:"player",x:0,y:0,elevation:0}]
  }]));
  const legacyWorld=runtime(legacyRooms.level_AxA);
  for(const room of Object.values(legacyRooms)) legacyWorld.rememberHorizontalNeighborLevelState(room);
  legacyWorld.loadLevelState=async id=>legacyRooms[id];
  await legacyWorld.replaySavedAction({command:"move",dx:1,dy:0});
  await legacyWorld.replaySavedAction({command:"move",dx:1,dy:0});
  assert.equal(legacyWorld.currentLevelId,"level_BxA","legacy instant tail replay includes room crossing");
  assert.equal(legacyWorld.state.actors[0].x,0);
  await legacyWorld.replaySavedAction({command:"undo"});
  assert.equal(legacyWorld.currentLevelId,"level_AxA");
  assert.equal(legacyWorld.state.actors[0].x,1);
  const legacyIce=JSON.parse(JSON.stringify(rooms));
  for(const room of Object.values(legacyIce)) {
    room.engineVersion="v1";
    if(!room.actors.some(a=>a.type==="player")) room.actors.push({type:"player",x:0,y:0,elevation:0});
  }
  const legacyIceApp=runtime(legacyIce.level_AxA);
  for(const room of Object.values(legacyIce)) legacyIceApp.rememberHorizontalNeighborLevelState(room);
  legacyIceApp.loadLevelState=async id=>legacyIce[id];
  await legacyIceApp.replaySavedAction({command:"move",dx:1,dy:0});
  assert.equal(legacyIceApp.currentLevelId,"level_CxA","legacy instant replay preserves forced motion across several rooms");
  assert.equal(legacyIceApp.state.actors.find(a=>a.type==="player").x,1);
  const legacyPit=runtime({...pitData,engineVersion:"v1"});
  await legacyPit.replaySavedAction({command:"move",dx:1,dy:0});
  assert.equal(legacyPit.state.actors[0].removed,false);
  assert.equal(legacyPit.state.actors[0].x,1,"legacy instant replay completes automatic pit undo without RAF");
  const {getGame,getLevelState}=require("../server/app");
  const official=getGame("maze");
  const fullWorld=Object.fromEntries(official.worldMap.levels.map(level=>{const data=getLevelState(official,level);return [data.levelId,data];}));
  const officialState=runtime({...Object.values(fullWorld).find(r=>r.actors.some(a=>a.type==="player")),engineVersion:"v1.1"});
  officialState.v11WorldRooms=fullWorld;
  const wholeWorldSnapshot=officialState.exportResumeState();
  assert.ok(JSON.stringify(wholeWorldSnapshot).length<16*1024*1024,"all256 official rooms fit in the exact save envelope");
  const gzipSize=require("node:zlib").gzipSync(JSON.stringify(wholeWorldSnapshot)).length;
  assert.ok(gzipSize<512*1024);
  console.log(`Official world exact save: ${JSON.stringify(wholeWorldSnapshot).length} bytes before gzip; ${gzipSize} bytes compressed.`);
  console.log("Versioned browser runtime parity, animation, and undo tests passed.");
})().catch(error=>{console.error(error);process.exitCode=1;});
