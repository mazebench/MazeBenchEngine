(function () {
  const modules = window.PlayModules || (window.PlayModules = {});

  modules.registerRenderEffectsFunctions = function registerRenderEffectsFunctions(app) {
    const {
      state,
      canvas,
      gl,
      viewportRect,
      fallbackCtx
    } = app;
    const { clamp } = app;

    function getEffectSettings() {
      const fuzzy = state.effects.fuzzyEnabled ? app.FUZZY_AMOUNT : 0;
      const fuzzyMix = clamp(fuzzy / app.FUZZY_AMOUNT, 0, 1);

      return {
        bleed: clamp(0.78 * fuzzyMix, 0, 1),
        bloom: clamp(0.38 * fuzzyMix, 0, 1),
        softness: clamp(0.74 * fuzzyMix, 0, 1),
        scanlines: clamp(0.16 * fuzzyMix, 0, 1),
        mask: clamp(0.03 * fuzzyMix, 0, 1),
        ghosting: clamp(0.03 * fuzzyMix, 0, 1),
        noise: fuzzy,
        vignetteStrength: fuzzyMix
      };
    }

    function renderWithShader(sourceCanvas, settings) {
      const renderer = app.renderer;

      if (!gl || !renderer || (typeof gl.isContextLost === "function" && gl.isContextLost())) {
        return false;
      }

      const sourceVersion = sourceCanvas.__pixelGameTextureVersion;
      const canReuseTexture =
        sourceVersion !== undefined &&
        renderer.textureSource === sourceCanvas &&
        renderer.textureSourceWidth === sourceCanvas.width &&
        renderer.textureSourceHeight === sourceCanvas.height &&
        renderer.textureSourceVersion === sourceVersion;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.839, 0.741, 0.58, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(renderer.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, renderer.positionBuffer);
      gl.enableVertexAttribArray(renderer.attribs.position);
      gl.vertexAttribPointer(renderer.attribs.position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, renderer.texture);

      if (!canReuseTexture) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
        renderer.textureSource = sourceCanvas;
        renderer.textureSourceWidth = sourceCanvas.width;
        renderer.textureSourceHeight = sourceCanvas.height;
        renderer.textureSourceVersion = sourceVersion;
      }

      gl.uniform1i(renderer.uniforms.texture, 0);
      gl.uniform2f(renderer.uniforms.logicalResolution, sourceCanvas.width, sourceCanvas.height);
      gl.uniform1f(renderer.uniforms.bleed, settings.bleed);
      gl.uniform1f(renderer.uniforms.bloom, settings.bloom);
      gl.uniform1f(renderer.uniforms.softness, settings.softness);
      gl.uniform1f(renderer.uniforms.scanlines, settings.scanlines);
      gl.uniform1f(renderer.uniforms.mask, settings.mask);
      gl.uniform1f(renderer.uniforms.ghosting, settings.ghosting);
      gl.uniform1f(renderer.uniforms.noise, settings.noise);
      gl.uniform1f(renderer.uniforms.vignetteStrength, settings.vignetteStrength);
      gl.uniform1f(renderer.uniforms.noisePhase, state.effects.noisePhase);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
    }

    function renderFallback(sourceCanvas) {
      if (!fallbackCtx) {
        return;
      }

      fallbackCtx.clearRect(0, 0, viewportRect.width, viewportRect.height);
      fallbackCtx.imageSmoothingEnabled = false;
      fallbackCtx.drawImage(sourceCanvas, 0, 0, viewportRect.width, viewportRect.height);
    }

    Object.assign(app, {
      getEffectSettings,
      renderWithShader,
      renderFallback
    });
  };
})();
