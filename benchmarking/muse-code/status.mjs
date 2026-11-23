import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {authHome,authenticatedEnvironment,inspectInstallation,tokenPath,defaultBinary,EFFORTS} from './policy.mjs';
export const MUSE_PROVIDER='muse-code';

export function catalogModels(result) {
  if(result?.providerId!=='meta'||result.source!=='providerCatalog'||!Array.isArray(result.models))return [];
  return result.models.flatMap(model=>{
    if(!/^muse-[a-zA-Z0-9._-]+$/.test(model.modelId))return [];
    // Described tiers can be a partial annotation (e.g. only xhigh). The
    // variants list is the catalog's complete set of supported efforts.
    const advertised=Array.isArray(model.variants)?model.variants:[];
    const efforts=EFFORTS.filter(effort=>advertised.includes(effort));
    if(!efforts.length||!efforts.includes(model.defaultReasoningEffort))return [];
    return [{id:model.modelId,name:model.displayLabel||model.modelId,provider:MUSE_PROVIDER,
      default_effort:model.defaultReasoningEffort,efforts,description:model.description,
      context_limit:model.contextLimit,release_date:model.releaseDate}];
  });
}

// MSP model/list queries the authenticated provider catalog without a model turn.
export function modelCatalog(executable,home=authHome()) {
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['serve','--no-session-log','--disable-shell','--disable-write','--sandbox-network','restricted'],{cwd:home,env:authenticatedEnvironment(home),stdio:['pipe','pipe','pipe']});
    let buffer='',finished=false;
    const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);child.kill('SIGTERM');error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('Muse model catalog timed out.')),15000);
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.on('error',error=>finish(error));child.stdin.on('error',()=>{});child.stderr.resume();
    child.on('close',()=>{if(!finished)finish(new Error('Muse sign-in or catalog unavailable.'));});
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();
      for(const line of lines){let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.error){finish(new Error('Muse catalog request failed.'));return;}
        if(message.id===1&&message.result){send({jsonrpc:'2.0',method:'initialized',params:{}});send({jsonrpc:'2.0',id:2,method:'model/list',params:{}});}
        if(message.id===2&&message.result)finish(null,message.result);
      }
      if(buffer.length>1024*1024)finish(new Error('Invalid Muse catalog response.'));
    });
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mazebench',version:'1'}}});
  });
}
export async function museInstallationStatus(command=defaultBinary(),catalog=modelCatalog,inspect=inspectInstallation) {
  try {
    const installation=inspect(command);
    if(!existsSync(tokenPath(authHome())))return {...installation,available:true,authenticated:false,launch_ready:false,models:[],error:'Muse account is not configured for MazeBench.'};
    const result=await catalog(installation.executable),authenticated=result.providerId==='meta'&&result.source==='providerCatalog'&&result.models?.length>0;
    const models=catalogModels(result);
    const ready=Boolean(installation.tested&&authenticated&&models.length);
    return {...installation,available:true,authenticated:Boolean(authenticated),launch_ready:ready,models,auth_method:authenticated?'Existing Meta login':null,error:ready?null:'Muse needs a verified installation and a working Meta login.'};
  }catch(error){return {available:false,tested:false,authenticated:false,launch_ready:false,models:[],error:error.message};}
}
