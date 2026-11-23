import assert from 'node:assert/strict';import test from 'node:test';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';import {createRunIntegrity,verifyRunIntegrity,verifyCheckpoint} from '../benchmarking/v1/integrity.mjs';import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {migrateIncrementalRun,authorizeHashUpdate} from '../scripts/migrate-incremental-storage.mjs';
const root=path.resolve(import.meta.dirname,'..'),sha=v=>createHash('sha256').update(v).digest('hex');
test('operator migration preserves all game, score, undo and conversation identities and rejects unrelated drift',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'journal-migration-'));try{
  const prompt='fixture',configuration={model:'gpt-6-astra',effort:'max',tools_enabled:false,action_limit:null,start_room:'HxI',effective_prompt_sha256:sha(prompt)};
  const integrity=await createRunIntegrity(root,directory,configuration);await writeFile(path.join(directory,'prompt.md'),prompt);
  const meta={...configuration,id:'run-fixture',status:'paused',codex_thread_id:'fixed-session',integrity};await writeFile(path.join(directory,'run.json'),JSON.stringify(meta));
  const runtime=await BenchmarkGameRuntime.create(root,directory,{actionLimit:null});for(const a of ['up','up','undo','camera right'])await runtime.apply(a);
  const before=structuredClone(runtime.internal),summary=runtime.summary();
  const report=await migrateIncrementalRun(root,directory,{plan:{files:{}},backupDirectory:path.join(directory,'operator-backup')});assert.equal(report.game_equal,true);
  assert.deepEqual(await readCheckpointJson(directory),before);assert.deepEqual(await readCheckpointJson(directory,'summary.json'),summary);
  const after=JSON.parse(await readFile(path.join(directory,'run.json')));assert.equal(after.codex_thread_id,meta.codex_thread_id);for(const key of Object.keys(configuration))assert.equal(after[key],meta[key]);await verifyRunIntegrity(root,directory,after.integrity);verifyCheckpoint(directory);
  await assert.rejects(()=>migrateIncrementalRun(root,directory,{plan:{files:{}},backupDirectory:path.join(directory,'second-backup')}),/already migrated/);
  assert.throws(()=>authorizeHashUpdate({'engine.wasm':'original'},{'engine.wasm':'changed'},{files:{}}),/Unapproved/);
  assert.throws(()=>authorizeHashUpdate({'runtime.mjs':'unexpected'},{'runtime.mjs':'after'},{files:{'runtime.mjs':{before:'before',after:'after'}}}),/Unapproved/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
