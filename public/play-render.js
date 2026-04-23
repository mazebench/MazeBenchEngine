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

    if (typeof modules.registerRenderCompositorFunctions !== "function") {
      throw new Error("play-render-compositor.js must be loaded before play-render.js");
    }

    modules.registerRenderCompositorFunctions(app);

    const { syncCameraTarget, advanceCamera } = app;

    function render() {
      const now = performance.now();
      syncCameraTarget();
      const isCameraActive = advanceCamera(now);
      const activeLevelTransition = app.composeLevelTransitionSource(now);

      if (activeLevelTransition) {
        const settings = app.getEffectSettings();

        if (!app.renderWithShader(activeLevelTransition.sourceCanvas, settings)) {
          app.renderFallback(activeLevelTransition.sourceCanvas);
        }

        if (activeLevelTransition.active) {
          app.startLevelTransitionLoop();
          return;
        }

        const onComplete = app.levelTransition?.onComplete;
        app.levelTransition = null;
        app.isTransitioningLevel = false;

        if (onComplete && onComplete() === false) {
          return;
        }

        if (app.queuedAction) {
          const nextAction = app.queuedAction;
          app.queuedAction = null;
          window.setTimeout(() => {
            app.runAction?.(nextAction);
          }, 0);
        }
      }

      app.liveRaisedPlayerGates = app.gateRenderOverride || app.computeRaisedPlayerGateSet();
      app.syncGateAnimationTargets(now);
      app.syncPlayerLiftAnimationTargets(now);
      app.drawScene(now);
      const settings = app.getEffectSettings();
      const sourceCanvas = app.composeViewportSource();

      if (!app.renderWithShader(sourceCanvas, settings)) {
        app.renderFallback(sourceCanvas);
      }

      if (isCameraActive && !app.isAnimating) {
        app.startCameraFollowLoop();
      }
    }

    Object.assign(app, {
      render
    });
  };
})();
