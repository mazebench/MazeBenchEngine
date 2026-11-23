import { VERIFIED_CODEX_VERSIONS } from "./v1/codex-installation.mjs";

// Operator-reviewed release admission, deliberately outside frozen run assets.
// Existing records keep their exact runtime and pinned executable hashes. This
// only admits a new CLI at launch; it never rewrites manifests or adds tools.
// 0.159.2: exact wire catalog/Max routing, resume/fork/compaction, all regression
// cases (one Chrome startup retry), engine parity, and live Python off/on passed.
// 0.164.0: real Codex vision/MCP wire checks with Python off/on, Fast launch
// attestation, and the adversarial capability suite passed. Keep older binaries
// installed: running records retain their original executable and hashes.
export const ADDITIONAL_VERIFIED_CODEX_VERSIONS = Object.freeze(["codex-cli 0.159.2", "codex-cli 0.164.0"]);
for (const version of ADDITIONAL_VERIFIED_CODEX_VERSIONS) VERIFIED_CODEX_VERSIONS.add(version);
