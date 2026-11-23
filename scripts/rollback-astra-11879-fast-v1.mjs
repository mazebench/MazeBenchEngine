// Operator-only, checkpoint-authenticated rollback for the user's MxG/NxF edits.
// It is never exposed to a benchmark agent or an HTTP/MCP mutation endpoint.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BenchmarkSupervisor, benchmarkResumePrompt, buildCodexArguments } from '../benchmarking/v1/supervisor.mjs';
import { BenchmarkGameRuntime } from '../benchmarking/v1/runtime.mjs';
import { readCheckpointJson } from '../benchmarking/v1/checkpoint-json.mjs';
import { assertRunConfiguration, verifyCheckpoint } from '../benchmarking/v1/integrity.mjs';
import { ConnectedWorldSessionV1 } from '../play/v1/connected-world-session.mjs';
import { cameraRelativeMoveDirection } from '../play/v1/camera-relative-input.mjs';
import { decodeVoxelRoom } from '../render/v1/voxel-world-v2.mjs';
import { originalStateHash } from './recalculate-gem-free-novelty-v1.mjs';

const root=path.resolve(import.meta.dirname,'..'),work=path.join(root,'work/rollback-11879-fast');
const plan=JSON.parse(await readFile(path.join(work,'plan.json'),'utf8'));
assert.equal(plan.id,'run-2026-09-04T19-29-31-992Z-772688');assert.equal(plan.to,11879);assert.equal(plan.newGemCount,11);assert.equal(plan.serviceTier,'fast');
const directory=path.join('/Users/jpappas/records/mazebench-benchmark',plan.id);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>JSON.stringify(value,null,2)+'\n';
const json=async file=>JSON.parse(await readFile(file,'utf8'));
async function fileHash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function cloneTree(source,dest){
 const info=await stat(source);if(info.isDirectory()){await mkdir(dest,{recursive:true,mode:0o700});for(const name of await readdir(source))await cloneTree(path.join(source,name),path.join(dest,name));}
 else{await mkdir(path.dirname(dest),{recursive:true,mode:0o700});await copyFile(source,dest,constants.COPYFILE_FICLONE);}
}
async function atomicCopy(source,dest){await mkdir(path.dirname(dest),{recursive:true,mode:0o700});const temp=dest+'.rollback-'+process.pid;await copyFile(source,temp,constants.COPYFILE_FICLONE);await rename(temp,dest);}
async function inactive(){const {runs}=await fetch('http://localhost:8080/api/benchmark/v1/runs').then(r=>r.json());const run=runs.find(r=>r.id===plan.id);assert.equal(run.status,'paused');assert.equal(run.runner_active,false);assert.equal(run.action_count,plan.from);}
async function verifyOriginal(){
 await inactive();verifyCheckpoint(directory);assert.equal(await fileHash(directory+'/integrity.json'),plan.manifestHash);
 const metadata=await json(directory+'/run.json'),manifest=await json(directory+'/integrity.json');
 assertRunConfiguration(metadata,manifest);assert.equal(metadata.integrity.manifest_sha256,plan.manifestHash);
 assert.equal(metadata.model,'gpt-6-astra');assert.equal(metadata.effort,'max');assert.equal(metadata.tools_enabled,false);assert.equal(metadata.action_limit,null);
 for(const [file,before]of Object.entries(manifest.files)){const change=plan.files[file];if(change)assert.equal(change.before,before);assert.equal(await fileHash(path.join(root,file)),change?.after||before,`Unreviewed runtime change: ${file}`);}
 return {metadata,manifest};
}

