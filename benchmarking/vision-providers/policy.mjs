import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyRunIntegrity, assertRunConfiguration, verifyCheckpoint } from '../v1/integrity.mjs';
import { safeReadFile } from '../v1/safe-files.mjs';
import { visionRuntimeHashes } from '../vision/policy.mjs';
import { digest, runtimeHashes, boundaryValidator, VERIFIED_VERSIONS } from '../antigravity/policy.mjs';
import { grokRuntimeHashes, grokConfigIsImmutable, grokModelsPolicyDigest, grokSettingsPolicyDigest, VERIFIED_GROK_VERSIONS } from '../grok/policy.mjs';
import * as kimi from '../kimi/policy.mjs';
import * as muse from '../muse/policy.mjs';
import { auditSession } from '../kimi/session.mjs';
export const POLICY = 'subscription-vision-coding-off-v1';
export const PROVIDERS = ['antigravity', 'grok-build', 'kimi-code', 'muse-code'];
export async function providerVisionHashes(root) {
  const files = (await readdir(path.join(root, 'benchmarking/vision-providers'), {withFileTypes:true})).filter(e=>e.isFile()&&e.name.endsWith('.mjs')).map(e=>'benchmarking/vision-providers/'+e.name).sort();
  return {...await visionRuntimeHashes(root), ...await runtimeHashes(root), ...await grokRuntimeHashes(root), ...await kimi.runtimeHashes(root), ...await muse.runtimeHashes(root),
    ...Object.fromEntries(await Promise.all(files.map(async file=>[file,digest(await readFile(path.join(root,file)))])))};
}
export async function verifyProviderVisionIntegrity(root, directory, metadata) {
  if (existsSync(path.join(directory,'integrity-violation.json'))) throw new Error('This run was invalidated by an integrity violation.');
  const manifest = await verifyRunIntegrity(root,directory,metadata.integrity), frozen=manifest.configuration;
  assertRunConfiguration(metadata,manifest);
  if (!PROVIDERS.includes(metadata.provider)||metadata.provider!==frozen.provider||metadata.observation_mode!=='vision'||frozen.observation_mode!=='vision'||metadata.world!=='main-world'||frozen.world!=='main-world'||metadata.tools_enabled!==false||frozen.tools_enabled!==false||metadata.coding_mode!=='off'||frozen.vision_provider_policy!==POLICY) throw new Error('Vision provider or coding condition changed.');
  if (JSON.stringify(metadata.capability_policy)!==JSON.stringify(frozen.capability_policy)) throw new Error('Vision capability policy changed.');
  if (JSON.stringify(await providerVisionHashes(root))!==JSON.stringify(frozen.vision_provider_runtime)) throw new Error('Vision provider runtime changed; start a new run.');
  const agy=metadata.provider==='antigravity', prefix={'antigravity':'antigravity','grok-build':'grok','kimi-code':'kimi','muse-code':'muse'}[metadata.provider];
  const versions={antigravity:VERIFIED_VERSIONS,grok:VERIFIED_GROK_VERSIONS,kimi:new Set([kimi.VERSION]),muse:new Set([muse.VERSION])};
  if (!versions[prefix].has(frozen[prefix+'_version'])) throw new Error('Unverified provider version.');
  if (digest(await readFile(frozen[prefix+'_executable']))!==frozen[prefix+'_sha256']) throw new Error('Provider executable changed.');
  for (const [file,hash] of Object.entries(frozen.immutable_config)) if (!grokConfigIsImmutable(file)||digest(await readFile(file))!==hash) throw new Error('Immutable vision configuration changed.');
  if (prefix==='grok') {
    if (grokModelsPolicyDigest(await readFile(path.join(frozen.grok_home,'models_cache.json')))!==frozen.grok_models_policy_sha256||grokSettingsPolicyDigest(await readFile(path.join(frozen.grok_home,'settings_cache.json')))!==frozen.grok_settings_policy_sha256) throw new Error('Grok signed service policy changed.');
  } else if (agy && path.resolve(frozen.image_directory)!==path.join(realpathSync(directory),'vision-images')) throw new Error('Image directory changed.');
  if(prefix==='kimi')auditSession(frozen,directory,metadata.kimi_session_id);
  if (digest(safeReadFile(directory,'prompt.md'))!==frozen.effective_prompt_sha256) throw new Error('Vision prompt changed.');
  verifyCheckpoint(directory);return manifest;
}
export function imageViewPath(input, imageDirectory) {
  const file=String(input?.AbsolutePath||''), relative=path.relative(imageDirectory,file);
  if (!/^[a-f0-9]{64}\.png$/.test(relative)||path.resolve(file)!==path.join(path.resolve(imageDirectory),relative)||realpathSync(file)!==path.join(realpathSync(imageDirectory),relative)) throw new Error('Only recorded observation PNGs may be viewed.');
  const bytes=readFileSync(file);
  if (digest(bytes)!==relative.slice(0,-4)||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('Observation PNG changed.');
  return file;
}
export function visionBoundaryValidator(options) {
  const base=boundaryValidator(options);
  return event=>{
    if (event.step_update?.tool_name!=='view_file') return base(event);
    const violation=base({...event,step_update:undefined});if(violation)return violation;
    try { imageViewPath(event.step_update.tool_info?.parameters,options.imageDirectory);return null; }
    catch(error){return error.message;}
  };
}
