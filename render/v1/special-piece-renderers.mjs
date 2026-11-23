// Source-style renderers for the non-cube pieces that have no GLB asset.

import * as THREE from "../vendor/three.module.min.js";
import {
  ORANGE_BUTTON_HEIGHT,
  ORANGE_BUTTON_RADIUS,
  PUNCHER_DEPTH,
  PUNCHER_RADIUS
} from "./piece-definitions.mjs";
import {
  addOutlinedMesh,
  cachedGeometry,
  renderMaterial
} from "./polycube-mesh.mjs";

function centerFor(record, dimensions) {
  return {
    x: record.x - dimensions.totalWidth / 2 + 0.5,
    z: record.z - dimensions.totalHeight / 2 + 0.5
  };
}

function addCuboid(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  const height = record.definition.top - record.definition.bottom;
  const geometry = cachedGeometry(`special-box:${height.toFixed(5)}`, () =>
    new THREE.BoxGeometry(1, height, 1));
  addOutlinedMesh(content, geometry, record.definition.color, {
    position: new THREE.Vector3(center.x, record.definition.bottom + height / 2, center.z)
  }, 18, { dimmed: record.dimmed });
}

// Closed wedge with outward winding on every face. Each direction is a rigid
// Y-axis rotation of the same right-facing source wedge, so no camera angle
// can expose an accidentally back-facing or omitted side.
export function slopeGeometry(direction) {
  const normalized = ["left", "up", "down"].includes(direction) ? direction : "right";
  return cachedGeometry(`source-slope:${normalized}`, () => {
    const x0 = -0.5, x1 = 0.5, z0 = -0.5, z1 = 0.5, y0 = 0, y1 = 1;
    const positions = [];
    const rotate = ([x, y, z]) => {
      if (normalized === "left") return [-x, y, -z];
      if (normalized === "up") return [z, y, -x];
      if (normalized === "down") return [-z, y, x];
      return [x, y, z];
    };
    const tri = (a, b, c) => positions.push(...rotate(a), ...rotate(b), ...rotate(c));
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
    quad([x0,y0,z0],[x0,y0,z1],[x1,y1,z1],[x1,y1,z0]); // ramp
    quad([x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]); // high end
    tri([x0,y0,z0],[x1,y1,z0],[x1,y0,z0]); // near triangular side
    tri([x0,y0,z1],[x1,y0,z1],[x1,y1,z1]); // far triangular side
    quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]); // underside
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  });
}

function addSlope(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  addOutlinedMesh(content, slopeGeometry(record.source.direction), record.definition.color, {
    position: new THREE.Vector3(center.x, record.definition.bottom, center.z)
  }, 18, { dimmed: record.dimmed });
}

function addLiftTriangle(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  const raised = record.definition.marker === "up";
  const geometry = cachedGeometry(`lift-triangle:${raised ? "up" : "down"}`, () => {
    const pointZ = raised ? 0.22 : -0.22;
    const baseZ = raised ? -0.16 : 0.16;
    const points = raised
      ? [0,0,pointZ, 0.17,0,baseZ, -0.17,0,baseZ]
      : [0,0,pointZ, -0.17,0,baseZ, 0.17,0,baseZ];
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    triangle.computeVertexNormals();
    return triangle;
  });
  const marker = new THREE.Mesh(geometry, renderMaterial("#050608", record.dimmed));
  marker.position.set(center.x, record.definition.top + 0.012, center.z);
  marker.userData.liftMarker = true;
  content.add(marker);
}

function addOrangeButton(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  const geometry = cachedGeometry("orange-button", () => new THREE.CylinderGeometry(
    ORANGE_BUTTON_RADIUS,
    ORANGE_BUTTON_RADIUS,
    ORANGE_BUTTON_HEIGHT,
    32,
    1,
    false
  ));
  const orientation = record.definition.orientation || record.source.orientation || "top";
  const position = new THREE.Vector3(
    center.x,
    record.definition.bottom + ORANGE_BUTTON_HEIGHT / 2,
    center.z
  );
  const rotation = new THREE.Euler();
  if (orientation === "bottom") {
    position.y = record.definition.bottom + 1 - ORANGE_BUTTON_HEIGHT / 2;
    rotation.x = Math.PI;
  } else if (orientation === "north") {
    position.y = record.definition.bottom + 0.5;
    position.z += 0.5 - ORANGE_BUTTON_HEIGHT / 2;
    rotation.x = -Math.PI / 2;
  } else if (orientation === "east") {
    position.x -= 0.5 - ORANGE_BUTTON_HEIGHT / 2;
    position.y = record.definition.bottom + 0.5;
    rotation.z = -Math.PI / 2;
  } else if (orientation === "south") {
    position.y = record.definition.bottom + 0.5;
    position.z -= 0.5 - ORANGE_BUTTON_HEIGHT / 2;
    rotation.x = Math.PI / 2;
  } else if (orientation === "west") {
    position.x += 0.5 - ORANGE_BUTTON_HEIGHT / 2;
    position.y = record.definition.bottom + 0.5;
    rotation.z = Math.PI / 2;
  }
  addOutlinedMesh(
    content,
    geometry,
    record.definition.color,
    { position, rotation },
    24,
    { dimmed: record.dimmed }
  );
}

function sideLiftTriangleGeometry(raised) {
  return cachedGeometry(`side-lift-triangle:${raised ? "up" : "down"}`, () => {
    const pointY = raised ? 0.22 : -0.22;
    const baseY = raised ? -0.16 : 0.16;
    const points = raised
      ? [0,pointY,0, 0.17,baseY,0, -0.17,baseY,0]
      : [0,pointY,0, -0.17,baseY,0, 0.17,baseY,0];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    geometry.computeVertexNormals();
    return geometry;
  });
}

