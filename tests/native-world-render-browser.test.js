const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const os = require("node:os");
const { createRenderSession, closeRenderSession } = require("../scripts/maze-render-frame");

const root = path.resolve(__dirname, "..");
const browsers = ["Google Chrome", "Brave Browser", "Chromium", "Microsoft Edge"];
const browserAvailable = browsers.some((name) => fs.existsSync(`/Applications/${name}.app/Contents/MacOS/${name}`)) ||
  fs.existsSync("/ms-playwright") || Boolean(process.env.PLAYWRIGHT_BROWSERS_PATH);
const skip = !fs.existsSync(path.join(root, "node_modules/playwright-core")) ? "playwright-core is not installed" :
  !browserAvailable ? "no Chromium-family browser is installed" : false;

function fixture() {
  const columns = ["A", "B", "C", "D", "E", "F", "G"];
  const ids = columns.map((column) => `level_${column}xA`);
  const rooms = Object.fromEntries(ids.map((levelId) => [levelId, {
    gameId: "maze", levelId, engineVersion: "v1.1", width: 4, height: 3,
    worldColumns: columns, worldRows: ["A"], worldLevelIds: ids,
    disableHorizontalNeighborFetches: true,
    terrain: Array.from({ length: 3 }, (_, y) => Array.from({ length: 4 }, () => ({
      type: y === 1 ? "ice" : "floor", layers: [{ type: y === 1 ? "ice" : "floor", elevation: 0 }]
    }))), actors: []
  }]));
  for (const [id, x] of [["level_DxA", 0], ["level_FxA", 1]]) {
    rooms[id].terrain[1][x] = { type: "floor", layers: [{ type: "floor", elevation: 0 }] };
  }
  const gem = (x, y) => ({ type: "gem", x, y, elevation: 0, modelUrl: "/assets/maze/assets_3d/gem.glb" });
  rooms.level_DxA.actors = [{ type: "player", x: 0, y: 1, elevation: 0 }, gem(2, 2)];
  rooms.level_ExA.actors = [gem(1, 1)];
  // Native physics collects at the settled stop; the gem on E's ice remains.
  // Hydrated neighbors have renderX/Y at this authored spawn. The native
  // transfer must render the actual endpoint instead when the command settles.
  rooms.level_FxA.actors = [{ type: "player", x: 3, y: 2, elevation: 0 }, gem(1, 1), gem(2, 2)];
  return rooms;
}