async function prepare(){
 const {metadata,manifest}=await verifyOriginal();
 const old=await readCheckpointJson(directory);assert.equal(old.actionCount,plan.from);assert.equal(old.stateHashes.at(-1),plan.fromHash);
 const target=old.actions[plan.to-1];assert.equal(target.action,'down');assert.equal(target.roomBefore,'MxF');assert.equal(target.roomAfter,'MxG');assert.equal(target.totalGems,11);
 const stack=[],prefix=[];let yaw=0,pitch=1;
 for(const a of old.actions){
  if(a.action==='undo')stack.pop();else if(a.stateChanged)stack.push(a.index-1);
  if(a.index<plan.to){if(a.action==='camera left')yaw=(yaw+3)%4;if(a.action==='camera right')yaw=(yaw+1)%4;if(a.action==='camera up')pitch=Math.max(0,pitch-1);if(a.action==='camera down')pitch=Math.min(4,pitch+1);}
  if(a.index===plan.to-1)prefix.push(...stack);
 }
 assert.equal(stack.length,old.history.length);const cursor=stack.indexOf(plan.to-1);assert(cursor>=0);assert.equal(stack[cursor+1],plan.to);assert.deepEqual(stack.slice(0,cursor),prefix);
 const prior=old.history[cursor],entry=old.history[cursor+1];
 const world=await json(root+'/level-data/v2/main-world/world.json');
 const edited=Object.entries(world.rooms).filter(([,p])=>['MxG','NxF'].includes(p.join('x'))).map(([f])=>f);
 const nxf=Object.entries(world.rooms).find(([,p])=>p.join('x')==='NxF')[0];
 const gems=old.gemsCollected.filter(key=>!key.startsWith(nxf+':'));assert.equal(old.gemsCollected.length-gems.length,1);assert.equal(gems.length,11);
 assert.equal(originalStateHash(prior,gems),plan.priorHash);assert.equal(originalStateHash(entry,gems),plan.targetHash);
 const visited=old.visitedRooms.slice(0,old.actions[plan.to-2].roomsVisited);assert.equal(visited.length,95);assert(edited.every(f=>!visited.includes(f)));
 assert(old.history.slice(0,cursor).every(s=>!edited.includes(s.roomFile)),'No old edited-room snapshot may survive in undo history');
 const futureUpdated=new Set(old.actions.slice(plan.to-1).filter(a=>['up','down','left','right'].includes(a.action)&&a.roomBefore!==a.roomAfter).map(a=>a.roomAfter));
 const survivingUpdated=visited.filter(f=>futureUpdated.has(world.rooms[f].join('x')));
 assert.deepEqual(survivingUpdated,[prior.roomFile],'Every post-cutoff room cache overwrite must be restored');
 const prefixActions=old.actions.slice(0,plan.to-1);
 const previous={...old,...structuredClone(prior),actionCount:plan.to-1,actions:prefixActions,history:old.history.slice(0,cursor),gemsCollected:gems,
  stateHashes:old.stateHashes.slice(0,plan.to),noveltyHashes:old.noveltyHashes.slice(0,plan.to),positions:old.positions.slice(0,plan.to),yaw,pitch,visitedRooms:visited,
  roomEntryStates:{...Object.fromEntries(visited.map(f=>[f,old.roomEntryStates[f]])),[prior.roomFile]:structuredClone(prior.roomEntryState)},
  blockedActions:prefixActions.filter(a=>a.blocked).length,resets:prefixActions.filter(a=>a.action==='reset').length,undos:prefixActions.filter(a=>a.action==='undo').length,
  cameraActions:prefixActions.filter(a=>a.action.startsWith('camera ')).length,deaths:prefixActions.filter(a=>a.died&&old.positions[a.index-1]).length};
 const staging=await mkdtemp(path.join(directory,'.rollback-11879-fast-'));
 for(const file of ['game-state.json','summary.json','checkpoint.json','prompt.md','sandbox-state/integrity-key','sandbox-state/direct-model-catalog.json'])await cloneTree(directory+'/'+file,staging+'/'+file);
 for(const [file,change]of Object.entries(plan.files))manifest.files[file]=change.after;
 manifest.configuration.service_tier='fast';const encoded=encode(manifest);await writeFile(staging+'/integrity.json',encoded,{mode:0o600});
 const integrity={...metadata.integrity,manifest_sha256:digest(encoded)};
 metadata.service_tier='fast';metadata.integrity=integrity;
 metadata.capability_policy.disabled_features=metadata.capability_policy.disabled_features.filter(f=>f!=='fast_mode');
 metadata.capability_policy.enabled_features=[...new Set([...metadata.capability_policy.enabled_features,'fast_mode'])];
 const supervisor=new BenchmarkSupervisor(root);await supervisor.verifyRunCapabilityBoundary(metadata,staging);
 const runtime=await BenchmarkGameRuntime.open(root,staging);
 const oldRooms=runtime.assets.rooms.map(room=>{
  if(!edited.includes(room.fileName))return room;
  const file='level-data/v2/main-world/'+room.fileName,bytes=execFileSync('git',['show',plan.oldLevelRef+':'+file],{cwd:root});
  assert.equal(digest(bytes),plan.files[file].before);return {...room,...decodeVoxelRoom(JSON.parse(bytes))};
 });
 const originalWorld=new ConnectedWorldSessionV1(runtime.assets.engine,runtime.assets.blocks,oldRooms);
 const original=await originalWorld.simulateCommand(prior.state,oldRooms.find(r=>r.fileName===prior.roomFile),cameraRelativeMoveDirection(target.action,yaw));
 assert.deepEqual(original.final,entry.state,'Pinned original entry must reproduce exactly');
 const repaired=new BenchmarkGameRuntime(root,staging,runtime.assets,previous);let animation;
 repaired.persist=async options=>{animation=options;};await repaired.apply(target.action);
 repaired.internal.updatedAt=target.at;repaired.internal.actions.at(-1).at=target.at;
 assert.equal(repaired.internal.actionCount,plan.to);assert.equal(repaired.internal.roomFile,entry.roomFile);assert.equal(repaired.internal.gemsCollected.length,11);
 assert.deepEqual(repaired.internal.actions.slice(0,-1),old.actions.slice(0,plan.to-1));assert.deepEqual(repaired.internal.positions,old.positions.slice(0,plan.to+1));
 assert.deepEqual(repaired.internal.state,repaired.internal.roomEntryState);assert.deepEqual(repaired.internal.state,repaired.internal.roomEntryStates[entry.roomFile]);
 assert(!repaired.internal.roomEntryStates[nxf]);
 assert.equal(originalStateHash(repaired.internal,gems),repaired.internal.stateHashes.at(-1));
 const finalRuntime=new BenchmarkGameRuntime(root,staging,runtime.assets,repaired.internal);await finalRuntime.persist(animation);verifyCheckpoint(staging);
 const reopened=await BenchmarkGameRuntime.open(root,staging);assert.deepEqual(reopened.summary(),finalRuntime.summary());
 const future=[];for(const folder of ['display-history','records/move_history'])for(const name of await readdir(directory+'/'+folder)){
  const match=/^move_(\d+)(?:\.(?:json|txt))?$/.exec(name);assert(match,`Unexpected record ${name}`);if(Number(match[1])>plan.to)future.push(folder+'/'+name);
 }
 const files=['integrity.json','game-state.json','summary.json','display.json','records/current_board.txt','records/current_state.json','records/moves.txt','records/history.jsonl',`records/move_history/move_${plan.to}.txt`,`display-history/move_${plan.to}.json`,'run.json','checkpoint.json'];
 const animationFolder=`records/move_history/move_${plan.to}`;
 const backup=directory+'/repairs/level-rollback-11879-fast-'+new Date().toISOString().replaceAll(':','-');
 const now=new Date().toISOString();
 const repair={at:now,kind:'operator-runtime-update',action_count:plan.to,previous_action_count:plan.from,reason:'User-requested rollback to action 11879, adoption of edited MxG and NxF levels, and Fast service tier.',
  resume_notice:`The operator applied authored level edits to MxG and NxF and rolled back this run from action ${plan.from} to action ${plan.to}. Your score is now 11/100 gems. The later 12th gem collection and all actions after ${plan.to} were archived and do not count. Action ${plan.to} was replayed into the updated MxG layout with your original arrival position. Current state, reset state, and room-return state use this corrected entry; normal future entry into NxF loads the edited room. Later conversation memories may describe discarded moves and older level layouts. Call maze_observe now and use the current board and current records as the authority. Continue with the same model, max reasoning, Python disabled and unlimited actions.`,
  files:plan.files,original_manifest_sha256:plan.manifestHash,repaired_manifest_sha256:integrity.manifest_sha256,original_checkpoint_authenticated:true,original_entry_reproduced:true,
  prefix_through_11878_preserved:true,restored_room_caches:['MxF'],old_edited_room_snapshots_retained:false,gems_before:12,gems_after:11,archived_actions:plan.from-plan.to,state_hash:repaired.internal.stateHashes.at(-1),conversation_retained:true,token_usage_retained:true,service_tier:'fast',backup};
 metadata.runtime_repairs=[...(metadata.runtime_repairs||[]),repair];metadata.updated_at=now;
 await writeFile(staging+'/run.json',encode(metadata),{mode:0o600});
 const capability=await supervisor.verifyRunCapabilityBoundary(metadata,staging);
 const args=buildCodexArguments({projectRoot:root,runDirectory:directory,agentDirectory:directory+'/agent-cwd',modelCatalogPath:directory+'/sandbox-state/direct-model-catalog.json',model:metadata.model,effort:metadata.effort,serviceTier:'fast',toolsEnabled:false,disabledFeatures:capability.capabilityPolicy.disabled_features,prompt:benchmarkResumePrompt(metadata,finalRuntime.summary()),resumeThreadId:metadata.codex_thread_id});
 assert(args.includes('service_tier="fast"'));assert(args.includes('features.fast_mode=true'));assert(args.includes('model_reasoning_effort="max"'));
 const protectedFiles=[...files,animationFolder,'prompt.md','agent-events.jsonl','tool-activity.jsonl','agent-stderr.log'];
 const hashes={};for(const file of protectedFiles.filter(f=>f!==animationFolder))hashes[file]=await fileHash(directory+'/'+file);
 await writeFile(staging+'/resume-prompt.txt',benchmarkResumePrompt(metadata,finalRuntime.summary()),{mode:0o600});
 const receipt={plan,staging,backup,files,animationFolder,future,protectedFiles,hashes,repair,result:{status:'paused',action_count:plan.to,room:'MxG',gems:11,service_tier:'fast',archived_actions:plan.from-plan.to}};
 await writeFile(work+'/prepared.json',encode(receipt),{mode:0o600});console.log(encode({stage:'prepared',...receipt.result,staging,backup,archived_record_entries:future.length}));
}

