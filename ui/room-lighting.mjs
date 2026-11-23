import * as THREE from "../render/vendor/three.module.min.js";

const ease = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// Room brightness is sampled in world space, so a joined surface can span a
// room border without splitting its geometry, outline, or material there.
export class RoomLighting {
  constructor(world) {
    this.columns = world.columns.length;
    this.rows = world.rows.length;
    this.values = new Float32Array(this.columns * this.rows);
    this.pixels = new Uint8Array(this.values.length * 4);
    this.texture = new THREE.DataTexture(this.pixels, this.columns, this.rows);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.uniforms = {
      mazeRoomLight: { value: this.texture },
      mazeWorldSize: { value: new THREE.Vector2(this.columns * world.roomWidth, this.rows * world.roomHeight) }
    };
    this.materials = new Map();
    this.select(world.contextActiveRoom);
  }

  index(room) { return room.rowIndex * this.columns + room.columnIndex; }

  upload() {
    let changed = false;
    for (let i = 0; i < this.values.length; i++) {
      const value = Math.round(this.values[i] * 255);
      if (this.pixels[i * 4] !== value) { this.pixels[i * 4] = value; changed = true; }
    }
    if (changed) this.texture.needsUpdate = true;
  }

  select(room, duration = 0, now = performance.now()) {
    this.update(now);
    const target = new Float32Array(this.values.length);
    target[this.index(room)] = 1;
    if (duration) this.transition = { from: this.values.slice(), to: target, start: now, duration };
    else { this.transition = null; this.values.set(target); this.upload(); }
  }

  update(now = performance.now()) {
    const transition = this.transition;
    if (!transition) return false;
    const progress = Math.max(0, Math.min(1, (now - transition.start) / transition.duration));
    const t = ease(progress);
    for (let i = 0; i < this.values.length; i++) this.values[i] = transition.from[i] + (transition.to[i] - transition.from[i]) * t;
    this.upload();
    if (progress === 1) this.transition = null;
    return Boolean(this.transition);
  }

  setWeights(rooms, weights) {
    this.transition = null;
    this.values.fill(0);
    rooms.forEach((room, index) => { this.values[this.index(room)] = weights[index]; });
    this.upload();
  }

  decorate(material) {
    if (material.userData.mazeRoomLighting) return material;
    const compile = material.onBeforeCompile, key = material.customProgramCacheKey();
    material.onBeforeCompile = shader => {
      compile.call(material, shader);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = `varying vec2 mazeRoomPosition;\n${shader.vertexShader}`.replace("#include <project_vertex>", `
        #include <project_vertex>
        vec4 mazePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mazePosition = instanceMatrix * mazePosition;
        #endif
        mazeRoomPosition = (modelMatrix * mazePosition).xz;
      `);
      shader.fragmentShader = `uniform sampler2D mazeRoomLight;\nuniform vec2 mazeWorldSize;\nvarying vec2 mazeRoomPosition;\n${shader.fragmentShader}`
        .replace("#include <opaque_fragment>", `
          outgoingLight *= mix(0.38, 1.0, texture2D(mazeRoomLight, mazeRoomPosition / mazeWorldSize + 0.5).r);
          #include <opaque_fragment>
        `);
    };
    material.customProgramCacheKey = () => `${key}:room-lighting-v1`;
    material.userData.mazeRoomLighting = true;
    material.needsUpdate = true;
    return material;
  }

  apply(root) {
    const owned = new Set(root.userData.cutawayMaterials || []);
    root.traverse(object => {
      if (object.userData.mazeWideOutline || !object.isMesh || !object.material || object.material.colorWrite === false) return;
      const copy = source => {
        if (source.userData.mazeRoomLighting) return source;
        if (object.userData.transientMaterial || owned.has(source)) return this.decorate(source);
        if (!this.materials.has(source)) {
          const material = source.clone();
          material.onBeforeCompile = source.onBeforeCompile;
          material.customProgramCacheKey = source.customProgramCacheKey;
          this.materials.set(source, this.decorate(material));
        }
        return this.materials.get(source);
      };
      object.material = Array.isArray(object.material) ? object.material.map(copy) : copy(object.material);
    });
  }

  dispose() {
    this.texture.dispose();
    this.materials.forEach(material => material.dispose());
    this.materials.clear();
  }
}
