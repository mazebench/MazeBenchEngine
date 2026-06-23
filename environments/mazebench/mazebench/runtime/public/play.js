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

  function ensureEdgeToggle() {
    const existing = document.getElementById("edge-toggle");

    if (existing) {
      return existing;
    }

    const fuzzyToggle = document.getElementById("fuzzy-toggle");

    if (!fuzzyToggle || !fuzzyToggle.parentNode) {
      return null;
    }

    const edgeToggle = document.createElement("button");
    edgeToggle.id = "edge-toggle";
    edgeToggle.className = "effect-toggle is-active";
    edgeToggle.type = "button";
    edgeToggle.setAttribute("aria-pressed", "true");
    edgeToggle.setAttribute("aria-label", "Black edges");
    edgeToggle.title = "Black edges";
    edgeToggle.innerHTML = [
      '<span class="effect-icon effect-icon--edges" aria-hidden="true"></span>',
      '<span class="effect-toggle-track" aria-hidden="true">',
      '<span class="effect-toggle-thumb"></span>',
      "</span>"
    ].join("");
    fuzzyToggle.parentNode.insertBefore(edgeToggle, fuzzyToggle);
    return edgeToggle;
  }

  function ensureResetProgressButton() {
    const existing = document.getElementById("reset-progress");

    if (existing) {
      existing.disabled = false;
      return existing;
    }

    const headerMeta = document.querySelector(".play-header-meta");

    if (!headerMeta) {
      return null;
    }

    const resetProgressButton = document.createElement("button");
    resetProgressButton.id = "reset-progress";
    resetProgressButton.className = "progress-reset-button";
    resetProgressButton.type = "button";
    resetProgressButton.textContent = "Reset Progress";
    resetProgressButton.title = "Reset collected gems";

    const cameraModeToggle = document.getElementById("camera-mode-toggle");
    headerMeta.insertBefore(resetProgressButton, cameraModeToggle || headerMeta.firstChild);
    return resetProgressButton;
  }

  const edgeToggle = ensureEdgeToggle();
  const resetProgressButton = ensureResetProgressButton();
  const app = modules.createPlayCore({
    playData,
    canvas,
    playShell: document.querySelector(".play-shell"),
    playHeader: document.querySelector(".play-header"),
    playStage: document.querySelector(".play-stage"),
    mazeFrame: document.querySelector(".maze-frame"),
    fuzzyToggle: document.getElementById("fuzzy-toggle"),
    edgeToggle,
    cameraModeToggle: document.getElementById("camera-mode-toggle"),
    resetProgressButton,
    enableCameraControls: true
  });

  if (!app) {
    return;
  }

  if (window.__PIXEL_GAME_DEBUG__ === true) {
    window.__PIXEL_GAME_APP__ = app;
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

  if (app.edgeToggle && app.edgeToggle.dataset.edgeToggleBound !== "true") {
    app.edgeToggle.dataset.edgeToggleBound = "true";
    app.edgeToggle.addEventListener("click", function () {
      app.state.effects.edgeOutlinesEnabled = !app.state.effects.edgeOutlinesEnabled;
      app.syncEdgeToggle();
      app.render();
    });
  }

  if (app.resetProgressButton) {
    app.resetProgressButton.addEventListener("click", function () {
      app.resetCollectionProgress();
    });
  }

  app.syncPlayLayout();
  app.setupCanvas();
  app.syncCameraTarget(true);
  app.syncFuzzyToggle();
  app.syncEdgeToggle();
  app.syncResetProgressButton();
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
