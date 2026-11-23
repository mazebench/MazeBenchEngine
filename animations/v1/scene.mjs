import { roomBorderEdges, joinRoomBorderEdges } from "../../ui/room-border-edges.mjs";
import { isEdge } from "../../ui/thick-edges.mjs";
import * as THREE from "../../render/vendor/three.module.min.js";
import { collectVoxelSceneV2 } from "../../ui/voxel-scene.mjs";
import { addTerrainAsset } from "../../ui/asset-renderers.mjs";
import { collectAnimatedGems } from "./gems.mjs";
import { addSpecialPiece } from "../../render/v1/special-piece-renderers.mjs";
import { disposeGeneratedChildren } from "../../render/v1/polycube-mesh.mjs";
import { groupMovingTracks, sampleTrack, sampleSegments, sampleTimelinePlayer } from "./timeline.mjs";
import { applySolidFade } from "./solid-fade.mjs";
import { AnimatedWallContacts, contactShape } from "../../ui/orange-wall-contacts.mjs";
import { TruncateCaps } from "./truncate-caps.mjs";
import { ModelTruncateCaps } from "../../ui/model-truncate-caps.mjs";

const markerAxis = new THREE.Vector3(0, 0, 1);

// Build joined surfaces once, then animate transforms and the small mechanism
// meshes. Never rebuild the active room or cached world on a display frame.
function buildContent(renderer, objects, rooms = []) {
  const content = new THREE.Group();
  const data = collectVoxelSceneV2({ world: {
    ...renderer.world, rooms: [{ columnIndex: 0, rowIndex: 0, objects }]
  } });
  const dimensions = { totalWidth: renderer.totalWidth, totalHeight: renderer.totalHeight };
  renderer.addFloorGroups(data.floorGroups, content);
  const firstJoined = content.children.length;
  renderer.buildingAnimation = true;
  try { renderer.addJoinedCubes(data, content); }
  finally { renderer.buildingAnimation = false; }
  if (rooms.length && renderer.world.contextRooms) {
    const width = renderer.world.roomWidth, height = renderer.world.roomHeight;
    const snapshots = rooms.map(room => ({ ...room, objects: objects.filter(object =>
      Math.floor(object.x / width) === room.columnIndex && Math.floor(object.y / height) === room.rowIndex
    ).map(object => ({ ...object, x: object.x - room.columnIndex * width, y: object.y - room.rowIndex * height })) }));
    const byName = new Map(snapshots.map(room => [room.fileName, room]));
    const world = { ...renderer.world, contextRooms: renderer.world.contextRooms.map(room => byName.get(room.fileName) || room) };
    const borders = snapshots.flatMap(room => roomBorderEdges(world, room));
    joinRoomBorderEdges(content.children.slice(firstJoined), borders, content);
    content.cutawayBorders = height => snapshots.flatMap(room => roomBorderEdges(world, room, { maxHeight: height }));
  }
  data.terrainAssets.forEach(record => addTerrainAsset(content, {
    ...record,
    // Terrain asset rotation is seeded by room-local coordinates at rest.
    localX: record.x % renderer.world.roomWidth,
    localZ: record.z % renderer.world.roomHeight
  }, dimensions));
  data.gems.forEach(record => renderer.addGemAsset(content, record, dimensions));
  data.specialPieces.filter(record => record.definition.kind !== "slope")
    .forEach(record => addSpecialPiece(content, record, dimensions));
  const view = Object.create(renderer);
  view.content = content;
  view.addEditorGrid(data.editorGridCells);
  renderer.assignRenderLayers(content);
  return content;
}

function initialObject(track, phase = track.initialPhase) {
  const [x, y, z] = track.positions[0];
  return { ...track.object, engineHidden: false, x, y, z, stateId: phase };
}

