// Shared browser renderer with connected cube/slope surfaces. The original v1
// module remains byte-identical for historical benchmark runtime manifests.
import * as THREE from "../render/vendor/three.module.min.js";
import { ThreeMazeRendererV1 } from "../render/v1/three-renderer.mjs";
import { addGemAsset, addTerrainAsset } from "./asset-renderers.mjs";
import { addSpecialPiece } from "../render/v1/special-piece-renderers.mjs";
import { collectVoxelSceneV2 } from "./voxel-scene.mjs";
import { applyCutawayMaterials } from "../render/v1/cutaway.mjs";
import { V2_WORLD_FORMAT } from "../render/v1/voxel-world-v2.mjs";
import { addGenericNumberFaces } from "../render/v1/generic-labels.mjs";
import { disposeGeneratedChildren, edgeMaterial } from "../render/v1/polycube-mesh.mjs";
import { joinedSceneGroups, joinedSurfaceFaces, joinedGeometry, joinedEdges, joinedSurfaceMaterial } from "./joined-voxel-mesh.mjs";

import { perspectiveNearForDistance } from "./joined-voxel-surface.mjs";
import { prepareBrowserModels } from "./browser-world.mjs";
import { ThickEdges } from "./thick-edges.mjs";
import { preparedWorldSurfaces } from "./prepared-world-surfaces.mjs";
import { addOrangeWallContacts } from "./orange-wall-contacts.mjs";
import { ModelTruncateCaps } from "./model-truncate-caps.mjs";

export class JoinedMazeRenderer extends ThreeMazeRendererV1 {
  setWorld(world, options) {
    this.renderSuspended = (this.renderSuspended || 0) + 1;
    try { super.setWorld(world, options); }
    finally { this.renderSuspended--; }
    this.render();
  }

  render() {
    if (!this.renderSuspended) super.render();
  }

  collectScene() {
    return this.world.storageFormat === V2_WORLD_FORMAT ? collectVoxelSceneV2(this) : super.collectScene();
  }

  assignRenderLayers(root) {
    this.thickEdges ||= new ThickEdges();
    this.thickEdges.apply(root);
  }

  renderThickOutlines() {} // Thick outlines are screen-space meshes in the main pass.

  requestModels(urls) {
    const generation = ++this.modelLoadGeneration;
    prepareBrowserModels(urls).then(changed => {
      if (changed && generation === this.modelLoadGeneration) this.rebuild();
    });
  }

  updateCamera() {
    super.updateCamera();
    this.modelCaps?.update(this.cutawayHeight);
    const near = perspectiveNearForDistance(this.distance);
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (this.thickEdges) {
      this.thickEdges.uniforms.mazeLineViewport.value.set(Math.max(1, this.canvas.width), Math.max(1, this.canvas.height));
      this.thickEdges.uniforms.mazeLineNear.value = this.camera.near;
    }
  }

