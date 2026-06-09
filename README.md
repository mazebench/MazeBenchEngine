# MazeBench

The MazeBench env can run in the browser, in the terminal,
through Prime Intellect Verifiers, or through Codex.

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
prime eval run mazebench -m openai/gpt-5-nano -n 1 -r 1 -s -C "maze_actions,maze_scorecard,maze_replay" -d
```

Use your own configured model after `-m`, or omit `-m` to use your Prime
default. The terminal prints the run summary.

View saved evals:

```bash
prime eval view
```

Export scorecard files and a replay video from a saved eval directory:

```bash
npm run maze:replay -- environments/mazebench/outputs/evals/<model>/<run-id>
```

## 4. Run it with Codex

Print the prompt that tells Codex how to play:

```bash
npm run --silent maze:codex -- prompt default
```

Run Codex directly:

```bash
codex exec --sandbox workspace-write "$(npm run --silent maze:codex -- prompt default)"
```

Codex will use commands like:

```bash
npm run --silent maze:codex -- start
npm run --silent maze:codex -- observe
npm run --silent maze:codex -- up
npm run --silent maze:codex -- rotate left
npm run --silent maze:codex -- scorecard
```

Codex session files live in `outputs/maze-codex/`.

Export a Codex run to scorecard files and video:

```bash
npm run --silent maze:codex -- video --video --fast --draft --fps 20 --width 400 --height 400
```

## License

MIT. See [LICENSE](LICENSE).