async function publish(){
 const receipt=await json(work+'/prepared.json');assert.deepEqual(receipt.plan,plan);await verifyOriginal();
 for(const [file,hash]of Object.entries(receipt.hashes))assert.equal(await fileHash(directory+'/'+file),hash,`Changed original: ${file}`);
 const supervisor=new BenchmarkSupervisor(root),metadata=await json(receipt.staging+'/run.json');await supervisor.verifyRunCapabilityBoundary(metadata,receipt.staging);
 await mkdir(receipt.backup,{mode:0o700});
 for(const file of [...receipt.protectedFiles,...receipt.future])await cloneTree(directory+'/'+file,receipt.backup+'/'+file);
 await cloneTree(work+'/plan.json',receipt.backup+'/plan.json');await cloneTree(receipt.staging+'/resume-prompt.txt',receipt.backup+'/resume-prompt.txt');
 for(const [file,change]of Object.entries(plan.files)){
  const ref=file.startsWith('level-data/')?plan.oldLevelRef:plan.sourceHead;
  const before=execFileSync('git',['show',ref+':'+file],{cwd:root});assert.equal(digest(before),change.before);
  await mkdir(path.dirname(receipt.backup+'/assets-before/'+file),{recursive:true,mode:0o700});await writeFile(receipt.backup+'/assets-before/'+file,before,{mode:0o600});await cloneTree(root+'/'+file,receipt.backup+'/assets-after/'+file);
 }
 await writeFile(receipt.backup+'/repair.json',encode(receipt.repair),{mode:0o600});await inactive();verifyCheckpoint(directory);
 try{
  // Keep the signature last. Any interrupted publication remains fail-closed.
  for(const file of receipt.files.filter(f=>f!=='checkpoint.json'))await atomicCopy(receipt.staging+'/'+file,directory+'/'+file);
  await rm(directory+'/'+receipt.animationFolder,{recursive:true});await cloneTree(receipt.staging+'/'+receipt.animationFolder,directory+'/'+receipt.animationFolder);
  for(const file of receipt.future)await rm(directory+'/'+file,{recursive:true});
  await atomicCopy(receipt.staging+'/checkpoint.json',directory+'/checkpoint.json');
  await supervisor.verifyRunCapabilityBoundary(metadata,directory);
  const runtime=await BenchmarkGameRuntime.open(root,directory);assert.equal(runtime.internal.actionCount,plan.to);assert.equal(runtime.internal.gemsCollected.length,11);
  assert(!runtime.internal.actions.some(a=>a.index>plan.to));
  for(const file of ['prompt.md','agent-events.jsonl','tool-activity.jsonl','agent-stderr.log'])assert.equal(await fileHash(directory+'/'+file),receipt.hashes[file]);
  await assert.rejects(()=>runtime.readRecord(`move_history/move_${plan.to+1}.txt`),/Unknown benchmark record/);
 }catch(error){
  for(const file of [...receipt.files,receipt.animationFolder,...receipt.future]){await rm(directory+'/'+file,{recursive:true,force:true});await cloneTree(receipt.backup+'/'+file,directory+'/'+file);}
  verifyCheckpoint(directory);throw error;
 }
 await writeFile(work+'/completed.json',encode({...receipt.result,backup:receipt.backup,checkpoint_verified:true}),{mode:0o600});
 await rm(receipt.staging,{recursive:true});console.log(encode({...receipt.result,backup:receipt.backup,checkpoint_verified:true}));
}
if(process.argv[2]==='--prepare')await prepare();else if(process.argv[2]==='--apply')await publish();else throw Error('Use --prepare, inspect the prepared checkpoint, then --apply.');
