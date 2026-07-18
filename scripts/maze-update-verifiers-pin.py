#!/usr/bin/env python3
"""Advance the exact Verifiers pin to current upstream main."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "environments" / "mazebench" / "pyproject.toml"
REMOTE = "https://github.com/PrimeIntellect-ai/verifiers.git"
PIN = re.compile(
    r'("verifiers @ git\+https://github\.com/PrimeIntellect-ai/verifiers\.git@)'
    r"[0-9a-f]{40}"
    r'(")'
)


def upstream_revision() -> str:
    output = subprocess.check_output(
        ["git", "ls-remote", REMOTE, "refs/heads/main"], text=True
    )
    revision = output.split()[0]
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("Verifiers main did not resolve to a full Git revision")
    return revision


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--revision", help="use a known full revision instead of querying main")
    args = parser.parse_args()
    revision = args.revision or upstream_revision()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        parser.error("--revision must be a full 40-character lowercase Git SHA")
    source = PROJECT.read_text(encoding="utf-8")
    updated, count = PIN.subn(rf"\g<1>{revision}\g<2>", source)
    if count != 1:
        raise RuntimeError("could not find the single exact Verifiers dependency pin")
    PROJECT.write_text(updated, encoding="utf-8")
    print(revision)


if __name__ == "__main__":
    main()
