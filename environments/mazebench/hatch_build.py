"""Refuse incomplete packages; the sdist retains the prepared game snapshot."""

import hashlib
import json
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        root = Path(self.root) / "mazebench/runtime"
        if not (root / "snapshot.json").is_file():
            raise RuntimeError(
                "Prepare the game snapshot from the repository root first: "
                "node scripts/package-prime-environment.mjs"
            )
        snapshot = json.loads((root / "snapshot.json").read_text())
        source = Path(self.root).parents[1]
        in_checkout = (source / "scripts/package-prime-environment.mjs").is_file()
        for name, digest in snapshot["files"].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"Damaged packaged MazeBench asset: {name}")
            if in_checkout and hashlib.sha256((source / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError(f"Stale packaged MazeBench asset: {name}; run node scripts/package-prime-environment.mjs")
