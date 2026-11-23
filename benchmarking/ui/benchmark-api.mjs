const nativeFetch=window.fetch.bind(window);
const autoResumeOrigin=`http://${location.hostname}:8092`;
let autoResumeAt=0,autoResumeReady=false,autoResumePending;
async function autoResumeAvailable(){
  if(Date.now()-autoResumeAt<15000)return autoResumeReady;
  autoResumePending ||= (async()=>{
    try{const response=await nativeFetch(autoResumeOrigin+'/api/benchmark/auto-resume/status',{signal:AbortSignal.timeout(700)});autoResumeReady=response.ok&&(await response.json()).provider_scope==='all';}
    catch{autoResumeReady=false;}
    autoResumeAt=Date.now();autoResumePending=null;return autoResumeReady;
  })();
  return autoResumePending;
}
const releaseOrigin=`http://${location.hostname}:8090`;
let releaseAt=0,releaseReady=false,releasePending;
async function releaseAvailable(){
  if(Date.now()-releaseAt<15000)return releaseReady;
  releasePending ||= (async()=>{
    try{const response=await nativeFetch(releaseOrigin+'/api/benchmark/release/status',{signal:AbortSignal.timeout(700)});releaseReady=response.ok&&(await response.json()).ascii_renderer===2;}
    catch{releaseReady=false;}
    releaseAt=Date.now();releasePending=null;return releaseReady;
  })();
  return releasePending;
}
const currentCodexOrigin=`http://${location.hostname}:8088`;
let currentCodexAt=0,currentCodexReady=false,currentCodexPending;
async function currentCodexAvailable(){
  if(Date.now()-currentCodexAt<15000)return currentCodexReady;
  currentCodexPending ||= (async()=>{
    try{const response=await nativeFetch(currentCodexOrigin+'/api/benchmark/capabilities/status',{signal:AbortSignal.timeout(700)});const status=response.ok?await response.json():{};currentCodexReady=status.version===2&&status.current_codex_owner===true;}
    catch{currentCodexReady=false;}
    currentCodexAt=Date.now();currentCodexPending=null;return currentCodexReady;
  })();
  return currentCodexPending;
}
const recoveryOrigin=`http://${location.hostname}:8087`;
let recoveryAt=0,recoveryReady=false,recoveryPending;
async function recoveryAvailable(){
  if(Date.now()-recoveryAt<15000)return recoveryReady;
  recoveryPending ||= (async()=>{
    try{const response=await nativeFetch(recoveryOrigin+'/api/benchmark/recovery/status',{signal:AbortSignal.timeout(700)});recoveryReady=response.ok&&(await response.json()).version===1;}
    catch{recoveryReady=false;}
    recoveryAt=Date.now();recoveryPending=null;return recoveryReady;
  })();
  return recoveryPending;
}
const origin=`http://${location.hostname}:8082`;
const providerVisionOrigin=`http://${location.hostname}:8086`;
let providerVisionAt=0,providerVision=false,providerVisionPending;
export async function providerVisionAvailable(){
  if(Date.now()-providerVisionAt<15000)return providerVision;
  providerVisionPending ||= (async()=>{
    try{const r=await nativeFetch(providerVisionOrigin+'/api/benchmark/vision-providers/status',{signal:AbortSignal.timeout(700)});providerVision=r.ok&&(await r.json()).observation_mode==='vision';}
    catch{providerVision=false;}
    providerVisionAt=Date.now();providerVisionPending=null;return providerVision;
  })();
  return providerVisionPending;
}
let checkedAt=0,available=false,pending;
export async function visionAvailable(){
  if(Date.now()-checkedAt<15000)return available;
  if(!pending)pending=(async()=>{try{const r=await nativeFetch(origin+'/api/benchmark/vision/status',{signal:AbortSignal.timeout(1200)});available=r.ok&&(await r.json()).observation_mode==='vision';}catch{available=false;}checkedAt=Date.now();pending=null;return available;})();
  return pending;
}
const capabilityOrigin=`http://${location.hostname}:8083`;
let capabilitiesAt=0,capabilities=false,capabilitiesPending,activeCapabilityOrigin=capabilityOrigin;
export async function capabilitiesAvailable(){
  if(Date.now()-capabilitiesAt<15000)return capabilities;
  capabilitiesPending ||= (async()=>{
    // v3 added recovery metadata without changing the v2 routes. Accept both
    // during rolling updates so live runs never fall back to another owner.
    capabilities=false;
    for(const candidate of [`http://${location.hostname}:8084`,capabilityOrigin]){
      try{const r=await nativeFetch(candidate+'/api/benchmark/capabilities/status',{signal:AbortSignal.timeout(1200)});if(r.ok&&[2,3].includes((await r.json()).version)){capabilities=true;activeCapabilityOrigin=candidate;break;}}catch{/* Try the existing owner during an upgrade. */}
    }
    capabilitiesAt=Date.now();capabilitiesPending=null;return capabilities;
  })();
  return capabilitiesPending;
}
export async function benchmarkFetch(url,options={}){
  const replayChunk = /^\/api\/benchmark\/playback\/runs\/[^/]+\/chunk(?:\?.*)?$/.test(url);
  const reportPath = /^\/api\/benchmark\/v1\/(runs\/[^/]+\/(?:tokens|comparison|charts)|pricing(?:\?.*)?)$/.test(url);
  if ((!options.method || options.method.toUpperCase() === 'GET') && (reportPath || replayChunk)) {
    // The two read-only services can answer both routes without the run owner.
    let failedResponse;
    for (const port of replayChunk ? [8085, 8091] : [8091, 8085]) {
      try {
        const timeout = replayChunk && port === 8085 ? 10000 : 60000;
        const report = await nativeFetch(`http://${location.hostname}:${port}${url}`, { ...options, signal: options.signal || AbortSignal.timeout(timeout) });
        if (report.ok) return report;
        failedResponse ??= report;
      } catch { /* Older installations retain the existing report route. */ }
    }
    if (replayChunk) {
      if (failedResponse) return failedResponse;
      throw new Error('Replay service is temporarily unavailable.');
    }
  }
  if(await autoResumeAvailable())return nativeFetch(autoResumeOrigin+url,options);
  if(await releaseAvailable())return nativeFetch(releaseOrigin+url,options);
  if(options.method?.toUpperCase()==='POST'&&/\/api\/benchmark\/v1\/runs$/.test(url))throw new Error('Versioned benchmark runner is unavailable. Start npm run start:releases; no run was launched.');
  if(await currentCodexAvailable())return nativeFetch(currentCodexOrigin+url,options);
  if(await recoveryAvailable())return nativeFetch(recoveryOrigin+url,options);
  if(await providerVisionAvailable())return nativeFetch(providerVisionOrigin+url,options);
  // Image launches must never fall through a generic companion to ASCII.
  // Check the image owner first even when catalog/capability servers are online.
  let visionLaunch=false;
  if(options.method?.toUpperCase()==='POST'&&/\/api\/benchmark\/v1\/(runs|pairs)$/.test(url)&&options.body){
    try{visionLaunch=JSON.parse(options.body).observation_mode==='vision';}catch{}
  }
  if(visionLaunch){
    if(!await visionAvailable())throw new Error('Vision runner is unavailable. Start npm run start:vision; no run was launched.');
    return nativeFetch(origin+url,options);
  }
  if(await capabilitiesAvailable())return nativeFetch(activeCapabilityOrigin+url,options);
  const vision=await visionAvailable();
  if(!vision&&options.body){try{if(JSON.parse(options.body).observation_mode==='vision')throw new Error('Vision runner is unavailable. Start node benchmarking/vision/server.mjs.');}catch(error){if(!(error instanceof SyntaxError))throw error;}}
  return nativeFetch(vision?origin+url:url,options);
}
export const visionUrl=path=>origin+path;
