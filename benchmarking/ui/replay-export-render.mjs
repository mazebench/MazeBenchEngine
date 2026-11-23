import {locateReplay} from '../../replays/v1/movie.mjs';
import {replayAscii,asciiFrameAt} from './replay-ascii.mjs';
import {sampleAgentCamera,applyAgentCamera} from './replay-camera.mjs';
const send=data=>parent.postMessage(data,location.origin);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let started=false;

async function rendererFor(options,width,height){
  const {world,movie,mode}=options,canvas=document.getElementById('scene');
  canvas.width=width;canvas.height=height;canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
  world.blockDefinitions=new Map(world.blocks.map(block=>[block.id,block]));
  if(mode==='ascii'){
    await document.fonts.load('700 12px "MazeBench ASCII"');await document.fonts.load('700 12px "MazeBench ASCII Coptic"','Ϣϣ');
    const ctx=canvas.getContext('2d',{willReadFrequently:true}),cells=4*Math.max(world.roomWidth,world.roomHeight);
    const size=Math.min((width-32)/(cells*.61),(height-32)/(cells*.86)),line=size*.86;
    ctx.font=`700 ${size}px "MazeBench ASCII", "MazeBench ASCII Coptic", monospace`;ctx.textBaseline='top';
    const advance=ctx.measureText('M').width;let key;
    return {canvas,async draw(time){
      const {clip,local}=locateReplay(movie,time),frame=asciiFrameAt(clip,local),next=`${clip.move}:${frame.at}`;if(next===key)return;key=next;
      const rendered=await replayAscii(movie,world,clip,local);
      ctx.fillStyle='#08090b';ctx.fillRect(0,0,width,height);
      const left=(width-rendered.width*advance)/2,top=(height-rendered.height*line)/2;
      for(let y=0;y<rendered.pixels.length;y++)for(let x=0;x<rendered.pixels[y].length;x++){
        const pixel=rendered.pixels[y][x];if(pixel.glyph===' ')continue;ctx.fillStyle=pixel.color;ctx.fillText(pixel.glyph,left+x*advance,top+y*line);
      }
    }};
  }
  const [{ReplayView},{prepareBrowserModels},{ReplayRoomVisibility}]=await Promise.all([
    import('../../replays/v1/view.mjs'),import('../../ui/browser-world.mjs'),import('./replay-room-visibility.mjs')]);
  await prepareBrowserModels(new Set(world.blocks.map(block=>block.visual?.modelUrl).filter(Boolean)));
  const view=new ReplayView(canvas,world,movie),renderer=view.renderer,mask=new ReplayRoomVisibility(renderer);
  renderer.disposeFlyoverControls?.();renderer.disposeFlyoverControls=null;renderer.renderer.setPixelRatio(1);renderer.resize();
  if(options.neighbors)await renderer.backgroundReady;
  if(!options.agentCamera&&options.camera){
    const camera=options.camera;for(const field of ['yaw','heading','pitch','distance'])renderer[field]=camera[field];
    renderer.target.y=camera.y;renderer.target.x=view.lastCamera[0]+camera.pan[0];renderer.target.z=view.lastCamera[1]+camera.pan[1];
  }
  return {canvas,async draw(time){
    const location=locateReplay(movie,time);renderer.renderSuspended++;
    try{if(options.agentCamera){applyAgentCamera(renderer,sampleAgentCamera(location.clip,location.local));if(view.lastCamera){renderer.target.x=view.lastCamera[0];renderer.target.z=view.lastCamera[1];}}
      view.show(time);mask.update(options.neighbors,view.scene,location);
    }finally{renderer.renderSuspended--;}renderer.render();
  }};
}

async function gifExport(source,options,width,height){
  const worker=new Worker(new URL('./replay-gif-worker.mjs',import.meta.url),{type:'module'});
  const call=(data,transfer=[])=>new Promise((resolve,reject)=>{
    worker.onmessage=event=>event.data.type==='error'?reject(new Error(event.data.message)):resolve(event.data);
    worker.onerror=event=>reject(new Error(event.message));worker.postMessage(data,transfer);
  });
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true}),duration=options.movie.duration/options.speed;
  const frames=Math.max(2,Math.min(6000,Math.ceil(duration/1000*12))),interval=duration/frames;
  try{
    await call({type:'start'});
    for(let index=0;index<frames;index++){
      await source.draw(index===frames-1?options.movie.duration:index*interval*options.speed);
      ctx.drawImage(source.canvas,0,0,width,height);const pixels=ctx.getImageData(0,0,width,height).data;
      await call({type:'frame',pixels:pixels.buffer,width,height,delay:index===frames-1?Math.max(500,interval):interval},[pixels.buffer]);
      send({type:'progress',percent:100*(index+1)/frames,message:`Creating GIF · ${Math.floor(100*(index+1)/frames)}%`});
    }
    const {bytes}=await call({type:'finish'});return {blob:new Blob([bytes],{type:'image/gif'}),extension:'gif'};
  }finally{worker.terminate();}
}

async function videoExport(source,options,width,height){
  const mime=['video/mp4;codecs=avc1.42001E','video/webm;codecs=vp9','video/webm;codecs=vp8'].find(type=>globalThis.MediaRecorder?.isTypeSupported(type));
  if(!mime)throw new Error('Video export is unavailable in this browser. Try Chrome.');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
  const stream=canvas.captureStream(0),track=stream.getVideoTracks()[0],recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:5000000}),chunks=[];
  let failure,bytes=0;recorder.ondataavailable=event=>{if(event.data.size){chunks.push(event.data);bytes+=event.data.size;if(bytes>256*1024*1024)failure=new Error('This video is too large. Try a faster playback speed.');}};
  const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=event=>{failure=event.error||new Error('Video encoding failed.');reject(failure);};});
  stopped.catch(()=>{});
  try{
    await source.draw(0);recorder.start(1000);ctx.drawImage(source.canvas,0,0,width,height);track.requestFrame();await wait(100);
    const start=performance.now(),duration=options.movie.duration/options.speed;
    while(true){
      if(failure)throw failure;
      const elapsed=performance.now()-start;await source.draw(Math.min(options.movie.duration,elapsed*options.speed));ctx.drawImage(source.canvas,0,0,width,height);track.requestFrame();
      send({type:'progress',percent:Math.min(99,elapsed/duration*100),message:`Creating video · ${Math.min(99,Math.floor(elapsed/duration*100))}% · keep this tab open`});
      if(elapsed>=duration)break;await wait(1000/30);
    }
    await wait(100);recorder.stop();await stopped;if(failure)throw failure;
    return {blob:new Blob(chunks,{type:mime.split(';')[0]}),extension:mime.startsWith('video/mp4')?'mp4':'webm'};
  }finally{if(recorder.state!=='inactive')recorder.stop();for(const track of stream.getTracks())track.stop();}
}

window.addEventListener('message',async event=>{
  if(started||event.source!==parent||event.origin!==location.origin||event.data?.type!=='export')return;started=true;
  try{
    const options=event.data,width=options.format==='gif'?640:960,height=options.format==='gif'?426:640;
    send({type:'progress',percent:0,message:'Preparing frames…'});const source=await rendererFor(options,width,height);
    const result=options.format==='gif'?await gifExport(source,options,width,height):await videoExport(source,options,width,height);
    send({type:'done',...result});
  }catch(error){send({type:'error',message:error.message||'Export failed.'});}
});
send({type:'ready'});
