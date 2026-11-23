// Browser startup can prepare the authored models before constructing any
// meshes. Signed benchmark loaders retain their original behavior.
import { loadMainWorldV2 } from "../render/v1/voxel-world-v2.mjs";
import { loadAssetModels } from "../render/v1/asset-renderers.mjs";

const preparedModels = new Set();

export async function prepareBrowserModels(urls, onProgress = () => {}) {
  const pending = [...urls].filter(url => url && !preparedModels.has(url));
  if (!pending.length) return false;
  let complete = 0;
  await Promise.all(pending.map(async url => {
    await loadAssetModels([url]);
    onProgress(++complete, pending.length);
  }));
  // Failed models keep their existing fallback, without repeated rebuilds.
  pending.forEach(url => preparedModels.add(url));
  return true;
}

export async function loadBrowserWorld(onProgress) {
  const world = await loadMainWorldV2((complete, total) => onProgress?.(50 * complete / total, 100, "Loading rooms"));
  onProgress?.(50, 100, "Loading models");
  await prepareBrowserModels(new Set(world.blocks.map(block => block.visual?.modelUrl).filter(Boolean)),
    (complete, total) => onProgress?.(50 + 15 * complete / total, 100, "Loading models"));
  onProgress?.(65, 100, "Preparing view");
  return world;
}

export function updateLoadProgress(element, complete, total, phase) {
  element.max = total;
  element.value = complete;
  if (phase) element.setAttribute("aria-label", phase);
}

// Yield through a paint, so preparation progress appears before scene upload.
export const paintLoadProgress = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
