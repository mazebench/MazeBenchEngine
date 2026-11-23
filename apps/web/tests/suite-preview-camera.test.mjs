import assert from 'node:assert/strict';
import test from 'node:test';
import { createSuitePreviewState, stepPreviewCamera, suitePreviewReducer } from '../app/suitePreviewCamera.mjs';

const request = (state, key = 'room:start') => suitePreviewReducer(state, { type: 'request', key, testId: 'room', frameIndex: 0, generation: state.generation });
const complete = (state, dataUrl, generation = state.generation) => suitePreviewReducer(state, { type: 'complete', key: 'room:start', dataUrl, generation });
const turn = (state, key) => suitePreviewReducer(state, { type: 'camera', key });

test('A/D turn by 90 degrees, wrap after four turns, and leave tilt unchanged', () => {
  const initial = createSuitePreviewState().camera;
  const left = stepPreviewCamera(initial, 'a');
  assert.equal(left.yaw, Math.PI * 1.5);
  assert.equal(left.tilt, initial.tilt);
  assert.deepEqual(stepPreviewCamera(left, 'D'), initial);
  let camera = initial;
  for (let i = 0; i < 4; i++) camera = stepPreviewCamera(camera, 'd');
  assert.deepEqual(camera, initial);
});

test('W/S tilt the view without changing yaw or exceeding the editor limits', () => {
  const initial = stepPreviewCamera(createSuitePreviewState().camera, 'd');
  assert.ok(stepPreviewCamera(initial, 's').tilt > initial.tilt);
  assert.ok(stepPreviewCamera(initial, 'w').tilt < initial.tilt);
  let camera = initial;
  for (let i = 0; i < 30; i++) camera = stepPreviewCamera(camera, 's');
  assert.equal(camera.tilt, Math.PI);
  assert.equal(camera.yaw, initial.yaw);
  assert.equal(stepPreviewCamera(camera, 's'), camera);
  for (let i = 0; i < 30; i++) camera = stepPreviewCamera(camera, 'w');
  assert.equal(camera.tilt, 0);
  assert.equal(stepPreviewCamera(camera, 'w'), camera);
});

test('unrelated keys and repeated motion at a tilt limit do not invalidate previews', () => {
  const state = createSuitePreviewState();
  assert.equal(turn(state, 'x'), state);
  const top = turn(state, 'w');
  assert.equal(turn(top, 'w'), top);
});

test('a new camera cancels queued work while retaining the last image until replacement', () => {
  const original = complete(request(createSuitePreviewState()), 'north');
  const pending = request(original, 'other:start');
  const rotated = turn(pending, 'd');
  assert.equal(rotated.generation, 1);
  assert.deepEqual(rotated.queue, []);
  assert.equal(rotated.previews['room:start'].dataUrl, 'north');
  const refreshed = complete(request(rotated), 'east');
  assert.deepEqual(refreshed.previews['room:start'], { dataUrl: 'east', generation: 1 });
  assert.deepEqual(original.previews['room:start'], { dataUrl: 'north', generation: 0 });
});

test('late requests and captures from an old angle cannot overwrite a newer angle', () => {
  const original = request(createSuitePreviewState());
  const rotated = request(turn(original, 'd'));
  assert.equal(complete(rotated, 'stale north', 0), rotated);
  assert.equal(suitePreviewReducer(rotated, { type: 'request', ...original.queue[0] }), rotated);
  const finished = complete(rotated, 'east');
  assert.equal(complete(finished, 'duplicate'), finished);
});

test('each frame is queued once per camera, including unavailable-image results', () => {
  const pending = request(createSuitePreviewState());
  assert.equal(request(pending), pending);
  const failed = complete(pending, '');
  assert.equal(request(failed), failed);
  assert.equal(request(turn(failed, 'd')).queue.length, 1);
});

test('changing angles repeatedly replaces images instead of retaining an angle history', () => {
  let state = createSuitePreviewState();
  for (let i = 0; i < 100; i++) {
    state = complete(request(turn(state, 'd')), `image-${i}`);
    assert.equal(Object.keys(state.previews).length, 1);
    assert.equal(state.queue.length, 0);
  }
});

test('reset restores the initial view and cancels an in-flight rotated request', () => {
  const initial = createSuitePreviewState();
  assert.equal(suitePreviewReducer(initial, { type: 'reset' }), initial);
  const moved = request(turn(turn(initial, 'd'), 's'));
  const reset = suitePreviewReducer(moved, { type: 'reset' });
  assert.deepEqual(reset.camera, initial.camera);
  assert.deepEqual(reset.queue, []);
  assert.equal(complete(reset, 'late', moved.generation), reset);
});

test('an idle preview queue retains its last frame so the renderer can be reused', () => {
  const pending = request(createSuitePreviewState());
  const completed = complete(pending, 'image');
  assert.equal(completed.lastJob, pending.queue[0]);
  assert.deepEqual(completed.queue, []);
  const rotated = turn(completed, 'd');
  assert.equal(rotated.lastJob, completed.lastJob);
  const next = request(rotated);
  assert.equal(next.lastJob, completed.lastJob);
  assert.equal(complete(next, 'new image').lastJob.generation, rotated.generation);
});
