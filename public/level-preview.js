(function () {
  const modules = window.PlayModules || {};
  const previewOutputSize = 128;

  function previewCanvasToDataUrl(canvas) {
    if (!canvas || typeof canvas.toDataURL !== "function") {
      throw new Error("Preview canvas is not available.");
    }

    return canvas.toDataURL("image/png");
  }

  function createThumbnailCanvas(sourceCanvas) {
    const thumbnailCanvas = document.createElement("canvas");
    const thumbnailContext = thumbnailCanvas.getContext("2d");

    if (!thumbnailContext) {
      throw new Error("Preview thumbnail canvas is not available.");
    }

    thumbnailCanvas.width = previewOutputSize;
    thumbnailCanvas.height = previewOutputSize;
    thumbnailContext.imageSmoothingEnabled = true;
    thumbnailContext.imageSmoothingQuality = "high";
    thumbnailContext.drawImage(sourceCanvas, 0, 0, previewOutputSize, previewOutputSize);
    return thumbnailCanvas;
  }

  async function renderPreviewDataUrl(playData) {
    if (
      typeof modules.createPlayCore !== "function" ||
      typeof modules.registerRenderFunctions !== "function"
    ) {
      throw new Error("Preview renderer modules are unavailable.");
    }

    const canvas = document.createElement("canvas");
    const app = modules.createPlayCore({
      playData,
      canvas,
      playShell: null,
      playHeader: null,
      playStage: null,
      mazeFrame: null,
      fuzzyToggle: null
    });

    if (!app) {
      throw new Error("Could not initialize the preview renderer.");
    }

    modules.registerRenderFunctions(app);
    app.setupCanvas();
    app.syncCameraTarget(true);

    const neighborRequests = Array.from(app.horizontalNeighborLevelStates.values()).filter(
      (candidate) => candidate && typeof candidate.then === "function"
    );

    if (neighborRequests.length > 0) {
      await Promise.allSettled(neighborRequests);
    }

    await app.preloadImages();
    app.render();

    if (app.gl && typeof app.gl.finish === "function") {
      app.gl.finish();
    }

    const thumbnailCanvas = createThumbnailCanvas(canvas);
    const dataUrl = previewCanvasToDataUrl(thumbnailCanvas);

    if (app.gl && typeof app.gl.getExtension === "function") {
      const loseContextExtension = app.gl.getExtension("WEBGL_lose_context");

      if (loseContextExtension && typeof loseContextExtension.loseContext === "function") {
        loseContextExtension.loseContext();
      }
    }

    canvas.width = 0;
    canvas.height = 0;
    thumbnailCanvas.width = 0;
    thumbnailCanvas.height = 0;

    return dataUrl;
  }

  async function savePreview(options) {
    const levelId = String(options?.levelId || "");
    const previewApiBaseUrl = String(options?.previewApiBaseUrl || "");

    if (!levelId || !previewApiBaseUrl) {
      throw new Error("Missing preview target.");
    }

    const imageDataUrl = await renderPreviewDataUrl(options.playData);
    const response = await fetch(
      previewApiBaseUrl + "/" + encodeURIComponent(levelId) + "/preview",
      {
        body: JSON.stringify({ imageDataUrl }),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        method: "POST"
      }
    );
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Could not save the preview.");
    }

    return payload;
  }

  window.LevelPreviewRenderer = {
    renderPreviewDataUrl,
    savePreview
  };
})();
