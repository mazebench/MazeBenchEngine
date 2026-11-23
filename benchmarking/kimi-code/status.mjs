import {credential,authHome,inspectInstallation,defaultBinary,EFFORTS,MODEL_IDS} from './policy.mjs';
export const KIMI_PROVIDER='kimi-code';
export const advertisedModels=()=>MODEL_IDS.map(id=>({id,name:id==='k3.1-pro'?'Kimi K3.1 Pro':'Kimi K3.1 Pro Highspeed',provider:KIMI_PROVIDER,efforts:EFFORTS,default_effort:'max'}));
export function catalogModels(result) {
  if(!Array.isArray(result?.data))return [];
  return MODEL_IDS.flatMap(id=>{
    const model=result.data.find(m=>m.id===id);
    const reasoning=model?.reasoning?.effort;
    const valid=reasoning?.valid||model?.think_efforts?.valid_efforts||[];
    const effort=reasoning?.default||model?.think_efforts?.default_effort;
    const context=model?.limit?.context||model?.context_length;
    const efforts=EFFORTS.filter(e=>valid.includes(e));
    if(!efforts.includes(effort)||!Number.isSafeInteger(context)||context<1)return [];
    return [{id,name:'Kimi '+(model.display_name||id),provider:KIMI_PROVIDER,efforts,default_effort:effort,context_limit:context}];
  });
}
export async function modelCatalog(home=authHome()) {
  const auth=credential(home);
  const response=await fetch(auth.base_url+'/models',{headers:{Authorization:'Bearer '+auth.api_key,'User-Agent':'MazeBench/1.0'},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new Error(`Kimi Code model catalog returned HTTP ${response.status}. Check your subscription key with npm run setup:kimi.`);
  return response.json();
}
export async function kimiInstallationStatus(command=defaultBinary(),home=authHome(),catalog=modelCatalog,inspect=inspectInstallation) {
  let installation={available:false,tested:false};
  try {
    installation={...inspect(command),available:true};
    const models=catalogModels(await catalog(home));
    const ready=Boolean(installation.tested&&models.length);
    return {...installation,authenticated:Boolean(models.length),launch_ready:ready,models,coding_modes:['off','python'],
      auth_method:'Kimi Code subscription key',error:ready?null:'Kimi needs a verified CLI and K3.1 Pro in the model catalog.'};
  }catch(error){return {...installation,authenticated:false,launch_ready:false,models:advertisedModels(),coding_modes:['off','python'],error:error.code==='ENOENT'?'Run npm run setup:kimi to install Kimi Code and configure its subscription key.':error.message};}
}