function mechanismMorph(renderer, track) {
  const low = buildContent(renderer, [initialObject(track, 0)]);
  const high = buildContent(renderer, [initialObject(track, 1)]);
  const parts = low.children.map((object, index) => {
    const raised = high.children[index];
    const from = object.geometry?.attributes.position;
    const to = raised?.geometry?.attributes.position;
    let geometry;
    const sourceGeometry = object.geometry;
    const marker = track.block.visual.kind === "lift" && index === low.children.length - 1;
    if (!marker && from && to && from.count === to.count) {
      geometry = object.geometry.clone();
      // BufferGeometry.clone shares userData. Own the flag too, or disposing
      // this tween also invalidates the cached plate/cube used by other rooms.
      geometry.userData = { ...geometry.userData, persistentGeometry: false };
      object.geometry = geometry;
      object.frustumCulled = false;
    }
    return { object, raised, geometry, sourceGeometry, from, to, marker,
      rotation: object.quaternion.clone(), spin: new THREE.Quaternion(),
      lowPosition: object.position.clone(), highPosition: raised?.position.clone() || object.position.clone() };
  });
  const update = phase => {
    for (const part of parts) {
      part.object.position.lerpVectors(part.lowPosition, part.highPosition, phase);
      if (part.marker) {
        // Rotate a complete triangle; interpolating its opposing vertices
        // collapses the symbol to a line halfway through a lift transition.
        if (part.object.userData.liftMarker) part.object.userData.animationLiftPhase = phase;
        else part.object.quaternion.copy(part.rotation).multiply(
          part.spin.setFromAxisAngle(markerAxis, phase * Math.PI));
      }
      if (part.geometry) {
        for (const name of ["position", "lineOther"]) {
          const points = part.geometry.attributes[name];
          const from = part.sourceGeometry?.attributes[name], to = part.raised?.geometry?.attributes[name];
          if (!points || !from || !to) continue;
          for (let i = 0; i < points.array.length; i++) points.array[i] = from.array[i] + (to.array[i] - from.array[i]) * phase;
          points.needsUpdate = true;
        }
      }
    }
  };
  update(track.initialPhase);
  return { root: low, update, dispose: () => {
    disposeGeneratedChildren(high);
    for (const part of parts) if (part.geometry && !part.sourceGeometry.userData.persistentGeometry) part.sourceGeometry.dispose();
  } };
}

