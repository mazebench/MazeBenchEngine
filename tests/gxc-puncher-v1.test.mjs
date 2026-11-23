import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBenchmarkAssets } from '../benchmarking/v1/runtime.mjs';
import { PlaySessionV1 } from '../play/v1/play-session.mjs';
import { SolutionsModel } from '../solutions/v1/model.mjs';

const moves = [
  'up', 'up', 'left', 'down', 'left', ...Array(8).fill('up'),
  'left', 'up', 'right', 'right', 'down', 'right', 'up', 'up'
];

for (const mode of ['engine', 'Play', 'Solutions']) {
  test(`G×C rearms its blocked puncher before the next left push in ${mode}`, async () => {
    const assets = await loadBenchmarkAssets(new URL('..', import.meta.url).pathname);
    const room = assets.roomsByLabel.get('GXC');
    const frames = [];
    let state = assets.engine.createState(room);
    let move;
    if (mode === 'Play') {
      const session = new PlaySessionV1(assets.engine, assets.blocks, {
        frameDelay: 1,
        onFrame: frame => frames.push(frame),
        resolveCommand: (board, activeRoom, direction) =>
          assets.connectedWorld.simulateCommand(board, activeRoom, direction)
      });
      session.open(room);
      move = async direction => { await session.move(direction); state = session.state; };
    } else if (mode === 'Solutions') {
      const model = new SolutionsModel(assets.engine, assets, 'gxc-puncher-regression');
      model.restoreSpot(`start:${room.fileName}`);
      move = async direction => {
        await model.move(direction, frame => frames.push(frame.state));
        state = model.current.state;
      };
    } else {
      move = async direction => {
        const result = await assets.engine.simulateCommand(state, direction, assets.blocks);
        assert.equal(result.cycle, null);
        frames.push(...result.frames);
        state = result.final;
      };
    }
    const role = object => assets.definitions.get(object.blockId)?.roleId;
    const player = board => board.objects.find(object => role(object) === 'player');
    const puncher = board => board.objects.find(object =>
      role(object) === 'puncher' && object.orientation === 'right');
    for (const direction of moves) await move(direction);
    assert.deepEqual([player(state).x, player(state).y], [4, 3]);
    assert.equal(puncher(state).engineGenericId, 3, 'the preceding punch was blocked');
    frames.length = 0;
    await move('left');
    assert.deepEqual(frames.map(frame => [player(frame).x, player(frame).y]),
      [[3, 3], [4, 3], [4, 3]], 'push, punch back, then settle');
    assert.deepEqual(frames.map(frame => puncher(frame).engineGenericId), [2, 3, 2]);
    assert.deepEqual([player(state).x, player(state).y], [4, 3]);
    assert.deepEqual([puncher(state).x, puncher(state).y], [3, 3]);
    assert(state.objects.some(object => role(object) === 'weightless-pushable' &&
      object.groupId === 0 && object.x === 2 && object.y === 3));
  });
}
