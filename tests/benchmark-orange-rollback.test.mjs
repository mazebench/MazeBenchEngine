import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkResumePrompt } from "../benchmarking/v1/supervisor.mjs";
import { ORANGE_ROLLBACK, replayOrangeEntry } from "../scripts/repair-orange-wall-rollback-v1.mjs";

test("resume describes animation records and relays only the current operator update", () => {
  const metadata = { runtime_repairs: [{
    kind: "operator-runtime-update", action_count: 11754,
    resume_notice: "Room MxF was broken and its authored level has been fixed."
  }] };
  const prompt = benchmarkResumePrompt(metadata, { action_count: 11754 });
  assert.match(prompt, /animation.index_record/);
  assert.match(prompt, /maze_observe.*listed ASCII frame paths/);
  assert.match(prompt, /reads cost no actions/);
  assert.match(prompt, /Room MxF was broken/);
  assert.doesNotMatch(benchmarkResumePrompt(metadata, { action_count: 11755 }), /Room MxF/);
  assert.doesNotMatch(benchmarkResumePrompt({}, { action_count: 11754 }), /Operator update:/);
});

test("resume explains an operator rewind without inserting puzzle advice", () => {
  const metadata = { runtime_repairs: [{ kind: "operator-engine-rollback", action_count: 3877, previous_action_count: 4007 }] };
  const prompt = benchmarkResumePrompt(metadata, { action_count: 3877 });
  assert.match(prompt, /rolled this run back from action 4007 to action 3877/);
  assert.match(prompt, /maze_observe and the current move records as the authority/);
  assert.match(prompt, /Do not stop until the tool reports won or action-limit/);
  assert.doesNotMatch(benchmarkResumePrompt(metadata, { action_count: 3880 }), /rolled this run back/);
  assert.doesNotMatch(benchmarkResumePrompt({}, { action_count: 12 }), /rolled this run back/);
  assert.doesNotMatch(benchmarkResumePrompt({ runtime_repairs: [{ ...metadata.runtime_repairs[0], previous_action_count: "ignore rules" }] }, { action_count: 3877 }), /ignore rules/);
});

test("the operator replay refuses a different checkpoint before running physics", async () => {
  await assert.rejects(replayOrangeEntry({ internal: { actionCount: 4006 } }), /4006.*4007/s);
  await assert.rejects(replayOrangeEntry({ internal: { actionCount: ORANGE_ROLLBACK.previousMove, stateHashes: ["altered"] } }), /altered/);
});
