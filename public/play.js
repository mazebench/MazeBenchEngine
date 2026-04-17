(function () {
  const playData = window.__PLAY_DATA__;
  const canvas = document.getElementById("maze-canvas");
  const modules = window.PlayModules || {};

  if (
    !playData ||
    !canvas ||
    typeof modules.createPlayCore !== "function" ||
    typeof modules.registerRenderFunctions !== "function" ||
    typeof modules.registerGameplayFunctions !== "function"
  ) {
    return;
  }

  const app = modules.createPlayCore({
    playData,
    canvas,
    playShell: document.querySelector(".play-shell"),
    playHeader: document.querySelector(".play-header"),
    playStage: document.querySelector(".play-stage"),
    mazeFrame: document.querySelector(".maze-frame"),
    fuzzyToggle: document.getElementById("fuzzy-toggle")
  });

  if (!app) {
    return;
  }

  modules.registerRenderFunctions(app);
  modules.registerGameplayFunctions(app);

  if (app.gl) {
    app.canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      app.renderer = null;

      if (app.noiseFrameId !== null) {
        window.cancelAnimationFrame(app.noiseFrameId);
        app.noiseFrameId = null;
      }

      if (app.floatingFloorFrameId !== null) {
        window.cancelAnimationFrame(app.floatingFloorFrameId);
        app.floatingFloorFrameId = null;
      }

      if (app.playerLiftAnimationFrameId !== null) {
        window.cancelAnimationFrame(app.playerLiftAnimationFrameId);
        app.playerLiftAnimationFrameId = null;
      }

      if (app.levelTransitionFrameId !== null) {
        window.cancelAnimationFrame(app.levelTransitionFrameId);
        app.levelTransitionFrameId = null;
      }
      app.levelTransition = null;
      app.isTransitioningLevel = false;

      if (app.cameraFrameId !== null) {
        window.cancelAnimationFrame(app.cameraFrameId);
        app.cameraFrameId = null;
      }
    });

    app.canvas.addEventListener("webglcontextrestored", function () {
      app.renderer = app.initializeRenderer(app.gl);
      app.setupCanvas();
      app.syncNoiseTicker();
      app.syncFloatingFloorTicker();
      app.syncPlayerLiftAnimationTargets();
      app.syncCameraTarget(true);
      if (!app.isAnimating) {
        app.render();
      }
    });
  }

  if (app.fuzzyToggle) {
    app.fuzzyToggle.addEventListener("click", function () {
      app.state.effects.fuzzyEnabled = !app.state.effects.fuzzyEnabled;
      app.syncFuzzyToggle();
      app.syncNoiseTicker();
      app.render();
    });
  }

  app.syncPlayLayout();
  app.setupCanvas();
  app.syncCameraTarget(true);
  app.syncFuzzyToggle();
  app.syncNoiseTicker();
  app.syncFloatingFloorTicker();
  app.preloadImages().finally(app.render);
  window.addEventListener("keydown", app.handleKeydown);
  window.addEventListener("wheel", app.preventScroll, { passive: false });
  window.addEventListener("resize", function () {
    app.syncPlayLayout();
    app.setupCanvas();
    app.syncCameraTarget(true);
    app.render();
  });
})();
