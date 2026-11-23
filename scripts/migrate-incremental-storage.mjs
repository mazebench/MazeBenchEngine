// Operator-only, exact-hash migration. Never exposed to benchmark agents/HTTP.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,constants} from 'node:fs';
import {readFile,writeFile,mkdir,copyFile,rm,rename} from 'node:fs/promises';
import path from 'node:path';
import {currentRuntimeHashes,verifyCheckpoint,verifyRunIntegrity,assertRunConfiguration} from '../benchmarking/v1/integrity.mjs';
import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {BenchmarkGameRuntime} from '../benchmarking/v1/runtime.mjs';
import {VisionRuntime} from '../benchmarking/vision/runtime.mjs';
import {IceBenchmarkRuntime} from '../ice-maze/v1/benchmark-runtime.mjs';
import {SlotskiBenchmarkRuntime} from '../slotski/v1/benchmark-runtime.mjs';
import {providerRuntimeHashes} from '../benchmarking/providers/claude-policy.mjs';
import {visionRuntimeHashes} from '../benchmarking/vision/policy.mjs';
import {worldRuntimeHashes} from '../benchmarking/worlds/policy.mjs';
import {worldRuntimeHashes as slotskiRuntimeHashes} from '../benchmarking/slotski/policy.mjs';
import {isIncremental,verifyJournal,journalHead} from '../benchmarking/storage/journal.mjs';
const digest=x=>createHash('sha256').update(x).digest('hex');
const files=['game-state.json','summary.json','display.json','checkpoint.json','run.json','integrity.json'];
async function atomic(file,value){const temporary=file+'.migration-tmp';await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await rename(temporary,file);}
export function authorizeHashUpdate(previous,current,plan){
  for(const file of new Set([...Object.keys(previous),...Object.keys(current)])){
    if(previous[file]===current[file])continue;
    const allowed=plan.files[file];assert(allowed&&allowed.before===(previous[file]??null)&&allowed.after===(current[file]??null),`Unapproved runtime change: ${file}`);
  }
  return current;
}
export async function migrateIncrementalRun(root,directory,{plan,backupDirectory,assertInactive=async()=>{}}){
  await assertInactive();assert(!isIncremental(directory),'Run already migrated.');
  const originalRun=await readFile(path.join(directory,'run.json')),originalManifest=await readFile(path.join(directory,'integrity.json'));
  const metadata=JSON.parse(originalRun),manifest=JSON.parse(originalManifest);
  assert(['paused','stopped'].includes(metadata.status),'Pause the run before migrating.');assert(!existsSync(path.join(directory,'integrity-violation.json')),'Invalidated runs cannot be resealed.');
  assert.equal(digest(originalManifest),metadata.integrity.manifest_sha256,'Original manifest was altered.');assertRunConfiguration(metadata,manifest);verifyCheckpoint(directory);
  assert.equal(digest(await readFile(path.join(directory,'prompt.md'))),metadata.effective_prompt_sha256,'Prompt was altered.');
  const updated=structuredClone(manifest);updated.files=authorizeHashUpdate(manifest.files,await currentRuntimeHashes(root),plan);
  for(const[key,hashes]of [['provider_runtime',providerRuntimeHashes],['world_runtime',metadata.world==='slotski'?slotskiRuntimeHashes:worldRuntimeHashes],['vision_runtime',visionRuntimeHashes]])if(updated.configuration[key])updated.configuration[key]=authorizeHashUpdate(updated.configuration[key],await hashes(root),plan);
  const Runtime=metadata.observation_mode==='vision'?VisionRuntime:metadata.world==='ice-maze'?IceBenchmarkRuntime:metadata.world==='slotski'?SlotskiBenchmarkRuntime:BenchmarkGameRuntime;
  const beforeState=await readCheckpointJson(directory),beforeSummary=await readCheckpointJson(directory,'summary.json');
  const runtime=await Runtime.open(root,directory);assert.deepEqual(runtime.internal,beforeState);assert.deepEqual(runtime.summary(),beforeSummary,'Summary differs before migration.');
  await mkdir(backupDirectory,{recursive:true,mode:0o700});for(const file of files)await copyFile(path.join(directory,file),path.join(backupDirectory,file),constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
  await assertInactive();assert.deepEqual(await readFile(path.join(directory,'run.json')),originalRun,'Run changed during migration preparation.');verifyCheckpoint(directory);
  let generation;
  try{
    await runtime.enableIncremental();generation=journalHead(directory).generation;
    assert.deepEqual(await readCheckpointJson(directory),beforeState,'Game or undo history changed during migration.');
    assert.deepEqual(await readCheckpointJson(directory,'summary.json'),beforeSummary,'Score or public history changed during migration.');
    updated.configuration.storage_format='incremental-v1';metadata.storage_format='incremental-v1';
    const encoded=JSON.stringify(updated)+'\n';metadata.integrity={...metadata.integrity,manifest_sha256:digest(encoded),asset_count:Object.keys(updated.files).length};
    metadata.runtime_repairs=[...(metadata.runtime_repairs||[]),{kind:'operator-runtime-update',at:new Date().toISOString(),action_count:beforeState.actionCount,
      reason:'Incremental authenticated move storage and bounded history delivery.',old_manifest_sha256:manifest?digest(originalManifest):null,new_manifest_sha256:metadata.integrity.manifest_sha256,backup:backupDirectory,
      resume_notice:'Move storage was optimized. Your current board, gems, undo history, model, and Python setting are unchanged. The records list shows recent moves; read move_history/index.json to browse older history pages.'}];
    await atomic(path.join(directory,'integrity.json'),updated);await atomic(path.join(directory,'run.json'),metadata);
    await verifyRunIntegrity(root,directory,metadata.integrity);verifyJournal(directory,{full:true});
    const report={id:metadata.id,action_count:beforeState.actionCount,gems_collected:beforeSummary.gems_collected,storage_format:metadata.storage_format,backup:backupDirectory,game_equal:true,summary_equal:true};
    await writeFile(path.join(backupDirectory,'migration.json'),JSON.stringify(report,null,2));return report;
  }catch(error){for(const file of files)await copyFile(path.join(backupDirectory,file),path.join(directory,file));if(generation)await rm(path.join(directory,'journal',generation),{recursive:true,force:true});verifyCheckpoint(directory);throw error;}
}
