import { addGemAsset } from "../../ui/asset-renderers.mjs";

const TURN_MS = 12000;
const BOB_MS = 3200;
const BOB_HEIGHT = 0.06;

export function addAnimatedGem(content, record, dimensions) {
  const first = content.children.length;
  addGemAsset(content, record, dimensions);
  for (const gem of content.children.slice(first)) {
    // Serializable metadata survives the Truncate ghost clone. Keep authored
    // transforms as the baseline so room rebuilds never restart the motion.
    gem.userData.gemMotion = { height: gem.position.y, yaw: gem.rotation.y };
  }
}

export function collectAnimatedGems(...roots) {
  const gems = [];
  for (const root of roots) root?.traverse(object => {
    if (object.userData.gemMotion) gems.push(object);
  });
  return gems;
}

export function updateAnimatedGems(gems, now, enabled = true) {
  const turn = enabled ? (now % TURN_MS) / TURN_MS * Math.PI * 2 : 0;
  const bob = (now % BOB_MS) / BOB_MS * Math.PI * 2;
  for (const gem of gems || []) {
    const { height, yaw } = gem.userData.gemMotion;
    gem.rotation.y = yaw + turn;
    gem.position.y = height + (enabled ? Math.sin(bob + yaw) * BOB_HEIGHT : 0);
    // Background transforms are frozen; update only this small subtree.
    gem.updateMatrix();
  }
}
