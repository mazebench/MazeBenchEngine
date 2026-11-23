#!/usr/bin/env node
// Compatibility command: rendering now imports one in-repository module.
import * as canonical from "../apps/web/public/mazebench-runtime/joined-voxel-surface.mjs";
import * as browser from "../ui/joined-voxel-surface.mjs";
if (process.argv.slice(2).some(arg => arg !== "--check")) {
  throw new Error("External renderer sync was retired. Edit apps/web/public/mazebench-runtime/joined-voxel-surface.mjs here.");
}
for (const key of Object.keys(canonical)) {
  if (browser[key] !== canonical[key]) throw new Error("Renderer implementation drift: " + key);
}
console.log("Both browser applications use the same renderer kernel module.");