test("real Three scene retains distant rooms and gem phase through a native ice command and camera rotation", { skip, timeout: 90000 }, async () => {
  const session = await createRenderSession({ actions: [], gameId: "maze", levelId: "level_HxI", width: 192, height: 192, view: 6, draft: true, fast: false });
  const errors = [];
  session.page.on("pageerror", (error) => errors.push(error.message));
  session.page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const rooms = fixture();
  try {
    await session.page.route("**/play/maze/**", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace(
        /<script>window\.__PLAY_DATA__ = [\s\S]*?<\/script>/,
        `<script>window.__PLAY_DATA__ = ${JSON.stringify(rooms.level_DxA)};</script>`
      ) });
    });
    await session.page.reload({ waitUntil: "domcontentloaded" });
    await session.page.waitForFunction(() => window.__PIXEL_GAME_APP__?.engineVersion === "v1.1" && window.MazeEngineVersions?.isReady("v1.1") && window.__PIXEL_GAME_APP__.threeRenderer?.isReady());
    await session.page.evaluate(async (rooms) => {
      const app = window.__PIXEL_GAME_APP__;
      for (const room of Object.values(rooms)) app.rememberHorizontalNeighborLevelState(room);
      await app.threeRenderer.requireLevelStatesModelsReady(Object.values(rooms));
      const THREE = await import("/vendor/three.module.js");
      const scenes = new Set();
      const originalAdd = THREE.Object3D.prototype.add;
      THREE.Object3D.prototype.add = function (...children) {
        if (this.isScene) scenes.add(this);
        return originalAdd.apply(this, children);
      };
      // Control only frame delivery. These are real production gameplay/WASM,
      // GLB meshes, Three scenes, WebGL draws and camera transforms.
      const frames = new Map();
      let frameId = 100000;
      for (const key of ["animationFrameId", "cameraFrameId", "floatingFloorFrameId", "gateAnimationFrameId", "levelTransitionFrameId", "noiseFrameId", "orangeWallAnimationFrameId", "playerLiftAnimationFrameId"]) {
        if (app[key] != null) window.cancelAnimationFrame(app[key]);
        app[key] = null;
      }
      window.requestAnimationFrame = (callback) => { const id = ++frameId; frames.set(id, callback); return id; };
      window.cancelAnimationFrame = (id) => frames.delete(id);
      app.autoUndoPlayerFalls = false;
      app.playSurroundingRadius = 6;
      app.state.effects.fuzzyEnabled = false;
      app.worldViewSynchronousBuild = true;
      app.threeRenderer.invalidateSceneCache();
      app.threeRenderer.renderScene(performance.now());
      const scene = [...scenes].find((entry) => entry.background);
      if (!scene) throw new Error("Did not capture the actual Three scene");
      const farGroup = () => {
        // Composed native grids normalize their origin to the loaded bounds.
        const origin = app.worldActionAnimation?.rooms.find((room) => room.levelId === "level_DxA")?.offset.x || 0;
        const farX = (origin - 3 * 4) * app.TILE_SIZE;
        return scene.children.find((object) => object.isGroup && !object.userData.gemSpinGroup && Math.abs(object.position.x - farX) < 0.001);
      };
      if (!farGroup()) throw new Error("Distant room must be attached before movement");
      const samples = [];
      const draw = app.threeRenderer.renderScene;
      app.threeRenderer.renderScene = (now) => {
        const start = performance.now();
        const result = draw(now);
        const action = app.worldActionAnimation;
        if (action) {
          const current = action.rooms.find((room) => action.currentPoint.x + 0.5 >= room.offset.x && action.currentPoint.x + 0.5 < room.offset.x + room.levelState.width);
          const gem = current?.levelState.actors.find((actor) => actor.type === "gem" && actor.y === 2 && !actor.removed);
          const group = gem && scene.children.find((object) => object.userData.gemSpinGroup && Math.abs(object.position.x - (current.offset.x + gem.x + 0.5) * app.TILE_SIZE) < 0.001);
          const far = farGroup();
          const materials = [];
          far?.traverse((object) => { if (object.isMesh) materials.push({ opacity: object.material.opacity, color: object.material.color?.getHex() }); });
          samples.push({ now, x: action.currentPoint.x, room: current?.levelId, farId: far?.uuid, farParent: far?.parent === scene,
            farMaterials: materials, gemSpin: group?.rotation.y, gemSeed: gem?.hoverSeed,
            yaw: app.threeRenderer.getDebugCameraYaw(), drawMs: performance.now() - start,
            stats: app.threeRenderer.getRenderStats() });
        }
        return result;
      };
      app.worldViewSynchronousBuild = false;
      function settledPlayerPose() {
        const actor = app.state.actors.find(actor => app.isMainPlayerActor(actor) && !actor.removed);
        const bodies = [];
        scene.traverse(object => {
          if (!object.isMesh || object.material?.color?.getHex() !== 0x5aa95c || object.userData.editorPick?.kind !== "actor") return;
          const bounds = new THREE.Box3().setFromObject(object), center = bounds.getCenter(new THREE.Vector3());
          bodies.push({x:center.x / app.TILE_SIZE - 0.5,y:center.z / app.TILE_SIZE - 0.5,elevation:bounds.max.y / app.TILE_SIZE - 1});
        });
        return {logical:[actor.x,actor.y,actor.elevation],render:[actor.renderX,actor.renderY,actor.renderElevation],bodies};
      }
      window.__nativeRenderTest = { frames, samples, scene, farGroup, settledPlayerPose, now: performance.now() };
      app.movePlayers(1, 0);
    }, rooms);
    await session.page.waitForFunction(() => !window.__PIXEL_GAME_APP__.isPlanningWorldAction);
    const result = await session.page.evaluate(() => {
      const app = window.__PIXEL_GAME_APP__, test = window.__nativeRenderTest;
      for (let index = 0; index < 200 && app.isAnimating; index++) {
        const id = app.animationFrameId;
        const callback = test.frames.get(id);
        if (!callback) throw new Error(`Missing native animation frame ${id}`);
        test.frames.delete(id);
        test.now += 16;
        app.threeRenderer.setDebugCameraView({ yaw: index * 0.006, tilt: 0.75, zoom: 0.7, preserveSceneCache: true, skipResize: true, skipRender: true });
        callback(test.now);
      }
      return { samples: test.samples, isAnimating: app.isAnimating, error: app.engineLoadError?.message || null,
        engine: app.engineVersion, levelId: app.currentLevelId,
        player: app.state.actors.find((actor) => app.isMainPlayerActor(actor) && !actor.removed),
        settledPose: test.settledPlayerPose(),
        collected: app.collectedGemIds.size,
        pixels: app.sceneCanvas.getContext("2d").getImageData(0, 0, app.sceneCanvas.width, app.sceneCanvas.height).data.filter((byte, index) => index % 4 !== 3 && byte > 20).length };
    });
    assert.deepEqual(errors, []);
    assert.equal(result.error, null);
    assert.equal(result.engine, "v1.1");
    assert.equal(result.isAnimating, false);
    assert.equal(result.levelId, "level_FxA");
    assert.equal(result.player.x, 1);
    const assertSettledPlayerPose = (pose) => {
      assert.deepEqual(pose.render,pose.logical,"settled runtime render pose matches the native endpoint");
      assert.equal(pose.bodies.length,1,"the real Three scene has one active player body");
      const body=pose.bodies[0];
      [body.x,body.y,body.elevation].forEach((value,index)=>assert.ok(Math.abs(value-pose.logical[index])<0.001,"the real player mesh settles at physics coordinates, not the authored spawn"));
    };
    assertSettledPlayerPose(result.settledPose);
    assert.equal(result.collected, 1);
    assert.ok(result.samples.length >= 8, "sample multiple real rendered tween frames");
    assert.ok(result.pixels > 100, "the actual canvas contains rendered geometry");
    const farIds = new Set();
    for (const sample of result.samples) {
      assert.ok(sample.farId && sample.farParent, `distant room stays attached at x=${sample.x}`);
      farIds.add(sample.farId);
      assert.ok(sample.farMaterials.some((material) => material.opacity > 0 && material.color > 0), "far room materials remain visible");
      assert.ok(sample.stats.triangles > 0 && sample.stats.calls > 0, "Three issued real geometry draws");
      if (sample.gemSpin !== undefined) assert.ok(Math.abs(sample.gemSpin - ((sample.now % 7200) / 7200 * Math.PI * 2 + sample.gemSeed)) < 1e-9, "gem mesh keeps its exact clock and seed during movement");
    }
    assert.ok(result.samples.filter((sample) => sample.gemSpin !== undefined).length >= 3);
    assert.equal(farIds.size, 1, "the same far room mesh survives every movement and camera frame");
    assert.ok(result.samples.at(-1).yaw > result.samples[0].yaw, "camera rotated while the native command animated");
    const collectedVisual = () => {
      const app = window.__PIXEL_GAME_APP__, test = window.__nativeRenderTest;
      const actor = app.state.actors.find((actor) => actor.type === "gem" && actor.x === 1 && actor.y === 1);
      const group = test.scene.children.find((object) => object.userData.gemSpinGroup && Math.abs(object.position.x - 1.5 * app.TILE_SIZE) < 0.001 && Math.abs(object.position.z - 1.5 * app.TILE_SIZE) < 0.001);
      return { collected: actor.collected, ghost: actor.showCollectedGhost, alpha: actor.renderAlpha, meshOpacity: group?.children[0]?.material?.opacity };
    };
    assert.deepEqual(await session.page.evaluate(collectedVisual), { collected: true, ghost: false, alpha: 0, meshOpacity: undefined });
    const captures = [];
    for (const dx of [-1, 1]) {
      await session.page.evaluate((dx) => window.__PIXEL_GAME_APP__.movePlayers(dx, 0), dx);
      await session.page.waitForFunction(() => !window.__PIXEL_GAME_APP__.isPlanningWorldAction);
      captures.push(...await session.page.evaluate(() => {
        const app = window.__PIXEL_GAME_APP__, test = window.__nativeRenderTest, images = [];
        for (let index = 0; index < 200 && app.isAnimating; index++) {
          const id = app.animationFrameId, callback = test.frames.get(id);
          if (!callback) throw new Error(`Missing native return frame ${id}`);
          test.frames.delete(id);
          test.now += 16;
          callback(test.now);
          if (index === 0 || index === 16) images.push(app.sceneCanvas.toDataURL("image/png"));
        }
        if (app.engineLoadError || app.isAnimating) throw app.engineLoadError || new Error("Native return animation did not finish");
        images.push(app.sceneCanvas.toDataURL("image/png"));
        return images;
      }));
      assertSettledPlayerPose(await session.page.evaluate(()=>window.__nativeRenderTest.settledPlayerPose()));
    }
    assert.deepEqual(await session.page.evaluate(collectedVisual), { collected: true, ghost: true, alpha: 0.5, meshOpacity: 0.5 });
    assert.deepEqual(errors, []);
    const captureDir = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-native-render-"));
    captures.forEach((data, index) => fs.writeFileSync(path.join(captureDir, `frame-${index}.png`), Buffer.from(data.split(",")[1], "base64")));
    const times = result.samples.map((sample) => sample.drawMs).sort((a, b) => a - b);
    console.log(`native real scene: ${result.samples.length} frames, ${farIds.size} far mesh, draw median ${times[Math.floor(times.length / 2)].toFixed(1)}ms, max ${times.at(-1).toFixed(1)}ms; return/revisit frames: ${captureDir}`);
  } finally {
    await closeRenderSession(session);
  }
});
