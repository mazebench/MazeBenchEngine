# MazeBench

MazeBench is a local browser app for building and playing persistent 3D puzzle
worlds, then evaluating coding agents in the same JavaScript engine.

## Quick start

Install from PyPI (Python 3.9+ and Node.js are required):

```bash
pip install mazebench
mazebench launch
```

Or run from a source checkout:

```bash
npm ci
npm run dev
```

The site opens at `http://localhost:3000`.

## Modes

- **Play** — explore the main world or a local world.
- **Build** — create and edit worlds stored on your machine.
- **Agent** — run coding agents or Prime Intellect Verifiers against a world.

## Agent runs

Local coding-agent runs use Docker by default so the evaluated agent receives
only the game controls, not the repository or host filesystem.

```bash
mazebench build
mazebench model=codex moves=10
mazebench model=claude moves=10
```

Codex runs require the Codex CLI; Claude runs require Claude Code. Replay video
also requires a Chromium-family browser and `ffmpeg`. Run `mazebench --help`
for commands and options.

For Prime Intellect Verifiers:

```bash
pip install "mazebench[prime]"
mazebench prime install
mazebench prime eval model=openai/gpt-5-nano n=1 r=1
```

## Development

```bash
npm ci
npm test
```

Further documentation:

- [Prime environment](environments/mazebench/README.md)
- [Maze level format](docs/maze-level-format.md)
- [Python packaging](docs/packaging.md)

## License

[MIT](LICENSE)
