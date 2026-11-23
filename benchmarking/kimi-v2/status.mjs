import { inspectInstallation, defaultBinary } from './policy.mjs';
import { ModelCatalog } from '../model-catalog/service.mjs';
export const KIMI_PROVIDER='kimi-code';
const catalog = new ModelCatalog();
export async function kimiInstallationStatus(command=defaultBinary()) {
  let installation={available:false,tested:false};
  try { installation={...inspectInstallation(command),available:true}; const status=await catalog.provider(KIMI_PROVIDER);
    return {...installation,authenticated:!status.stale,launch_ready:installation.tested&&!status.stale,models:status.models,error:status.error};
  } catch(error) {return {...installation,authenticated:false,launch_ready:false,models:[],error:error.message};}
}
