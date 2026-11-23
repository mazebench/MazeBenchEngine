// Fade pixel coverage, not surface transparency. Every face and outline uses
// the same screen-space mask, so a discarded front pixel cannot reveal a rear
// face of the same object. Kept pixels retain normal opaque depth occlusion.
export function applySolidFade(material, coverage) {
  const compile = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    compile.call(this, shader, renderer);
    shader.uniforms.mazeFadeCoverage = coverage;
    shader.fragmentShader = `uniform float mazeFadeCoverage;\n${shader.fragmentShader}`
      .replace("#include <clipping_planes_fragment>", `
        #include <clipping_planes_fragment>
        if (mazeFadeCoverage < 1.0) {
          // A stable, fine-grained mask shared by all depths and materials.
          float mazeFadeThreshold = fract(52.9829189 * fract(dot(
            floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
          if (mazeFadeThreshold >= mazeFadeCoverage) discard;
        }
      `);
  };
  material.customProgramCacheKey = () => `${key}:solid-fade-v1`;
  material.needsUpdate = true;
}
