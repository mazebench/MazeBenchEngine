// Browser editor/inspection labels; historical render/v1 modules stay signed.
import * as THREE from "../render/vendor/three.module.min.js";
import { JoinedMazeRenderer } from "./joined-maze-renderer.mjs";
import { addGenericNumberFaces } from "../render/v1/generic-labels.mjs";
import { attachedNumberFaces, numberFaceCovered, numberFaceDirection } from "./numbered-face-visibility.mjs";

export class NumberedMazeRenderer extends JoinedMazeRenderer {
  addNumberLabels(records, dimensions) {
    const ceiling = this.cutawayHeight ?? Infinity;
    const covered = attachedNumberFaces(this.world, ceiling);
    const group = new THREE.Group();
    for (const record of records) {
      addGenericNumberFaces(group, record, dimensions);
      for (const mesh of [...group.children]) {
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
        const face = numberFaceDirection(normal);
        mesh.userData.numberFace = { x: record.x, y: record.z, z: record.object.z, face };
        if (!numberFaceCovered(covered, record, face)) this.content.add(mesh);
      }
      // Number planes/materials are shared cached resources, not disposable
      // per-face geometry. Detached covered faces need no GPU allocation.
      group.clear();
    }
  }
}
