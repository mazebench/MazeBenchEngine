#!/usr/bin/env python3
"""Install MazeBench's pinned Kimi Code CLI and save a private subscription key."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import platform
import tomllib
import urllib.request

VERSION = "2.3.1"
SHA256 = "f06ba6a3bb7ed2fc1f82590f7c22570736d9ee7344059fa92404ca75dc2d5b45"
ENDPOINTS = {"https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--import-existing", action="store_true", help="Import the existing ~/.kimi-code/config.toml subscription key")
    parser.add_argument("--replace-key", action="store_true", help="Securely prompt for a new Kimi Code Console key")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This verified Kimi integration currently requires Apple Silicon macOS.")
    root = Path.home() / ".mazebench/kimi"
    binary = root / "bin" / ("kimi-" + VERSION)
    binary.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not binary.exists() or hashlib.sha256(binary.read_bytes()).hexdigest() != SHA256:
        url = "https://code.kimi.com/kimi-code/binaries/" + VERSION + "/kimi-code-darwin-arm64"
        print("Downloading official Kimi Code " + VERSION + " for MazeBench…", flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != SHA256:
            raise SystemExit("Official binary checksum mismatch; installation refused.")
        temporary = binary.with_suffix(".download")
        temporary.write_bytes(data)
        temporary.chmod(0o755)
        temporary.replace(binary)
    target = root / "auth/credential.json"
    if not target.exists() or args.replace_key or args.import_existing:
        if args.import_existing:
            config = tomllib.loads((Path.home() / ".kimi-code/config.toml").read_text())
            candidates = [p for p in config.get("providers", {}).values()
                          if p.get("base_url") in ENDPOINTS and p.get("api_key")]
            if len(candidates) != 1:
                raise SystemExit("No unique Kimi Code subscription key found. Run setup without --import-existing to enter a Console key.")
            value = {k: candidates[0][k] for k in ("api_key", "base_url")}
        else:
            print("Create a Kimi Code key at https://www.kimi.com/code/console (membership billing).")
            key = getpass.getpass("Kimi Code API key (hidden): ").strip()
            if not key:
                raise SystemExit("No key entered.")
            value = {"api_key": key, "base_url": "https://api.kimi.ai/coding/v1"}
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(target.parent, 0o700)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(value, file)
            file.write("\n")
        os.chmod(target, 0o600)
    print("Kimi installed and private credential configured. Run npm run check:kimi to verify the model catalog.")
    print("Catalog availability does not prove paid entitlement or remaining quota; those are checked by Kimi on inference.")


if __name__ == "__main__":
    main()