function addSideLift(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  const orientation = record.definition.orientation;
  const extension = record.definition.raised ? 1 : 4 / 64;
  let width = 1;
  let depth = 1;
  let x = center.x;
  let z = center.z;
  if (orientation === "north") {
    depth = extension;
    z += (1 - extension) / 2;
  } else if (orientation === "east") {
    width = extension;
    x -= (1 - extension) / 2;
  } else if (orientation === "south") {
    depth = extension;
    z -= (1 - extension) / 2;
  } else {
    width = extension;
    x += (1 - extension) / 2;
  }
  const geometry = cachedGeometry(`side-lift:${width}:${depth}`, () =>
    new THREE.BoxGeometry(width, 1, depth));
  addOutlinedMesh(content, geometry, record.definition.color, {
    position: new THREE.Vector3(x, record.definition.bottom + 0.5, z)
  }, 18, { dimmed: record.dimmed });

  const marker = new THREE.Mesh(
    sideLiftTriangleGeometry(record.definition.raised),
    new THREE.MeshBasicMaterial({ color: "#050608", side: THREE.DoubleSide })
  );
  marker.userData.transientMaterial = true;
  marker.position.set(center.x, record.definition.bottom + 0.5, center.z);
  const bias = 0.012;
  const surfaceDistance = extension - 0.5;
  if (orientation === "north") {
    marker.position.z -= surfaceDistance + bias;
    marker.rotation.y = Math.PI;
  } else if (orientation === "east") {
    marker.position.x += surfaceDistance + bias;
    marker.rotation.y = Math.PI / 2;
  } else if (orientation === "south") {
    marker.position.z += surfaceDistance + bias;
  } else {
    marker.position.x -= surfaceDistance + bias;
    marker.rotation.y = -Math.PI / 2;
  }
  content.add(marker);
}

export function puncherDirectionVector(direction) {
  const normalized = String(direction || "right").toLowerCase();
  const vectors = {
    bottom: new THREE.Vector3(0, -1, 0),
    down: new THREE.Vector3(0, 0, 1),
    east: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
    north: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    south: new THREE.Vector3(0, 0, 1),
    top: new THREE.Vector3(0, 1, 0),
    up: new THREE.Vector3(0, 0, -1),
    west: new THREE.Vector3(-1, 0, 0)
  };
  return vectors[normalized] || vectors.right;
}

export function puncherPartLayout(sprung = false) {
  return sprung
    ? [
        { radius: PUNCHER_RADIUS, depth: PUNCHER_DEPTH, offset: 0, color: "#ef4444" },
        { radius: PUNCHER_RADIUS * 0.47, depth: 0.58, offset: 0.34, color: "#f8fafc" },
        { radius: PUNCHER_RADIUS * 0.88, depth: 0.15, offset: 0.73, color: "#b91c1c" }
      ]
    : [
        { radius: PUNCHER_RADIUS, depth: PUNCHER_DEPTH, offset: 0, color: "#ef4444" },
        { radius: PUNCHER_RADIUS * 0.66, depth: PUNCHER_DEPTH * 0.45, offset: PUNCHER_DEPTH * 0.58, color: "#f8fafc" },
        { radius: PUNCHER_RADIUS * 0.34, depth: PUNCHER_DEPTH * 0.5, offset: PUNCHER_DEPTH * 0.72, color: "#b91c1c" }
      ];
}

function addPuncher(content, record, dimensions) {
  const cell = centerFor(record, dimensions);
  const vector = puncherDirectionVector(record.source.direction);
  const backOffset = 0.5 - PUNCHER_DEPTH / 2;
  const center = new THREE.Vector3(
    cell.x,
    record.definition.bottom + 0.5,
    cell.z
  ).addScaledVector(vector, -backOffset);
  const rotation = new THREE.Euler().setFromQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector)
  );
  puncherPartLayout(record.definition.sprung).forEach((part) => {
    const geometry = cachedGeometry(`puncher:${part.radius}:${part.depth}`, () =>
      new THREE.CylinderGeometry(part.radius, part.radius, part.depth, 40, 1, false));
    addOutlinedMesh(content, geometry, part.color, {
      position: new THREE.Vector3(
        center.x + vector.x * part.offset,
        center.y + vector.y * part.offset,
        center.z + vector.z * part.offset
      ),
      rotation
    }, 18, { dimmed: record.dimmed });
  });
}

function addExitMarker(content, record, dimensions) {
  const center = centerFor(record, dimensions);
  const geometry = cachedGeometry("exit-cube", () => new THREE.BoxGeometry(0.34, 0.34, 0.34));
  addOutlinedMesh(content, geometry, "#ff7b72", {
    position: new THREE.Vector3(center.x, record.definition.bottom + 0.17, center.z)
  }, 18, { dimmed: record.dimmed });
}

export function addSpecialPiece(content, record, dimensions) {
  switch (record.definition.kind) {
    case "slope":
      addSlope(content, record, dimensions);
      break;
    case "gate":
    case "floating_floor":
      addCuboid(content, record, dimensions);
      break;
    case "lowered_lift":
    case "raised_lift":
      addCuboid(content, record, dimensions);
      addLiftTriangle(content, record, dimensions);
      break;
    case "side_lift":
      addSideLift(content, record, dimensions);
      break;
    case "orange_button":
      addOrangeButton(content, record, dimensions);
      break;
    case "puncher":
      addPuncher(content, record, dimensions);
      break;
    case "exit_marker":
      addExitMarker(content, record, dimensions);
      break;
  }
}
