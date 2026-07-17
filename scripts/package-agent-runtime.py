#!/usr/bin/env python3
"""Build the deterministic runtime archive shipped by mazebench-agent."""

from __future__ import annotations

import argparse
import gzip
import io
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "environments" / "mazebench" / "mazebench" / "runtime"
TARGET = (
    ROOT
    / "environments"
    / "mazebench_agent"
    / "mazebench_agent"
    / "runtime.tar.gz"
)


def archive_bytes() -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buffer, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for item in sorted(SOURCE.rglob("*")):
                if not item.is_file():
                    continue
                info = archive.gettarinfo(str(item), arcname=str(item.relative_to(SOURCE)))
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                info.mtime = 0
                with item.open("rb") as stream:
                    archive.addfile(info, stream)
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    expected = archive_bytes()
    current = TARGET.read_bytes() if TARGET.exists() else b""
    if options.check:
        return 0 if current == expected else 1
    if current != expected:
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        TARGET.write_bytes(expected)
        print(f"package-agent-runtime: wrote {TARGET.relative_to(ROOT)}")
    else:
        print("package-agent-runtime: archive is current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
