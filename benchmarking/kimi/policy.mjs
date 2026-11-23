import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {verifyRunIntegrity,assertRunConfiguration,verifyCheckpoint} from '../v1/integrity.mjs';
import {safeReadFile} from '../v1/safe-files.mjs';
import {auditSession} from './session.mjs';
export {immutable} from '../antigravity/policy.mjs';

export const POLICY='kimi-mcp-only-v1';
export const VERSION='2.3.1';
// Official release manifest: https://code.kimi.com/kimi-code/binaries/2.3.1/manifest.json
export const BINARY_SHA256='f06ba6a3bb7ed2fc1f82590f7c22570736d9ee7344059fa92404ca75dc2d5b45';
export const EFFORTS=['low','high','max'];
export const MODEL_IDS=['k3.1-pro','k3.1-pro-highspeed'];
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const toolNames=enabled=>['maze_observe','maze_action','maze_sequence',...(enabled?['python_exec']:[])];
export const defaultBinary=()=>process.env.MAZEBENCH_KIMI_BIN||path.join(os.homedir(),'.mazebench/kimi/bin',`kimi-${VERSION}`);
export const authHome=()=>path.join(os.homedir(),'.mazebench/kimi/auth');
export const tokenPath=home=>path.join(home,'credential.json');
export function credential(home=authHome()) {
  let value;
  try {value=JSON.parse(readFileSync(tokenPath(home),'utf8'));}
  catch {throw new Error('Configure a Kimi Code subscription key with npm run setup:kimi.');}
  if(!['https://api.kimi.com/coding/v1','https://api.kimi.ai/coding/v1'].includes(value.base_url)||typeof value.api_key!=='string'||!value.api_key.trim())throw new Error('Configure a Kimi Code subscription key with npm run setup:kimi.');
  return value;
}
export function environment(home) {
  return {HOME:path.resolve(home),KIMI_CODE_HOME:path.resolve(home),
    XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),
    PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:os.tmpdir(),LANG:'en_US.UTF-8',
    KIMI_DISABLE_TELEMETRY:'1',KIMI_CODE_NO_AUTO_UPDATE:'1',KIMI_DISABLE_CRON:'1',
    KIMI_CODE_INFINITE_RETRY:'0',NO_COLOR:'1',CI:'1'};
}
export function authenticatedEnvironment(home,credentialHome=authHome()) {
  return {...environment(home),MAZEBENCH_KIMI_API_KEY:credential(credentialHome).api_key};
}
const hashes=new Map();
export function executableHash(file) {
  const stat=statSync(file),key=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  if(hashes.get(file)?.key!==key)hashes.set(file,{key,hash:digest(readFileSync(file))});
  return hashes.get(file).hash;
}
export function inspectInstallation(command=defaultBinary()) {
  const executable=realpathSync(command);
  const tested=process.platform==='darwin'&&process.arch==='arm64'&&executableHash(executable)===BINARY_SHA256;
  return {executable,version:tested?VERSION:'unverified',tested};
}
export function settings({model,effort,contextLimit,toolsEnabled,baseUrl='https://api.kimi.com/coding/v1'}) {
  if(!MODEL_IDS.includes(model)||!EFFORTS.includes(effort)||!Number.isSafeInteger(contextLimit)||contextLimit<1)throw new Error('Invalid Kimi model configuration.');
  return `default_model = "benchmark"
telemetry = false
auto_session_title = false
merge_all_available_skills = false
builtin_product_skills = false
[providers.benchmark]
type = "kimi"
base_url = ${JSON.stringify(baseUrl)}
api_key_env = "MAZEBENCH_KIMI_API_KEY"
[models.benchmark]
provider = "benchmark"
model = ${JSON.stringify(model)}
max_context_size = ${contextLimit}
capabilities = ["thinking", "always_thinking", "tool_use"]
support_efforts = ["low", "high", "max"]
default_effort = ${JSON.stringify(effort)}
[thinking]
enabled = true
effort = ${JSON.stringify(effort)}
keep = "all"
[tools]
enabled = ${JSON.stringify(toolNames(toolsEnabled).map(n=>'mcp__mazebench__'+n))}
[loop_control]
max_attempts_per_step = 3
`;
}
export function configFiles({root,directory,...options}) {
  return {'config.toml':settings(options),'mcp.json':JSON.stringify({mcpServers:{mazebench:{
    command:process.execPath,args:[path.join(root,'benchmarking/kimi/mcp.mjs')],
    env:{MAZEBENCH_PROJECT_ROOT:root,MAZEBENCH_RUN_DIRECTORY:directory},
    enabledTools:toolNames(options.toolsEnabled),deferred:false,toolTimeoutMs:120000
  }}})};
}
export function argumentsFor({prompt,home,sessionId}) {
  if(sessionId&&!/^session_[a-f0-9-]{36}$/.test(sessionId))throw new Error('Invalid Kimi session.');
  return ['--model','benchmark','--skills-dir',path.join(home,'skills'),'--output-format','stream-json',
    ...(sessionId?['--session',sessionId]:[]),'--prompt',prompt];
}
export async function runtimeHashes(root) {
  const entries=await readdir(path.join(root,'benchmarking/kimi'),{withFileTypes:true});
  if(entries.some(e=>e.isSymbolicLink()||e.isDirectory()))throw new Error('Unexpected Kimi provider asset.');
  return Object.fromEntries(await Promise.all(entries.filter(e=>e.name.endsWith('.mjs')).map(e=>'benchmarking/kimi/'+e.name).sort().map(async f=>[f,digest(await readFile(path.join(root,f)))])));
}
export async function verifyIntegrity(root,directory,metadata) {
  if(existsSync(path.join(directory,'integrity-violation.json')))throw new Error('Kimi run was invalidated.');
  const manifest=await verifyRunIntegrity(root,directory,metadata.integrity);assertRunConfiguration(metadata,manifest);
  const frozen=manifest.configuration;
  if(metadata.provider!=='kimi-code'||frozen.provider!=='kimi-code'||frozen.kimi_policy!==POLICY||frozen.kimi_version!==VERSION)throw new Error('Kimi provider policy changed.');
  if(frozen.world!=='main-world'||frozen.observation_mode!=='ascii'||metadata.world!==frozen.world||metadata.observation_mode!==frozen.observation_mode)throw new Error('Unsupported Kimi mode.');
  if(!MODEL_IDS.includes(frozen.model)||!EFFORTS.includes(frozen.effort))throw new Error('Unsupported Kimi model or effort.');
  if(frozen.kimi_sha256!==BINARY_SHA256||executableHash(frozen.kimi_executable)!==BINARY_SHA256)throw new Error('Kimi executable changed; start a new run.');
  if(JSON.stringify(await runtimeHashes(root))!==JSON.stringify(frozen.kimi_runtime))throw new Error('Kimi provider runtime changed; start a new run.');
  const expected=configFiles({root,directory,model:metadata.model,effort:metadata.effort,toolsEnabled:metadata.tools_enabled,contextLimit:frozen.kimi_context_limit,baseUrl:frozen.kimi_base_url});
  if(JSON.stringify(Object.keys(frozen.kimi_config).sort())!==JSON.stringify(Object.keys(expected).sort()))throw new Error('Kimi configuration inventory changed.');
  for(const [name,content] of Object.entries(expected)) {
    const file=path.join(frozen.kimi_home,name);
    if(frozen.kimi_config[name]!==digest(content)||digest(readFileSync(file))!==digest(content))throw new Error('Kimi configuration changed.');
    const flags=spawnSync('/usr/bin/stat',['-f','%Sf',file],{encoding:'utf8',timeout:5000});
    if(!flags.stdout?.trim().split(',').includes('uchg'))throw new Error('Kimi configuration is not protected.');
  }
  if(digest(safeReadFile(directory,'prompt.md'))!==frozen.effective_prompt_sha256)throw new Error('Benchmark prompt changed.');
  auditSession(frozen,directory,metadata.kimi_session_id);
  verifyCheckpoint(directory);return frozen;
}
export function boundaryValidator({sessionId,toolsEnabled}) {
  let initialized=false;
  const allowed=new Set(toolNames(toolsEnabled).map(n=>'mcp__mazebench__'+n));
  return event=>{
    if(event.role==='meta'&&event.type==='system.version') {
      if(event.version!==VERSION)return 'Kimi reported a different CLI version.';
      initialized=true;
    }
    if(event.role==='meta'&&event.type==='session.resume_hint') {
      if(!/^session_[a-f0-9-]{36}$/.test(event.session_id)||sessionId&&event.session_id!==sessionId)return 'Kimi returned a different session.';
    }
    if(event.role==='assistant') {
      if(!initialized)return 'Kimi replied before confirming its CLI version.';
      for(const call of event.tool_calls||[])if(!allowed.has(call.function?.name))return 'Kimi requested a forbidden tool: '+call.function?.name;
    }
    return null;
  };
}
