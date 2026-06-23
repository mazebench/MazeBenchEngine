# MazeBench

The MazeBench env can run in the browser, in the terminal, and through Prime
Intellect Verifiers v1. The Verifiers integration includes both normal
multi-turn chat-model runs and Codex CLI runs.

## 1. Set up the web app with Node

Install dependencies, run tests, then start the local server:

```bash
npm install
npm test
npm run dev
```

Open the app at:

```text
http://localhost:3000
```

## 2. Run the game in the terminal, see the scorecard, and save video

Start an interactive terminal game:

```bash
npm run maze:terminal
```

Controls:

- Arrow keys: move
- `i` / `k`: rotate camera up / down
- `j` / `l`: rotate camera left / right
- `z` or `u`: undo
- `r`: reset
- `q`: quit and print the scorecard

Interactive runs write replay files under `outputs/maze-terminal/<timestamp>/`.
When the run ends, answer the video prompt to save `maze_replay.mp4`.

For a non-interactive run that saves the scorecard and video:

```bash
npm run maze:terminal -- --moves UDLR --once --record-replay --video --fast --draft --fps 20 --width 400 --height 400
```

The output folder contains:

- `maze_scorecard.json`
- `maze_actions.txt`
- `maze_replay.json`
- `results.jsonl`
- `maze_replay.mp4` when video is enabled

## 3. Run with Prime Intellect Verifiers and see results

Install `uv` if you do not already have it:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

On macOS, Homebrew also works:

```bash
brew install uv
```

Install the local environment from `./environments/mazebench`:

```bash
prime env install mazebench
```

Run a small eval:

```bash
prime eval run mazebench -m openai/gpt-5-nano -n 1 -r 1 -s --max-turns 8 -d
```

Use your own configured model after `-m`, or omit `-m` to use your Prime
default. The terminal prints the run summary. MazeBench v1 stores replay
artifacts under `info.maze_actions`, `info.maze_scorecard`, and
`info.maze_replay` in `results.jsonl`.

View saved evals:

```bash
prime eval view
```

Export scorecard files and a replay video from a saved eval directory:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

## 4. Run Codex through Verifiers v1

MazeBench includes a `mazebench_codex` v1 plugin. It uses your local `codex`
CLI as the harness, routes Codex model calls through the Verifiers v1
interception server, and writes replay artifacts under `outputs/maze-codex-v1/`.

```bash
cd environments/mazebench
uv run eval mazebench_codex \
  -m openai/gpt-5-codex \
  -n 1 -r 1 \
  --taskset.max-actions 100 \
  --max-turns 40 \
  --rich false
```

`--taskset.max-actions` is the maze action budget. `--max-turns` is still useful
because Verifiers counts Codex's internal model/tool-call turns while the CLI is
working. The harness strips the `openai/` prefix before invoking `codex exec` so
Codex can use its local model metadata, while Verifiers still routes/bills the
Prime model.

Export the saved v1 trace to scorecard files and video the same way as normal
MazeBench evals:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

## 5. Run vision observations

The normal `mazebench` taskset can send perspective PNG observations instead of
ASCII boards:

```bash
cd environments/mazebench
uv run eval mazebench \
  -m openai/gpt-4.1-mini \
  -n 1 -r 1 \
  --taskset.observation-mode vision \
  --taskset.vision-width 512 \
  --taskset.vision-height 512 \
  --max-turns 8 \
  --rich false
```

Vision mode keeps the same JS game state, allowed commands, terminal conditions,
and gem-only reward as ASCII mode. It sends a short text status plus a
perspective image of the current room, with no ASCII board.

## License

MIT. See [LICENSE](LICENSE).
