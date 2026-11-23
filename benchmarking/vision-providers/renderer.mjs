import { createRequire } from 'node:module';
import path from 'node:path';
import { VisionRenderer as FrozenVisionRenderer } from '../vision/renderer.mjs';

// Resolve the installed ESM entry independently of each agent's isolated HOME.
// The historical renderer's CommonJS resolution does not expose chromium in
// current Playwright releases; keep that signed renderer unchanged.
const require = createRequire(import.meta.url);
export const playwrightModule = path.join(path.dirname(require.resolve('mazebench-playwright/package.json')), 'index.mjs');
export class VisionRenderer extends FrozenVisionRenderer {
  async initialize() {
    process.env.MAZEBENCH_PLAYWRIGHT_MODULE = playwrightModule;
    return super.initialize();
  }
}
