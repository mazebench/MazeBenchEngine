// Operator-only migration. Current code hashes must match the exact reviewed
// before/after plan; game checkpoints are never rewritten by this migration.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {currentRuntimeHashes,verifyRunIntegrity,verifyCheckpoint,assertRunConfiguration} from '../benchmarking/v1/integrity.mjs';
import {readCheckpointJson} from '../benchmarking/v1/checkpoint-json.mjs';
import {LIVE_WORLD_POLICY,createLiveWorld} from '../benchmarking/storage/live-world.mjs';
import {authorizeHashUpdate} from './migrate-incremental-storage.mjs';
import {visionRuntimeHashes} from '../benchmarking/vision/policy.mjs';
import {providerRuntimeHashes} from '../benchmarking/providers/claude-policy.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function atomic(file,bytes){const temp=file+'.live-world-tmp';await writeFile(temp,bytes,{flag:'wx',mode:0o600});await rename(temp,file);}
export async function enableLiveWorldUpdates(root,directory,{plan,backupDirectory,assertInactive=async()=>{}}){
 await assertInactive();
 const originalRun=await readFile(path.join(directory,'run.json')),originalManifest=await readFile(path.join(directory,'integrity.json')),checkpoint=await readFile(path.join(directory,'checkpoint.json'));
 const metadata=JSON.parse(originalRun),manifest=JSON.parse(originalManifest);
 assert(['paused','stopped'].includes(metadata.status),'Pause the run before upgrading its runtime.');
 assert(!metadata.world||metadata.world==='main-world','This migration is only for MazeBench.');
 assert(!metadata.world_updates,'Already using live room updates.');
 assert(!existsSync(path.join(directory,'integrity-violation.json')),'Cannot approve an invalidated run.');
 assert.equal(sha(originalManifest),metadata.integrity.manifest_sha256);assertRunConfiguration(metadata,manifest);verifyCheckpoint(directory);
 if (metadata.effective_prompt_sha256) assert.equal(sha(await readFile(path.join(directory,"prompt.md"))),metadata.effective_prompt_sha256,"The run prompt changed.");
 const current=await currentRuntimeHashes(root);
 // The old room bytes are required as the initial revision, even if arbitrary
 // other changes were included accidentally in an operator hash plan.
 for(const[file,hash]of Object.entries(manifest.files))if(file.startsWith('level-data/v2/main-world/'))assert.equal(current[file],hash,`Authored world drift must be repaired before migration: ${file}`);
 const updated=structuredClone(manifest);updated.files=authorizeHashUpdate(updated.files,current,plan);
 for(const[key,hashes]of [['vision_runtime',visionRuntimeHashes],['provider_runtime',providerRuntimeHashes]])if(updated.configuration[key])updated.configuration[key]=authorizeHashUpdate(updated.configuration[key],await hashes(root),plan);
 const before=await readCheckpointJson(directory);
 await mkdir(backupDirectory,{recursive:true,mode:0o700});
 await writeFile(path.join(backupDirectory,'run.json'),originalRun,{flag:'wx',mode:0o600});await writeFile(path.join(backupDirectory,'integrity.json'),originalManifest,{flag:'wx',mode:0o600});
 let created=false;
 try{
  assert(!existsSync(path.join(directory,'world-updates')),'Unexpected preexisting room revision directory.');created=true;
  updated.configuration.world_base_sha256=await createLiveWorld(root,directory);updated.configuration.world_updates=LIVE_WORLD_POLICY;
  metadata.world_updates=LIVE_WORLD_POLICY;
  const encoded=JSON.stringify(updated)+'\n';metadata.integrity={...metadata.integrity,manifest_sha256:sha(encoded),asset_count:Object.keys(current).length};
  metadata.runtime_repairs=[...(metadata.runtime_repairs||[]),{kind:'operator-runtime-update',at:new Date().toISOString(),action_count:before.actionCount,reason:'Enable signed editor room revisions at fresh entry, preserving current boards and history.',resume_notice:'Operator room edits now apply on fresh entry. Your current board, reset state, and undo history stay intact. Reinspect any room whose observation reports an operator update.'}];
  await assertInactive();assert((await readFile(path.join(directory,'run.json'))).equals(originalRun),'Run changed during preparation.');
  await atomic(path.join(directory,'integrity.json'),encoded);await atomic(path.join(directory,'run.json'),JSON.stringify(metadata)+'\n');
  await verifyRunIntegrity(root,directory,metadata.integrity);verifyCheckpoint(directory);assert((await readFile(path.join(directory,'checkpoint.json'))).equals(checkpoint));assert.deepEqual(await readCheckpointJson(directory),before);
  return{id:metadata.id,action_count:before.actionCount,policy:LIVE_WORLD_POLICY,game_unchanged:true,backup:backupDirectory};
 }catch(error){await atomic(path.join(directory,'integrity.json'),originalManifest);await atomic(path.join(directory,'run.json'),originalRun);if(created)await rm(path.join(directory,'world-updates'),{recursive:true,force:true});throw error;}
}
