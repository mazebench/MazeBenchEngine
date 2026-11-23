(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderFunctions = function registerRenderFunctions(app) {
    if (typeof modules.registerRenderEffectsFunctions !== "function") {
      throw new Error("play-render-effects.js must be loaded before play-render.js");
    }

    modules.registerRenderEffectsFunctions(app);

    if (typeof modules.registerRenderTerrainFunctions !== "function") {
      throw new Error("play-render-terrain.js must be loaded before play-render.js");
    }

    modules.registerRenderTerrainFunctions(app);

    if (typeof modules.registerRenderActorFunctions !== "function") {
      throw new Error("play-render-actors.js must be loaded before play-render.js");
    }

    modules.registerRenderActorFunctions(app);

    if (typeof modules.registerThreeRenderFunctions === "function") {
      modules.registerThreeRenderFunctions(app);
    }

    if (typeof modules.registerRenderCompositorFunctions !== "function") {
      throw new Error("play-render-compositor.js must be loaded before play-render.js");
    }

    modules.registerRenderCompositorFunctions(app);

    const { syncCameraTarget, advanceCamera } = app;
    const { renderCompositor } = app;
    let lastActiveRenderNow = 0;
    let lastMeasuredFrameNow = 0;
    let lastPublishedFrameSampleCount = -1;
    const frameTimingStats = {
      samples: [],
      active: false
    };

    if (typeof window !== "undefined") {
      window.__PIXEL_GAME_FRAME_STATS__ = frameTimingStats;
    }

    function publishFrameTimingStats(force = false) {
      if (!app.canvas?.dataset) {
        return;
      }

      const samples = frameTimingStats.samples;

      if (!force && samples.length === lastPublishedFrameSampleCount) {
        return;
      }

      if (!force && samples.length % 12 !== 0) {
        return;
      }

      lastPublishedFrameSampleCount = samples.length;
      const sorted = samples.slice().sort((left, right) => left - right);
      const percentile = (value) =>
        sorted[
          Math.min(
            sorted.length - 1,
            Math.max(0, Math.floor((sorted.length - 1) * value))
          )
        ] || 0;
      const averageMs =
        samples.length > 0
          ? samples.reduce((sum, sample) => sum + sample, 0) / samples.length
          : 0;

      app.canvas.dataset.frameStats = JSON.stringify({
        active: frameTimingStats.active,
        averageFps: averageMs > 0 ? 1000 / averageMs : 0,
        averageMs,
        maxMs: samples.length > 0 ? Math.max(...samples) : 0,
        over20: samples.filter((sample) => sample > 20).length,
        over33: samples.filter((sample) => sample > 33.34).length,
        over50: samples.filter((sample) => sample > 50).length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        samples: samples.length
      });
    }

    function resetFrameTimingStats() {
      frameTimingStats.samples.length = 0;
      frameTimingStats.active = false;
      lastMeasuredFrameNow = 0;
      lastPublishedFrameSampleCount = -1;
      publishFrameTimingStats(true);
    }

    function hasActiveFrameMotion() {
      return Boolean(
        app.isAnimating ||
          app.isTransitioningLevel ||
          app.levelTransition ||
          app.cameraFrameId !== null ||
          app.gateAnimationFrameId !== null ||
          app.orangeWallAnimationFrameId !== null ||
          app.playerLiftAnimationFrameId !== null ||
          app.isFlyoverMode
      );
    }

    function recordFrameTiming(now) {
      const active = hasActiveFrameMotion();

      if (!active) {
        frameTimingStats.active = false;
        lastMeasuredFrameNow = 0;
        if (typeof window !== "undefined") {
          window.__PIXEL_GAME_FRAME_STATS__ = frameTimingStats;
        }
        publishFrameTimingStats(true);
        return;
      }

      frameTimingStats.active = true;

      if (lastMeasuredFrameNow > 0) {
        const elapsedMs = now - lastMeasuredFrameNow;

        if (elapsedMs < 250) {
          frameTimingStats.samples.push(elapsedMs);
        }
        if (frameTimingStats.samples.length > 360) {
          frameTimingStats.samples.shift();
        }
      }

      lastMeasuredFrameNow = now;

      if (typeof window !== "undefined") {
        window.__PIXEL_GAME_FRAME_STATS__ = frameTimingStats;
      }
      publishFrameTimingStats();
    }

    function syncLiveSurfaceState(now) {
      app.syncLiveRaisedSurfaces();
      app.syncGateAnimationTargets(now);
      app.syncOrangeWallAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
    }

    function normalizeRenderNow(now) {
      const nextNow = Number.isFinite(now) ? now : performance.now();
      const hasActiveMotion = Boolean(
        app.isAnimating ||
          app.isTransitioningLevel ||
          app.levelTransition ||
          app.cameraFrameId !== null ||
          app.gateAnimationFrameId !== null ||
          app.orangeWallAnimationFrameId !== null ||
          app.playerLiftAnimationFrameId !== null ||
          app.isFlyoverMode
      );

      if (!hasActiveMotion) {
        lastActiveRenderNow = 0;
        return nextNow;
      }

      lastActiveRenderNow = Math.max(lastActiveRenderNow, nextNow);
      return lastActiveRenderNow;
    }

    function render(now = performance.now()) {
      if (app.isPlanningWorldAction && !app.worldActionAnimation && !app.levelTransition) {
        return;
      }

      now = normalizeRenderNow(now);
      recordFrameTiming(now);
      syncCameraTarget();
      const isCameraActive = advanceCamera(now);
      syncLiveSurfaceState(now);
      const activeLevelTransition = renderCompositor.composeLevelTransitionSource(now);

      if (activeLevelTransition) {
        const settings = app.getEffectSettings();

        if (!app.renderWithShader(activeLevelTransition.sourceCanvas, settings)) {
          app.renderFallback(activeLevelTransition.sourceCanvas);
        }

        if (activeLevelTransition.active) {
          renderCompositor.startLevelTransitionLoop();
          return;
        }

        const onComplete = app.levelTransition?.onComplete;
        app.levelTransition = null;
        app.isTransitioningLevel = false;
        app.inputActionEndsAtMs = 0;

        if (onComplete && onComplete() === false) {
          return;
        }

        app.skipNextStaticRenderAfterTransition = true;

        if (app.queuedAction) {
          const nextAction = app.queuedAction;
          app.queuedAction = null;
          window.setTimeout(() => {
            app.runAction?.(nextAction);
          }, 0);
        }

        return;
      }

      if (
        app.skipNextStaticRenderAfterTransition &&
        !app.isAnimating &&
        !isCameraActive &&
        app.cameraFrameId === null &&
        app.gateAnimationFrameId === null &&
        app.orangeWallAnimationFrameId === null &&
        app.playerLiftAnimationFrameId === null
      ) {
        app.skipNextStaticRenderAfterTransition = false;
        return;
      }

      renderCompositor.drawScene(now);

      if (app.isFlyoverMode && app.threeRenderer?.usesDirectCanvas?.()) {
        const settings = app.getEffectSettings();
        const directCanvas = app.threeRenderer.threeCanvas;
        const usePostProcessing = app.state.effects.fuzzyEnabled === true;

        app.mazeFrame?.classList.toggle("is-flyover-postprocessed", usePostProcessing);
        app.canvas.style.display = usePostProcessing ? "block" : "none";

        if (usePostProcessing && directCanvas) {
          if (!app.renderWithShader(directCanvas, settings)) {
            app.renderFallback(directCanvas);
          }
        }

        return;
      }

      const settings = app.getEffectSettings();
      const sourceCanvas = renderCompositor.composeViewportSource();

      if (!app.renderWithShader(sourceCanvas, settings)) {
        app.renderFallback(sourceCanvas);
      }

      if (isCameraActive && !app.isAnimating) {
        app.startCameraFollowLoop();
      }
    }

    Object.assign(app, {
      render,
      resetFrameTimingStats
    });
  };
})();
