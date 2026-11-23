import { verifyCodeCondition } from "../all-code/policy.mjs";
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyRunIntegrity,assertRunConfiguration,verifyCheckpoint} from '../v1/integrity.mjs';
import {safeReadFile} from '../v1/safe-files.mjs';
export {immutable} from '../antigravity/policy.mjs';

export const POLICY='muse-any-language-v2';
export const VERSION='1.4.7-R6101.1';
export const EFFORTS=['minimal','low','medium','high','xhigh','max'];
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const toolNames=enabled=>['maze_observe','maze_action','maze_sequence',...(enabled?['code_exec']:[])];
export const defaultBinary=()=>process.env.MAZEBENCH_MUSE_BIN||path.join(os.homedir(),'.mazebench/muse/bin',`muse-${VERSION}`);
export const authHome=()=>path.join(os.homedir(),'.mazebench/muse/auth');
// Keep the imported credential outside Muse's legacy auth location: newer CLI
// versions migrate that location into macOS Keychain, triggering GUI prompts.
export const tokenPath=home=>path.join(home,'credential.json');
export function authenticatedEnvironment(home,credentialHome=home) {
  const key=JSON.parse(readFileSync(tokenPath(credentialHome),'utf8')).providers?.meta?.api_key;
  if(typeof key!=='string'||!key.trim())throw new Error('The imported Muse subscription credential is missing.');
  return {...environment(home),META_API_KEY:key};
}
const hashes=new Map();
export function executableHash(file) {
  const stat=statSync(file),key=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  if(hashes.get(file)?.key!==key)hashes.set(file,{key,hash:digest(readFileSync(file))});
  return hashes.get(file).hash;
}
export function environment(home) {
  return {HOME:path.resolve(home),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),
    PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',
    MUSE_LOGIN:'0',MUSE_NO_AUTO_UPDATE:'1',NO_COLOR:'1',CI:'1'};
}
export function inspectInstallation(command=defaultBinary()) {
  const executable=realpathSync(command);
  const expected={arm64:'87ff5a31b63e30b6ac04d3e8298285517e753c126fb6f3aee80accf28c4562f1',x64:'6d766da6601a0aae8bd22294c0854970286e1b9ade3009f0d0289b7875a10c58'}[process.arch];
  const tested=process.platform==='darwin'&&executableHash(executable)===expected;
  return {executable,version:tested?VERSION:'unverified',tested};
}
export function settings({command,args,env={},toolsEnabled}) {
  return {schema_version:1,
    run:{toolset:toolNames(toolsEnabled).map(name=>'mcp__mazebench__'+name)},
    mcp_servers:{mazebench:{transport:'stdio',command,args,env,mode:'required'}},
    context:{foreign_personal_rules:false,foreign_personal_skills:false},
    local_session_messaging:{enabled:false}};
}
export function argumentsFor({model,effort,prompt,cwd,sessionId}) {
  if(!/^muse-[a-zA-Z0-9._-]+$/.test(model)||!EFFORTS.includes(effort))throw new Error('Invalid Muse model or effort.');
  if(sessionId&&!/^[a-f0-9-]{36}$/.test(sessionId))throw new Error('Invalid Muse session.');
  return ['exec','--json','--provider','meta','--model',model,'--reasoning-effort',effort,
    '--workspace',cwd,'--approval-mode','never','--approval-judge','off','--disable-web-tools',
    '--no-foreign-personal-context','--disable-write','--disable-shell','--sandbox-network','restricted',
    '--no-parallel-tool-calls',...(sessionId?['--session-id',sessionId]:[]),prompt];
}
export async function runtimeHashes(root) {
  const entries=await readdir(path.join(root,'benchmarking/muse-code'),{withFileTypes:true});
  if(entries.some(e=>e.isSymbolicLink()||e.isDirectory()))throw new Error('Unexpected Muse provider asset.');
  return Object.fromEntries(await Promise.all(entries.filter(e=>e.name.endsWith('.mjs')).map(e=>'benchmarking/muse-code/'+e.name).sort().map(async f=>[f,digest(await readFile(path.join(root,f)))])));
}
export async function verifyIntegrity(root,directory,metadata) {
  if(existsSync(path.join(directory,'integrity-violation.json')))throw new Error('Muse run was invalidated.');
  const manifest=await verifyRunIntegrity(root,directory,metadata.integrity);assertRunConfiguration(metadata,manifest);
  const frozen=manifest.configuration;
  await verifyCodeCondition(root, metadata, frozen);
  if(metadata.provider!=='muse-code'||frozen.provider!=='muse-code'||frozen.muse_policy!==POLICY||frozen.muse_version!==VERSION)throw new Error('Muse provider policy changed.');
  if(frozen.world!=='main-world'||frozen.observation_mode!=='ascii')throw new Error('Unsupported Muse mode.');
  if(executableHash(frozen.muse_executable)!==frozen.muse_sha256)throw new Error('Muse executable changed; start a new run.');
  if(JSON.stringify(await runtimeHashes(root))!==JSON.stringify(frozen.muse_runtime))throw new Error('Muse provider runtime changed; start a new run.');
  const file=path.join(frozen.muse_home,'.config/muse/settings.json');
  if(Object.keys(frozen.muse_config).length!==1||frozen.muse_config[file]!==digest(readFileSync(file)))throw new Error('Muse configuration changed.');
  const flags=spawnSync('/usr/bin/stat',['-f','%Sf',file],{encoding:'utf8',timeout:5000});
  if(!flags.stdout?.trim().split(',').includes('uchg'))throw new Error('Muse configuration is not protected.');
  const expected=settings({command:process.execPath,args:[path.join(root,'benchmarking/muse-code/mcp.mjs')],env:{MAZEBENCH_PROJECT_ROOT:root,MAZEBENCH_RUN_DIRECTORY:directory},toolsEnabled:metadata.tools_enabled});
  if(JSON.stringify(JSON.parse(readFileSync(file,'utf8')))!==JSON.stringify(expected))throw new Error('Muse tool configuration changed.');
  if(digest(safeReadFile(directory,'prompt.md'))!==frozen.effective_prompt_sha256)throw new Error('Benchmark prompt changed.');
  verifyCheckpoint(directory);return frozen;
}
export function boundaryValidator({model,sessionId,toolsEnabled}) {
  let initialized=false,expectedSession=sessionId;
  const allowed=new Set(toolNames(toolsEnabled).map(n=>'mcp__mazebench__'+n));
  return event=>{
    const detail=event.payload?.event||event.payload||{},kind=detail.kind||event.payload_type;
    if(event.stream?.kind==='session') {
      expectedSession ||= event.stream.id;
      if(event.stream.id!==expectedSession)return 'Muse resumed a different session.';
    }
    if(['run_model_configured','model_selection_initialized','model_request_configured'].includes(kind)) {
      if(detail.model_id!==model||detail.provider_id!=='meta')return 'Muse selected a different model or provider.';
      initialized=true;
    }
    if(kind==='assistant_tool_calls_committed') {
      if(!initialized)return 'Muse called a tool before validating the model.';
      for(const call of detail.tool_calls||[])if(!allowed.has(call.name))return 'Muse requested a forbidden tool: '+call.name;
    }
    if(kind==='side_effect_intent'&&detail.operation?.startsWith('tool:')) {
      if(!initialized)return 'Muse called a tool before validating the model.';
      const name=detail.operation.slice(5);
      if(!allowed.has(name))return 'Muse requested a forbidden tool: '+name;
    }
    if(kind==='run_terminal'&&detail.terminal==='completed'&&!initialized)return 'Muse did not confirm its exact model.';
    return null;
  };
}
