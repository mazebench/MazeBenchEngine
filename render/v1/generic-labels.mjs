// Numeric face labels for C++ generic rigid-body families. The material and
// geometry are cached by value so a room adds no per-frame canvas work.

import * as THREE from "../vendor/three.module.min.js";
import { cachedGeometry } from "./polycube-mesh.mjs";

const textureCache = new Map();
const materialCache = new Map();
const planeGeometry = () => cachedGeometry("generic-number-plane", () =>
  new THREE.PlaneGeometry(0.68, 0.68));
const FACE_CLEARANCE = 0.001;

function numericLabel(value) {
  if (Number.isInteger(value) && value >= 0) return String(value);
  const match = /(\d+)$/.exec(String(value ?? ""));
  return match ? match[1] : null;
}

export function genericNumberLabel(object, block) {
  const roleId = block?.roleId;
  if (roleId === "weightless-pushable" || roleId === "clone") {
    return numericLabel(object.groupId ?? object.genericId);
  }
  if (object?.type === "weightless_box" || object?.type === "clone") {
    return numericLabel(object.groupId ?? object.genericId ?? object.token);
  }
  return null;
}

function textureFor(label) {
  if (textureCache.has(label)) return textureCache.get(label);
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 128, 128);
  const length = String(label).length;
  const size = length <= 2 ? 92 : length <= 4 ? 74 : 56;
  context.font = `800 ${size}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#000000";
  context.fillText(String(label), 64, 68, 120);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  textureCache.set(label, texture);
  return texture;
}

function materialFor(label) {
  if (!materialCache.has(label)) {
    materialCache.set(label, new THREE.MeshBasicMaterial({
      alphaTest: 0.04,
      depthWrite: false,
      map: textureFor(label),
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
      transparent: true
    }));
  }
  return materialCache.get(label);
}

function addFace(group, label, position, rotation) {
  const mesh = new THREE.Mesh(planeGeometry(), materialFor(label));
  mesh.position.copy(position);
  mesh.rotation.copy(rotation);
  mesh.renderOrder = 16;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);
}

function rotatedSlopeVector(direction, vector) {
  const { x, y, z } = vector;
  if (direction === "left") return new THREE.Vector3(-x, y, -z);
  if (direction === "up") return new THREE.Vector3(z, y, -x);
  if (direction === "down") return new THREE.Vector3(-z, y, x);
  return new THREE.Vector3(x, y, z);
}

function addSlopeFace(group, label, origin, direction, center, right, up, scale = 1) {
  const faceCenter = rotatedSlopeVector(direction, center).add(origin);
  const faceRight = rotatedSlopeVector(direction, right).normalize();
  const faceUp = rotatedSlopeVector(direction, up).normalize();
  const normal = faceRight.clone().cross(faceUp).normalize();
  const matrix = new THREE.Matrix4().makeBasis(faceRight, faceUp, normal);
  const mesh = new THREE.Mesh(planeGeometry(), materialFor(label));
  mesh.position.copy(faceCenter);
  mesh.quaternion.setFromRotationMatrix(matrix);
  mesh.scale.setScalar(scale);
  mesh.renderOrder = 16;
  group.add(mesh);
}

function addSlopeNumberFaces(group, label, x, bottom, z, direction) {
  const origin = new THREE.Vector3(x, bottom, z);
  const rootHalf = Math.SQRT1_2;
  addSlopeFace(
    group, label, origin, direction,
    new THREE.Vector3(0, 0.5 + FACE_CLEARANCE, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(rootHalf, rootHalf, 0),
    0.9
  );
  addSlopeFace(
    group, label, origin, direction,
    new THREE.Vector3(0.5 + FACE_CLEARANCE, 0.5, 0),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 1, 0),
    0.9
  );
  addSlopeFace(
    group, label, origin, direction,
    new THREE.Vector3(0.12, 0.34, 0.5 + FACE_CLEARANCE),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    0.66
  );
  addSlopeFace(
    group, label, origin, direction,
    new THREE.Vector3(0.12, 0.34, -0.5 - FACE_CLEARANCE),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    0.66
  );
  addSlopeFace(
    group, label, origin, direction,
    new THREE.Vector3(0, -FACE_CLEARANCE, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
    0.9
  );
}

export function addGenericNumberFaces(group, record, dimensions) {
  const label = record.label ?? genericNumberLabel(record.object || record.source, record.block);
  if (label === null || label === undefined) return;
  const x = record.x - dimensions.totalWidth / 2 + 0.5;
  const z = record.z - dimensions.totalHeight / 2 + 0.5;
  const bottom = record.bottom ?? record.definition?.bottom ?? 0;
  const top = record.top ?? record.definition?.top ?? bottom + 1;
  const isSlope = record.definition?.kind === "slope" ||
    record.block?.visual?.kind === "slope" || record.source?.shape === "slope";
  if (isSlope) {
    const direction = record.object?.orientation || record.source?.direction || "right";
    addSlopeNumberFaces(group, label, x, bottom, z, direction);
    return;
  }
  const y = bottom + Math.max(0.24, Math.min(0.58, (top - bottom) / 2));
  const offset = 0.5 + FACE_CLEARANCE;
  addFace(group, label, new THREE.Vector3(x, y, z + offset), new THREE.Euler(0, 0, 0));
  addFace(group, label, new THREE.Vector3(x, y, z - offset), new THREE.Euler(0, Math.PI, 0));
  addFace(group, label, new THREE.Vector3(x + offset, y, z), new THREE.Euler(0, Math.PI / 2, 0));
  addFace(group, label, new THREE.Vector3(x - offset, y, z), new THREE.Euler(0, -Math.PI / 2, 0));
  addFace(group, label, new THREE.Vector3(x, top + FACE_CLEARANCE, z), new THREE.Euler(-Math.PI / 2, 0, 0));
  addFace(group, label, new THREE.Vector3(x, bottom - FACE_CLEARANCE, z), new THREE.Euler(Math.PI / 2, 0, 0));
}
