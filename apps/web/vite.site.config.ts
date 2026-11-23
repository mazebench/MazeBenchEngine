import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The main site mounts the existing test editor, with the same source and WASM.
// Public runtime assets are served directly from apps/web/public, without copies.
export default defineConfig({
  root: fileURLToPath(new URL("./site", import.meta.url)),
  base: "/unit-tests/",
  publicDir: false,
  plugins: [react()],
  css: { postcss: { plugins: [] } },
  build: {
    outDir: fileURLToPath(new URL("../../unit-tests", import.meta.url)),
    emptyOutDir: true,
  },
});
