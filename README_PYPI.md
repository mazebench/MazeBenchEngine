# MazeBench

MazeBench is a local browser app for building and playing persistent 3D puzzle
worlds, then evaluating coding agents in the same JavaScript engine.

## Install

Python 3.9+ and Node.js are required.

```bash
pip install mazebench
mazebench launch
```

This opens the Play, Build, and Agent modes. Run `mazebench --help` for other
commands.

Local agent runs also require Docker and either the Codex CLI or Claude Code.
Replay video requires a Chromium-family browser and `ffmpeg`.

[Website](https://mazebench.com) ·
[Source](https://github.com/mazebench/MazeBenchEngine)
