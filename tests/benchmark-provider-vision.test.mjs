import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';import path from 'node:path';
import {ProviderVisionSupervisor} from '../benchmarking/vision-providers/supervisor.mjs';
import {imageViewPath} from '../benchmarking/vision-providers/policy.mjs';
const root=path.resolve(import.meta.dirname,'..');
test('vision renderer resolves an ESM Chromium export with an isolated HOME',()=>{
  const renderer=new URL('../benchmarking/vision-providers/renderer.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {playwrightModule} from ${JSON.stringify(renderer)}; const {chromium}=await import(playwrightModule); if(typeof chromium?.launch!=='function')throw new Error('Missing Chromium export');`],{env:{HOME:'/nonexistent-mazebench-home',PATH:'/usr/bin:/bin'},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});
test('subscription vision preserves the requested model, effort and no-code condition',async()=>{
  const supervisor=new ProviderVisionSupervisor(root);
  supervisor.inspectKimi=async()=>({models:[{id:'k3.1-pro',context_limit:1048576,efforts:['low','high','max'],default_effort:'high'}]});
  supervisor.inspectMuse=async()=>({models:[{id:'muse-wonder-full-1.0',efforts:['high','xhigh','max'],default_effort:'high'}]});
  const choices=[['antigravity','gemini-4-argon-high','high'],['grok-build','grok-4.7','xhigh'],['kimi-code','k3.1-pro','max'],['muse-code','muse-wonder-full-1.0','max']];
  for(const [provider,model,effort]of choices){
    const spec={provider,model,effort,world:'main-world',observation_mode:'vision',coding_mode:'off',tools_enabled:false,action_limit:null};
    const selected=await supervisor.validateSpec(spec);
    assert.equal(selected.model,model);assert.equal(selected.effort,effort);assert.equal(selected.toolsEnabled,false);assert.equal(selected.observationMode,'vision');assert.equal(selected.actionLimit,null);
    for(const change of [{tools_enabled:true},{coding_mode:'python'},{coding_mode:'any'},{observation_mode:'ascii'},{world:'slotski'},{effort:'invalid'}])await assert.rejects(supervisor.validateSpec({...spec,...change}));
  }
});
test('Gemini image viewer accepts only authenticated PNGs in the observation directory',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'maze-vision-path-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const images=path.join(tmp,'images');await mkdir(images);
  const png=Buffer.from('89504e470d0a1a0a00000000','hex'),sha=createHash('sha256').update(png).digest('hex'),file=path.join(images,sha+'.png');await writeFile(file,png);
  assert.equal(imageViewPath({AbsolutePath:file},images),file);
  for(const target of [path.join(tmp,'secret'),path.join(images,'config.json'),path.join(images,'..',sha+'.png')])assert.throws(()=>imageViewPath({AbsolutePath:target},images));
  await writeFile(file,'changed');assert.throws(()=>imageViewPath({AbsolutePath:file},images),/changed/);
  await rm(file);await writeFile(path.join(tmp,sha+'.png'),png);await symlink(path.join(tmp,sha+'.png'),file);assert.throws(()=>imageViewPath({AbsolutePath:file},images));
});
