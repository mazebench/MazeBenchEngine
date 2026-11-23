function abortable(promise,signal){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

// Export in an isolated document: watching, scrubbing and live following retain
// their own renderer and clock. Removing the document releases its GPU resources.
export async function exportRunReplay(player,{mode,format,signal,onProgress}){
  const target=Math.max(player.totalActions||0,player.run?.action_count||0),speed=player.speed;
  onProgress({message:'Loading run for export…'});
  while(!player.movie||player.actionCount<target){
    const before=player.actionCount;await abortable(player.refresh({background:Boolean(player.movie)}),signal);
    if(player.actionCount===before&&player.complete)throw new Error('Some run moves are not available yet. Try again shortly.');
  }
  signal.throwIfAborted();
  const clips=player.movie.clips.slice(0,target+1),last=clips.at(-1);
  if(!last)throw new Error('No replay moves are available yet.');
  const movie={...player.movie,clips,duration:last.start+last.duration};
  const renderer=player.view?.renderer,center=player.view?.lastCamera;
  const camera=renderer?{yaw:renderer.yaw,heading:renderer.heading,pitch:renderer.pitch,distance:renderer.distance,
    y:renderer.target.y,pan:[renderer.target.x-(center?.[0]||0),renderer.target.z-(center?.[1]||0)]}:null;
  const iframe=document.createElement('iframe');iframe.title='Replay export';iframe.setAttribute('aria-hidden','true');iframe.tabIndex=-1;
  iframe.style.cssText='position:fixed;left:-10000px;top:0;width:960px;height:640px;border:0;pointer-events:none';
  const result=new Promise((resolve,reject)=>{
    const cleanup=()=>{window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);iframe.remove();};
    const abort=()=>{cleanup();reject(signal.reason);};
    const receive=event=>{
      if(event.source!==iframe.contentWindow||event.origin!==location.origin)return;
      const data=event.data;
      if(data.type==='ready')iframe.contentWindow.postMessage({type:'export',world:player.world,movie,mode,format,speed,
        agentCamera:player.agentCamera.checked,neighbors:player.neighbors.checked,camera},location.origin);
      else if(data.type==='progress')onProgress(data);
      else if(data.type==='done'){cleanup();resolve({blob:data.blob,extension:data.extension,speed});}
      else if(data.type==='error'){cleanup();reject(new Error(data.message));}
    };
    window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
    iframe.onerror=()=>{cleanup();reject(new Error('The export renderer could not load.'));};
    iframe.src=new URL('./replay-export.html',import.meta.url);document.body.append(iframe);
  });
  return result;
}
