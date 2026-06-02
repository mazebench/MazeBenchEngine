# PixelGameTest

Browser-first maze game experiments with a new Prime Intellect Verifiers workspace for `mazebench`.

The web app still runs with Node:

```bash
npm install
npm test
npm run dev
```

There is also a terminal ASCII/isometric prototype that uses the same level parser and JS movement engine as the browser:

```bash
npm run maze:terminal -- --level level_HxI --view top-diagonal
```

Use arrow keys to move, `i/k` to rotate the camera up/down, `j/l` to rotate left/right, and `q` to quit. For a non-interactive smoke run:

```bash
npm run maze:terminal -- --level level_HxI --view top-diagonal --moves U --once
```

Interactive terminal runs now write local replay artifacts when the run ends:
`outputs/maze-terminal/<timestamp>/maze_scorecard.json`,
`maze_actions.txt`, `maze_replay.json`, `results.jsonl`, and
optionally `maze_replay.mp4`. After the scorecard is written, the terminal asks
whether to render a video; if you say yes, it asks for FPS and dimensions. Use
`--replay-out-dir <path>` to choose a directory, `--no-video` to skip the video
prompt, or `--no-replay` to disable artifacts for an interactive run. The video
prompt also asks for fast mode, which captures only the settled result of each
action instead of animation tweens. Video rendering reports capture/encode
progress with ETA and a rough expected MP4 size. For non-interactive runs, opt in with
`--record-replay`; add `--video --fast --fps <n> --width <px> --height <px>`
when you want a faster MP4:

```bash
npm run maze:terminal -- --level level_HxI --view top-diagonal --moves U --once --record-replay
```

To play locally through the same prompt/action surface that Prime Verifiers models see:

```bash
npm run maze:model -- --level level_HxI --view top-diagonal --target-gems 1
```

This prints the model-facing system prompt and user prompt, then accepts text commands such as `up`, `rotate camera left`, `undo`, `reset`, `go to level H I`, or `quit`.

Prime/Verifiers setup lives under `environments/`. The `mazebench` package now uses the JS runtime as the benchmark contract: the default environment is a `vf.MultiTurnEnv` text-action game loop backed by `scripts/maze-bridge.js`, observations render through `scripts/maze-terminal.js`, and gem/visited-room state is tracked during the rollout. The default starter task is `level_HxI`.
