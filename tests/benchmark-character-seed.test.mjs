import assert from 'node:assert/strict';
import test from 'node:test';
import {copyFile, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildRuntimeRelease} from '../benchmarking/runtime-release-store.mjs';
import {PlaybackReplay} from '../benchmarking/playback-replay.mjs';
import {replayAscii} from '../benchmarking/ui/replay-ascii.mjs';
import {hideAsciiGlyphNames} from '../render-ascii/v2/glyph-contract.mjs';

test('Antigravity seeds the signed ASCII observation and replay while preserving gameplay', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const temp = await mkdtemp(path.join(tmpdir(), 'mazebench-character-seed-'));
  t.after(() => rm(temp, {recursive:true, force:true}));
  const registryPath = path.join(temp, 'registry.mjs');
  await copyFile(path.join(root, 'benchmarking/version-registry.mjs'), registryPath);
  const release = await buildRuntimeRelease(root, {installRoot:temp, registryPath});
  const {BenchmarkSupervisor} = await import(pathToFileURL(path.join(release.root, 'benchmarking/antigravity-v2/supervisor.mjs')));
  const {BenchmarkGameRuntime} = await import(pathToFileURL(path.join(release.root, 'benchmarking/v1/runtime.mjs')));
  const cli = path.join(temp, 'agy');
  await writeFile(cli, '#!/bin/sh\nprintf "1.3.5\\n"\n', {mode:0o700});
  const model = 'gemini-4-neon-xhigh';
  const supervisor = new BenchmarkSupervisor(release.root, {
    recordsRoot:path.join(temp, 'records'), antigravityStateRoot:path.join(temp, 'homes'), antigravityBin:cli,
    antigravityStatus:async () => ({launch_ready:true, models:[{id:model, default_effort:'xhigh', efforts:['xhigh']}]})
  });
  supervisor.createAntigravityHome = async () => ({home:temp, config:{}});
  supervisor.startAntigravity = () => {};
  const spec = {provider:'antigravity', model, effort:'xhigh', world:'main-world', observation_mode:'ascii', tools_enabled:false, action_limit:null};
  await assert.rejects(supervisor.validateSpec({...spec, character_seed:{}}), /character seed/);
  const plain = await supervisor.launch(spec);
  const seeded = await supervisor.launch({...spec, character_seed:' 1234 '});
  const seedDir = supervisor.runDirectory(seeded.id);
  assert.equal(seeded.character_seed, '1234');
  assert.equal(seeded.effective_prompt_sha256, plain.effective_prompt_sha256);
  const signed = JSON.parse(await readFile(path.join(seedDir, 'integrity.json'), 'utf8'));
  assert.equal(signed.configuration.character_seed, '1234');
  await assert.rejects(supervisor.verifyRunCapabilityBoundary({...seeded, character_seed:'1235'}, seedDir), /character_seed/);

  const plainRuntime = await BenchmarkGameRuntime.open(release.root, supervisor.runDirectory(plain.id));
  const seededRuntime = await BenchmarkGameRuntime.open(release.root, seedDir);
  const beforePlain = await plainRuntime.renderObservation(), beforeSeeded = await seededRuntime.renderObservation();
  assert.notEqual(beforeSeeded.level, beforePlain.level);
  assert.equal(beforeSeeded.level, await hideAsciiGlyphNames(beforePlain.level, '1234'));
  assert.equal(beforeSeeded.state_hash, beforePlain.state_hash);
  assert.deepEqual(beforeSeeded.ascii_legend, []);

  const plainMove = await plainRuntime.apply('camera right'), seedMove = await seededRuntime.apply('camera right');
  assert.equal(seedMove.observation.level, await hideAsciiGlyphNames(plainMove.observation.level, '1234'));
  assert.equal(seedMove.action.stateHash, plainMove.action.stateHash);
  const {content} = await seededRuntime.readRecord(seedMove.action.animation.index_record);
  const {frames} = JSON.parse(content);
  const lastFrame = await seededRuntime.readRecord(frames.at(-1).record);
  assert.equal(lastFrame.content.slice(lastFrame.content.indexOf('\n') + 1).replace(/\n$/, ''), seedMove.observation.level);

  const replays = new PlaybackReplay(release.root);
  t.after(() => replays.close());
  const {world, movie} = await replays.chunk(seedDir, {limit:2});
  assert.equal(world.characterSeed, '1234');
  world.blockDefinitions = new Map(world.blocks.map(block => [block.id, block]));
  const clip = movie.clips.at(-1);
  assert.equal((await replayAscii(movie, world, clip, clip.duration)).text, seedMove.observation.level);
});