export class CommandAnimationScene {
  constructor(renderer, timeline, { reuseBackgrounds = false } = {}) {
    this.renderer = renderer;
    this.timeline = timeline;
    this.initialLighting = renderer.roomLighting && Array.from(renderer.roomLighting.values);
    this.lighting = [];
    if (renderer.roomLighting && timeline.lighting.length) {
      for (const transition of timeline.lighting) {
        const to = Array.from(this.initialLighting, () => 0);
        timeline.rooms.forEach((room, index) => { to[renderer.roomLighting.index(room)] = transition.to[index]; });
        this.lighting.push({ ...transition, to,
          from: sampleSegments(this.lighting, this.initialLighting, transition.start, { alwaysEase: true }) });
      }
    }
    this.offset = [0, 0];
    const player = timeline.tracks.find(track => track.block.roleId === "player");
    const level = player?.positions.every(position => position[2] === player.positions[0][2]);
    const inside = (position, room) => Math.floor(position[0] / renderer.world.roomWidth) === room.columnIndex &&
      Math.floor(position[1] / renderer.world.roomHeight) === room.rowIndex;
    const cachedRooms = reuseBackgrounds && level ? timeline.rooms.filter(room =>
      room.fileName !== renderer.world.contextActiveRoom.fileName && renderer.roomBackgrounds?.has(room.fileName) &&
      !timeline.tracks.some(track => track.block.roleId !== "player" && track.changed && inside(track.positions[0], room))) : [];
    this.roomIds = new Set(timeline.rooms.filter(room => !cachedRooms.includes(room)).map(room => room.fileName));
    this.root = new THREE.Group();
    this.upper = new THREE.Group();
    this.materials = new Set();
    this.lowerPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.edgePlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.upperPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e6);
    const staticObjects = timeline.tracks.filter(track => !track.changed && track.initialOpacity &&
      !cachedRooms.some(room => inside(track.positions[0], room)))
      .map(track => initialObject(track));
    this.root.add(buildContent(renderer, staticObjects, timeline.rooms.filter(room => this.roomIds.has(room.fileName))));
    this.actors = groupMovingTracks(timeline.tracks).map(tracks => {
      const track = tracks[0];
      const mechanism = ["gate", "lift", "puncher"].includes(track.block.visual?.kind);
      const morph = mechanism ? mechanismMorph(renderer, track) : null;
      const root = morph?.root || buildContent(renderer, tracks.map(track => initialObject(track)));
      this.root.add(root);
      return { tracks, root, morph, origin: track.positions[0] };
    });
    this.contactRecords = timeline.tracks.flatMap(track => {
      if (!track.changed && cachedRooms.some(room => inside(track.positions[0], room))) return [];
      const shape = contactShape(initialObject(track), track.block);
      if (!shape) return [];
      const mechanism = ["lift", "gate"].includes(track.block.visual?.kind);
      return [{ track, shape, baseHeight: shape.position[1], visible: track.initialOpacity > 0,
        low: mechanism ? contactShape(initialObject(track, 0), track.block) : null,
        high: mechanism ? contactShape(initialObject(track, 1), track.block) : null }];
    });
    const supports = this.contactRecords.filter(record => record.track.block.roleId !== "orange-wall");
    this.wallContacts = [];
    this.caps = [];
    for (const root of this.root.children) {
      const actor = this.actors.find(actor => actor.root === root);
      const walls = this.contactRecords.filter(record => record.track.block.roleId === "orange-wall" &&
        (actor ? actor.tracks.includes(record.track) : !record.track.changed && record.track.initialOpacity));
      if (walls.length) this.wallContacts.push(new AnimatedWallContacts(renderer, root, walls, supports));
      const records = this.contactRecords.filter(record => actor ? actor.tracks.includes(record.track)
        : !record.track.changed && record.track.initialOpacity);
      if (records.length) this.caps.push(new TruncateCaps(renderer, root, records));
    }
    this.modelCaps = this.root.children.map(root => new ModelTruncateCaps(renderer, root, root, { dynamic: true }));
    renderer.assignRenderLayers(this.root);
    const ownedMaterials = new Set();
    this.root.traverse(object => {
      if (object.userData.transientMaterial) ownedMaterials.add(object.material);
    });
    // The upper copy shares geometry (including mechanism morph buffers), but
    // owns clipped ghost materials. No geometry is cut again while moving.
    for (const child of this.root.children) this.upper.add(child.clone(true));
    this.parts = this.root.children.map((root, index) => {
      const coverage = { value: 1 };
      return {
        root, upper: this.upper.children[index], coverage,
        lowerMaterials: this.prepareMaterials(root, this.lowerPlane, coverage),
        upperMaterials: this.prepareMaterials(this.upper.children[index], this.upperPlane, coverage, true)
      };
    });
    ownedMaterials.forEach(material => material.dispose());
    this.rootNodes = []; this.upperNodes = [];
    this.root.traverse(object => this.rootNodes.push(object));
    this.upper.traverse(object => this.upperNodes.push(object));
    this.gems = collectAnimatedGems(this.root);
    this.attach();
    this.update(0);
  }

  // Replay seeking can park a scene without releasing its GPU buffers. Keep
  // visibility ownership separate from disposal so evicting a parked scene
  // never exposes another scene's hidden foreground or background rooms.
  attach() {
    if (this.attached) return;
    const renderer = this.renderer;
    this.originalVisibility = [renderer.content.visible, renderer.cutawayContent.visible];
    renderer.scene.add(this.root, this.upper);
    this.attached = true;
  }

  detach() {
    if (!this.attached) return;
    const renderer = this.renderer;
    renderer.scene.remove(this.root, this.upper);
    [renderer.content.visible, renderer.cutawayContent.visible] = this.originalVisibility;
    for (const id of this.roomIds) {
      const background = renderer.roomBackgrounds?.get(id);
      if (background) background.root.visible = id !== renderer.world.contextActiveRoom.fileName;
    }
    delete renderer.canvas.dataset.motionTime;
    delete renderer.canvas.dataset.motionDuration;
    delete renderer.canvas.dataset.motionPlayer;
    this.attached = false;
  }

  prepareMaterials(root, plane, coverage, upper = false) {
    const copies = new Map();
    const copy = (source, cap, edge) => {
      const key = `${source.uuid}:${cap}:${edge}`;
      if (!copies.has(key)) {
        const material = source.clone();
        material.onBeforeCompile = source.onBeforeCompile;
        material.customProgramCacheKey = source.customProgramCacheKey;
        material.clippingPlanes = cap ? [] : [!upper && edge ? this.edgePlane : plane];
        material.clipShadows = true;
        applySolidFade(material, coverage);
        copies.set(key, { source, material });
        this.materials.add(material);
      }
      return copies.get(key).material;
    };
    root.traverse(object => {
      if (!object.material) return;
      const original = object.material;
      const convert = source => copy(source, object.userData.truncateCap === true, isEdge(object));
      object.material = Array.isArray(original) ? original.map(convert) : convert(original);
      // These copies are owned by this scene, not the static renderer cache.
      delete object.userData.transientMaterial;
      if (upper) {
        object.castShadow = false;
        object.receiveShadow = false;
        if (isEdge(object) || object.userData.truncateCap) object.visible = false;
      }
    });
    return [...copies.values()];
  }

  // Replay layouts identify identical stationary scenery. Keep its meshes and
  // shaders when seeking between ordinary steps, even when seeking backward.
  retargetPlayer(timeline) {
    const changed = timeline.tracks.filter(track => track.changed), actor = this.actors[0];
    if (this.actors.length !== 1 || changed.length !== 1 || !actor ||
        actor.tracks[0].block.roleId !== "player" || changed[0].block.roleId !== "player" ||
        actor.tracks[0].fades.length || changed[0].fades.length || changed[0].phases.length ||
        this.timeline.camera.length || timeline.camera.length || this.timeline.lighting.length || timeline.lighting.length ||
        !changed[0].positions.every(position => position[2] === actor.origin[2])) return false;
    const previous = actor.tracks[0];
    for (const record of this.contactRecords) if (record.track === previous) record.track = changed[0];
    actor.tracks = changed;
    this.timeline = timeline;
    return true;
  }

  update(time) {
    const renderer = this.renderer;
    this.time = time;
    if (renderer.roomLighting && this.timeline.lighting.length) {
      const weights = sampleSegments(this.lighting, this.initialLighting, time, { alwaysEase: true });
      renderer.roomLighting.transition = null;
      renderer.roomLighting.values.set(weights);
      renderer.roomLighting.upload();
    }
    for (const actor of this.actors) {
      const track = actor.tracks[0], value = sampleTrack(track, time);
      const [x, y, z] = actor.origin;
      actor.root.position.set(value.x - x, value.z - z, value.y - y);
      actor.root.visible = value.opacity > 0;
      actor.opacity = value.opacity;
      actor.morph?.update(value.phase);
    }
    for (const record of this.contactRecords) {
      if (!record.track.changed) continue;
      const value = sampleTrack(record.track, time);
      const initial = record.track.positions[0];
      record.shape.position = [value.x, record.baseHeight + value.z - initial[2], value.y];
      record.visible = value.opacity > 0;
      // Keep the support face on the same interpolated plate as lift/gate geometry.
      if (record.low && record.high) {
        const { low, high } = record;
        const delta = [value.x - initial[0], value.z - initial[2], value.y - initial[1]];
        for (let axis = 0; axis < 3; axis++) {
          record.shape.position[axis] = low.position[axis] + (high.position[axis] - low.position[axis]) * value.phase + delta[axis];
          record.shape.size[axis] = low.size[axis] + (high.size[axis] - low.size[axis]) * value.phase;
        }
      }
    }
    const offset = sampleSegments(this.timeline.camera, [0, 0], time, { alwaysEase: true });
    renderer.target.x += offset[0] - this.offset[0];
    renderer.target.z += offset[1] - this.offset[1];
    this.offset = offset;
    if (renderer.renderer.shadowMap.enabled) renderer.renderer.shadowMap.needsUpdate = true;
    renderer.canvas.dataset.motionTime = time.toFixed(1);
    renderer.canvas.dataset.motionDuration = String(this.timeline.duration);
    const player = sampleTimelinePlayer(this.timeline, time);
    if (player) renderer.canvas.dataset.motionPlayer = JSON.stringify(player);
  }

  beforeRender() {
    const renderer = this.renderer;
    renderer.content.visible = false;
    renderer.cutawayContent.visible = false;
    for (const id of this.roomIds) {
      const background = renderer.roomBackgrounds?.get(id);
      if (background) background.root.visible = false;
    }
    let height = renderer.cutawayHeight;
    if (renderer.cutaway.followPlayer) {
      const player = sampleTimelinePlayer(this.timeline, this.time);
      if (player) height = Math.max(1, player.z + 1);
    }
    // Original faces/edges stop below the cut; retained joined caps close it.
    // This also removes the bottom outlines of boxes on the hidden next layer.
    this.lowerPlane.constant = height === null ? 1e6 : height - .0005;
    this.edgePlane.constant = height === null ? 1e6 : height - .002;
    this.upperPlane.constant = height === null ? -1e6 : -height - .002;
    this.wallContacts.forEach(contacts => contacts.update(height));
    this.caps.forEach(caps => caps.update(height));
    this.modelCaps.forEach(caps => caps.update(height));
    this.upper.visible = height !== null && renderer.cutaway.opacity > 0;
    // Lift symbols face the camera, just like their settled counterparts.
    for (const object of this.rootNodes) if (object.userData.liftMarker) {
      object.rotation.y = renderer.yaw + (object.userData.animationLiftPhase || 0) * Math.PI;
    }
    for (let i = 1; this.upper.visible && i < this.rootNodes.length; i++) {
      const object = this.rootNodes[i], upper = this.upperNodes[i];
      upper.position.copy(object.position);
      upper.quaternion.copy(object.quaternion);
      upper.scale.copy(object.scale);
      upper.visible = object.visible && !isEdge(upper) && !upper.userData.truncateCap;
    }
    this.parts.forEach((part, index) => {
      part.coverage.value = index ? this.actors[index - 1].opacity : 1;
      // Truncate ghosts retain their requested transparency. Object fades use
      // one shared coverage mask for the solid surface, its edges and ghosts.
      if (part.materialOpacity === renderer.cutaway.opacity) return;
      part.materialOpacity = renderer.cutaway.opacity;
      for (const [materials, multiplier] of [[part.lowerMaterials, 1], [part.upperMaterials, renderer.cutaway.opacity]]) {
        for (const { source, material } of materials) {
          const transparent = source.transparent || multiplier < 1;
          if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
          material.opacity = source.opacity * multiplier;
          material.depthWrite = source.depthWrite && multiplier >= 1;
        }
      }
    });
  }

  dispose({ restoreCamera = false } = {}) {
    const renderer = this.renderer;
    if (restoreCamera) {
      if (this.initialLighting && renderer.roomLighting) {
        renderer.roomLighting.transition = null;
        renderer.roomLighting.values.set(this.initialLighting);
        renderer.roomLighting.upload();
      }
      renderer.target.x -= this.offset[0];
      renderer.target.z -= this.offset[1];
    }
    this.detach();
    this.actors.forEach(actor => actor.morph?.dispose());
    disposeGeneratedChildren(this.root);
    this.upper.clear(); // geometry is shared with the lower copy
    this.materials.forEach(material => material.dispose());
  }
}
