const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { collectedAllWorldGems } = require("../server/agent-runs");
const {
  HOSTED_TRAINING_DEFAULTS,
  createTrainingService,
  primeSetupKind
} = require("../server/training");

const ROOT_DIR = path.resolve(__dirname, "..");

assert.equal(collectedAllWorldGems(1, 69), false);
assert.equal(collectedAllWorldGems(68, 69), false);
assert.equal(collectedAllWorldGems(69, 69), true);
assert.equal(collectedAllWorldGems(70, 69), true);
assert.equal(collectedAllWorldGems(1, null), false);

assert.deepEqual(HOSTED_TRAINING_DEFAULTS, {
  observation_mode: "ascii",
  gem_reward_weight: 1,
  room_reward_weight: 0.1,
  push_reward_weight: 0.05,
  max_actions: 64,
  max_steps: 10,
  batch_size: 32,
  rollouts_per_example: 4,
  max_tokens: 512,
  temperature: 1
});

assert.equal(primeSetupKind({ cliOk: false, accountOk: false }), "install");
assert.equal(primeSetupKind({ cliOk: true, accountOk: false }), "login");
assert.equal(
  primeSetupKind({ cliOk: true, accountOk: true, error: "API key unauthorized" }),
  "login"
);
assert.equal(primeSetupKind({ cliOk: true, accountOk: true, error: "Network timed out" }), "");

const trainClient = fs.readFileSync(path.join(ROOT_DIR, "public", "train.js"), "utf8");
const agentClient = fs.readFileSync(path.join(ROOT_DIR, "public", "agent.js"), "utf8");
const appSource = fs.readFileSync(path.join(ROOT_DIR, "server", "app.js"), "utf8");
const pagesSource = fs.readFileSync(path.join(ROOT_DIR, "server", "pages.js"), "utf8");
assert.match(trainClient, /showPrimeSetup\(kind\)/);
assert.match(trainClient, /Prime login has expired or is no longer authorized/);
assert.match(trainClient, /uv tool install -U prime/);
assert.match(appSource, /primeInstalled && probeCommand/);
assert.match(agentClient, /showPrimeSetup\(environment/);
assert.match(pagesSource, /id="train-prime-setup-modal"/);
assert.match(pagesSource, /src="\/logos\/prime\.png"/);

const starterConfig = fs.readFileSync(path.join(ROOT_DIR, "configs", "rl", "mazebench.toml"), "utf8");
assert.match(starterConfig, /max_steps = 10/);
assert.match(starterConfig, /batch_size = 32/);
assert.match(starterConfig, /rollouts_per_example = 4/);
assert.match(starterConfig, /max_tokens = 512/);
assert.match(starterConfig, /max_actions = 64/);

const service = createTrainingService({
  buildWorlds: { countWorldGems: () => 69 },
  getGame: () => ({ worldMap: { levels: new Array(256) } }),
  rootDir: ROOT_DIR,
  worldMaps: { defaultLevelIdForGame: () => "level_HxI" }
});
const toml = service.trainingConfigToml({
  name: "MazeBench smoke",
  model: "Qwen/Qwen3.5-0.8B",
  maxSteps: 10,
  batchSize: 32,
  rolloutsPerExample: 8,
  maxTokens: 1024,
  temperature: 1,
  startLevelId: "level_HxI",
  gameWonGemCount: 69,
  rewards: { gems: 1, rooms: 0.1, pushes: 0.05 },
  maxActions: 256,
  observationMode: "ascii"
});
assert.match(toml, /model = "Qwen\/Qwen3\.5-0\.8B"/);
assert.match(toml, /rollouts_per_example = 8/);
assert.match(toml, /\[\[env\]\]\nid = "mazebench\/mazebench"/);
assert.match(toml, /\[env\.args\]/);
assert.match(toml, /game_won_gem_count = 69/);
assert.match(toml, /push_reward_weight = 0\.05/);
assert.match(toml, /max_actions = 256/);
assert.match(toml, /allow_quit = false/);
assert.match(toml, /observation_mode = "ascii"/);
const parsedToml = JSON.parse(
  execFileSync(
    "python3",
    ["-c", "import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))"],
    { encoding: "utf8", input: toml }
  )
);
assert.equal(parsedToml.env[0].id, "mazebench/mazebench");
assert.deepEqual(parsedToml.env[0].args, {
  num_train_examples: 1,
  num_eval_examples: 1,
  start_level_id: "level_HxI",
  game_won_gem_count: 69,
  gem_reward_weight: 1,
  room_reward_weight: 0.1,
  push_reward_weight: 0.05,
  max_actions: 256,
  allow_quit: false,
  observation_mode: "ascii"
});

const legacyProbe = execFileSync(
  "uv",
  [
    "run",
    "--project",
    path.join(ROOT_DIR, "environments", "mazebench"),
    "python",
    "-c",
    [
      "import verifiers",
      "env=verifiers.load_environment('mazebench', max_actions=1, allow_quit=False)",
      "assert env.env_id == 'mazebench'",
      "assert env.__class__.__name__ == 'LegacyMazeEnv'",
      "assert len(env.get_dataset(-1)) == 1",
      "print('legacy hosted adapter ready')"
    ].join("; ")
  ],
  { cwd: ROOT_DIR, encoding: "utf8" }
);
assert.match(legacyProbe, /legacy hosted adapter ready/);

const observationPolicyProbe = execFileSync(
  "uv",
  [
    "run",
    "--project",
    path.join(ROOT_DIR, "environments", "mazebench"),
    "python",
    "-c",
    [
      "from mazebench.mazebench import action_result_text,render_json_user_prompt,render_multiturn_user_prompt,render_vision_user_prompt",
      "s={'allowed_commands':['up'],'current_room':'level_HxI','current_view':'top-diagonal','gem_count':0,'json_observation':{'objects':{'player':[[4,15,0]]}},'level':'P..','player':{'x':4,'y':15,'elevation':0},'scorecard':{'current_position':{'x':4,'y':15,'elevation':0}},'visited_levels':['level_HxI'],'yaw':0}",
      "t=render_multiturn_user_prompt(status=s,target_text='play',result_text='start')",
      "v=render_vision_user_prompt(status=s,target_text='play',result_text='start')",
      "j=render_json_user_prompt(status=s,target_text='play',result_text='start')",
      "assert 'Player:' not in t and 'elevation=0' not in t",
      "assert 'Player:' not in v and 'elevation=0' not in v",
      "assert 'Player: x=4 y=15 elevation=0' in j",
      "assert 'scorecard' not in action_result_text(command='quit',status={**s,'quit':True}).lower()",
      "print('model observation policy ready')"
    ].join("; ")
  ],
  { cwd: ROOT_DIR, encoding: "utf8" }
);
assert.match(observationPolicyProbe, /model observation policy ready/);

const input = [
  { command: "observe" },
  { command: "move", direction: "right" },
  { command: "scorecard" },
  { command: "close" }
]
  .map((command) => JSON.stringify(command))
  .join("\n");
const output = execFileSync(
  process.execPath,
  [path.join(ROOT_DIR, "scripts", "maze-bridge.js"), "--level", "level_HxB", "--view", "top"],
  { cwd: ROOT_DIR, encoding: "utf8", input: `${input}\n` }
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(output[0].push_count, 0);
assert.equal(output[1].pushes_this_action, 19);
assert.equal(output[1].novel_push_count, 19);
assert.deepEqual(output[2].scorecard.blocks, { pushes: 19, novel_positions: 19 });

console.log("training tests passed");
