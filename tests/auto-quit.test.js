const assert = require("node:assert/strict");
const {
  autoQuitLaunchParams,
  evaluateAutoQuit,
  isCameraRotationAction,
  normalizeAutoQuitConfig
} = require("../shared/auto-quit");

function actions(...hashes) {
  return hashes.map((board_state_hash) => ({ board_state_hash }));
}

assert.deepEqual(normalizeAutoQuitConfig({ auto_quit: true }), {
  enabled: true,
  threshold: 10,
  mode: "rolling",
  window: 100
});
assert.deepEqual(
  autoQuitLaunchParams({
    auto_quit: "true",
    auto_quit_threshold: -5,
    auto_quit_mode: "rolling",
    auto_quit_window: 100_001
  }),
  {
    auto_quit: true,
    auto_quit_threshold: 0,
    auto_quit_mode: "rolling",
    auto_quit_window: 10_000
  }
);

const cumulativeConfig = { auto_quit: true, auto_quit_threshold: 10, auto_quit_mode: "cumulative" };
assert.equal(evaluateAutoQuit("A", actions("A", "A", "A", "A", "A", "A", "A", "A"), cumulativeConfig), null);
assert.deepEqual(
  evaluateAutoQuit("A", actions("A", "A", "A", "A", "A", "A", "A", "A", "A"), cumulativeConfig),
  {
    mode: "cumulative",
    threshold: 10,
    window: null,
    percentage: 10,
    novel_states: 1,
    observed_states: 10,
    action_count: 9
  }
);

const rollingConfig = {
  auto_quit: true,
  auto_quit_threshold: 0,
  auto_quit_mode: "rolling",
  auto_quit_window: 3
};
assert.equal(evaluateAutoQuit("A", actions("B", "A", "A"), rollingConfig), null);
assert.deepEqual(evaluateAutoQuit("A", actions("B", "A", "A", "A"), rollingConfig), {
  mode: "rolling",
  threshold: 0,
  window: 3,
  percentage: 0,
  novel_states: 0,
  observed_states: 3,
  action_count: 4
});
assert.equal(
  evaluateAutoQuit("A", actions(...Array(99).fill("A")), {
    auto_quit: true,
    auto_quit_threshold: 10,
    auto_quit_mode: "rolling",
    auto_quit_window: 100
  }),
  null,
  "rolling auto-quit must wait for a full window"
);
assert.equal(evaluateAutoQuit("A", actions("A"), { auto_quit: false }), null);

assert.equal(isCameraRotationAction({ command_text: "rotate camera left" }), true);
assert.equal(isCameraRotationAction({ status: { action: "rotate_camera" } }), true);
assert.equal(isCameraRotationAction({ command_text: "no move" }), false);
const cameraNeutralActions = [
  { command_text: "up", board_state_hash: "A" },
  { command_text: "rotate camera left", board_state_hash: "A" },
  { command_text: "rotate camera right", board_state_hash: "A" },
  { command_text: "down", board_state_hash: "A" },
  { command_text: "no move", board_state_hash: "A" }
];
assert.deepEqual(evaluateAutoQuit("A", cameraNeutralActions, rollingConfig), {
  mode: "rolling",
  threshold: 0,
  window: 3,
  percentage: 0,
  novel_states: 0,
  observed_states: 3,
  action_count: 5
});
assert.equal(
  evaluateAutoQuit("A", cameraNeutralActions.slice(0, 4), rollingConfig),
  null,
  "camera rotations must not fill or lower the novelty window"
);

console.log("auto-quit: OK — cumulative and full-window rolling novelty thresholds are deterministic.");
