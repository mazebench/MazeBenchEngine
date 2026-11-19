#!/usr/bin/env python3
"""Save an Anthropic key privately for MazeBench's DeepSeek Harness adapter."""
import getpass
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile

if not sys.stdin.isatty():
    sys.exit("Run this command in Terminal. The key is entered with echo disabled.")
print("Use a key from Jonathan’s Individual Org, where the Ultra credits were claimed.")
key = getpass.getpass("Anthropic API key (hidden): ").strip()
if not key.startswith("sk-ant-") or any(c.isspace() for c in key):
    sys.exit("That does not look like an Anthropic API key. Nothing was saved.")
connection = http.client.HTTPSConnection("api.anthropic.com", timeout=30)
try:
    connection.request("GET", "/v1/models?limit=1000", headers={"x-api-key": key, "anthropic-version": "2023-06-01"})
    response = connection.getresponse()
    if response.status != 200:
        sys.exit(f"Claude model lookup returned HTTP {response.status}. Nothing was saved.")
    models = json.loads(response.read(2 * 1024 * 1024))["data"]
finally:
    connection.close()
home = Path(os.environ.get("MAZEBENCH_DEEPSEEK_AUTH_HOME", str(Path.home() / ".dsh")))
home.mkdir(parents=True, exist_ok=True, mode=0o700)
file = home / "mazebench-anthropic.credentials.json"
fd, temp = tempfile.mkstemp(prefix=".anthropic-", dir=home)
try:
    with os.fdopen(fd, "w") as stream:
        json.dump({"version": 1, "refs": {"ANTHROPIC_API_KEY": key}}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, file)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print("Connected. Key saved with owner-only permissions; it was not printed or added to the repository.")
for model in models:
    if model.get("id") in ("claude-haiku-5-5", "claude-sonnet-5-5"):
        print("Available:", model["id"])