  addJoinedCubes(data, content, minHeight = -Infinity) {
    const { groups, occupants, cubeGroups } = joinedSceneGroups(data);
    super.addCubeGroups(cubeGroups, data.occupied, content, minHeight);
    for (const group of groups) {
      const faces = joinedSurfaceFaces(group.shapes, occupants, { minHeight });
      if (!faces.length) continue;
      const mesh = new THREE.Mesh(
        joinedGeometry(faces, this.totalWidth / 2, this.totalHeight / 2),
        joinedSurfaceMaterial(group)
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.joinedSlopes = true;
      content.add(mesh);
      const edges = new THREE.LineSegments(
        joinedEdges(faces, this.totalWidth / 2, this.totalHeight / 2),
        group.dimmed ? edgeMaterial(0x111820, 0.58) : edgeMaterial()
      );
      edges.renderOrder = 10;
      edges.userData.joinedSlopes = true;
      content.add(edges);
    }
  }

  addNumberLabels(records, dimensions) {
    records?.forEach(record => addGenericNumberFaces(this.content, record, dimensions));
  }

  addGemAsset(content, record, dimensions) {
    addGemAsset(content, record, dimensions);
  }

  rebuild() {
    if (this.world.storageFormat !== V2_WORLD_FORMAT) return super.rebuild();
    this.modelCaps = null;
    disposeGeneratedChildren(this.content);
    disposeGeneratedChildren(this.cutawayContent);
    this.pickMeshes = [];
    const height = this.cutawayHeight;
    const isCutaway = this.world.storageFormat === V2_WORLD_FORMAT && height !== null;
    const prepared = this.mode === "world" && !isCutaway && preparedWorldSurfaces(this.world);
    const data = prepared?.data || (isCutaway ? collectVoxelSceneV2(this, { maxHeight: height }) : this.collectScene());
    if (prepared) this.cellTops = prepared.cellTops;
    const dimensions = { totalWidth: this.totalWidth, totalHeight: this.totalHeight };
    const addPiece = (content, record, add) => {
      const first = content.children.length;
      add(content, record, dimensions);
      if (isCutaway && record.definition.bottom < height && record.definition.top > height) {
        content.children.slice(first).forEach(child => child.traverse(object => {
          object.userData.cutawayClip = true;
        }));
      }
    };
    if (prepared) this.content.add(...prepared.objects);
    else {
      this.addFloorGroups(data.floorGroups);
      this.addJoinedCubes(data, this.content);
      data.terrainAssets.forEach((record) => addPiece(this.content, record, addTerrainAsset));
      data.gems.forEach((record) => addPiece(this.content, record, this.addGemAsset.bind(this)));
      data.specialPieces.filter(record => record.definition.kind !== "slope").forEach((record) => addPiece(this.content, record, addSpecialPiece));
    }
    addOrangeWallContacts(this.content, this.world, dimensions, height);
    if (this.pickVoxels) {
      this.addNumberLabels(data.genericLabels, dimensions);
    }
    this.addEditorGrid(data.editorGridCells);
    if (data.pickRecords) this.addEditorVoxelPickMesh(data.pickRecords);
    else this.addEditorPickMesh(data.cellMetadata);
    if (isCutaway) {
      this.modelCaps = new ModelTruncateCaps(this, this.content);
      this.modelCaps.update(height);
      applyCutawayMaterials(this.content, { height, clip: false });
      if (this.mode === "play" && this.cutaway.opacity > 0) {
        const upper = collectVoxelSceneV2({ world: this.world }, { minHeight: height });
        this.addFloorGroups(upper.floorGroups, this.cutawayContent);
        this.addJoinedCubes(upper, this.cutawayContent, height);
        upper.terrainAssets.forEach((record) => addPiece(this.cutawayContent, record, addTerrainAsset));
        upper.gems.forEach((record) => addPiece(this.cutawayContent, record, this.addGemAsset.bind(this)));
        upper.specialPieces.filter(record => record.definition.kind !== "slope").forEach((record) => addPiece(this.cutawayContent, record, addSpecialPiece));
        applyCutawayMaterials(this.cutawayContent, { height, upper: true, opacity: this.cutaway.opacity, clip: false });
        upper.modelUrls.forEach((url) => data.modelUrls.add(url));
      }
    }
    this.canvas.dataset.cutawayHeight = height === null ? "full" : String(height);
    this.canvas.dataset.cutawayOpacity = String(this.cutaway.opacity);
    this.canvas.dataset.cutawayFollowPlayer = String(this.cutaway.followPlayer);
    this.canvas.dataset.visiblePickCount = String(data.pickRecords?.length || 0);
    this.assignRenderLayers(this.content);
    this.assignRenderLayers(this.cutawayContent);
    if (this.renderer.shadowMap.enabled) this.renderer.shadowMap.needsUpdate = true;
    this.render();
    return data.modelUrls;
  }

}
