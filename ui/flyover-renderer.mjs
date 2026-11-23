import { JoinedMazeRenderer } from "./joined-maze-renderer.mjs";
import { MazeFuzzyOverlayV1 } from "../render/v1/fuzzy-overlay.mjs";
import { easeToward } from "../render/v1/camera-transitions.mjs";
import { installFlyoverControls } from "./flyover-controls.mjs";

const TURN_SPEED = 1.4;
const TURN_ACCELERATION = 7;

export class FlyoverRenderer extends JoinedMazeRenderer {
  constructor(canvas, world, options = {}) {
    super(canvas, world, { ...options, mode: "world" });
    // World mode creates a disabled overlay. Use the same effect as Edit and Play.
    this.fuzzyOverlay = new MazeFuzzyOverlayV1(canvas);
  }

  assignRenderLayers(root) {
    super.assignRenderLayers(root);
    this.thickEdges.uniforms.mazeLineWidth.value = 1;
  }

  installEvents() {
    this.disposeFlyoverControls = installFlyoverControls(this);
  }

  setFreeYaw(yaw) {
    this.yaw = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    this.heading = this.yaw / (Math.PI / 2);
  }

  setGamepadCameraInput({ yaw = 0, tilt = 0, zoom = 0, panHorizontal = 0, panForward = 0 }) {
    const next = { yaw, tilt, zoom, panHorizontal, panForward };
    if (Object.entries(next).every(([key, value]) => this.gamepadCamera?.[key] === value)) return;
    this.gamepadCamera = next;
    if (zoom) this.cameraMotion.zoomAnimation = null;
    if (panHorizontal || panForward) this.cameraMotion.centerAnimation = null;
    this.recomputeContinuousDirections();
  }

  recomputeContinuousDirections() {
    super.recomputeContinuousDirections();
    const motion = this.cameraMotion;
    const held = key => motion.heldKeys.has(key) || motion.heldKeys.has(`control:${key}`);
    motion.yawDirection = Number(held("d")) - Number(held("a"));
    for (const [input, direction] of [["yaw", "yawDirection"], ["tilt", "tiltDirection"],
      ["zoom", "zoomDirection"], ["panHorizontal", "panHorizontal"], ["panForward", "panForward"]]) {
      motion[direction] = Math.max(-1, Math.min(1, motion[direction] + (this.gamepadCamera?.[input] || 0)));
    }
    if (motion.yawDirection || motion.yawVelocity || motion.tiltDirection || motion.zoomDirection
      || motion.panHorizontal || motion.panForward) this.scheduleCameraFrame();
  }

  runCameraFrame(now) {
    const motion = this.cameraMotion;
    const dt = motion.lastMs ? Math.min(0.05, Math.max(0.001, (now - motion.lastMs) / 1000)) : 1 / 60;
    motion.yawVelocity = easeToward(motion.yawVelocity || 0,
      (motion.yawDirection || 0) * TURN_SPEED, TURN_ACCELERATION * dt);
    if (!motion.yawDirection && Math.abs(motion.yawVelocity) < 0.002) motion.yawVelocity = 0;
    if (motion.yawVelocity) this.setFreeYaw(this.yaw + motion.yawVelocity * dt);
    super.runCameraFrame(now);
    if (motion.yawDirection || motion.yawVelocity) {
      motion.lastMs = now;
      this.scheduleCameraFrame();
    }
  }

  cancelCameraMotion() {
    this.gamepadCamera = null;
    this.cameraMotion.yawDirection = this.cameraMotion.yawVelocity = 0;
    super.cancelCameraMotion();
  }
}
