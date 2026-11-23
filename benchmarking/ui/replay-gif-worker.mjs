import {GIFEncoder,quantize,applyPalette} from './vendor/gifenc-1.0.3.mjs';
let gif;
self.onmessage=({data})=>{
  try{
    if(data.type==='start'){gif=GIFEncoder();self.postMessage({type:'ready'});}
    else if(data.type==='frame'){
      const rgba=new Uint8Array(data.pixels),palette=quantize(rgba,256,{format:'rgb565'});
      gif.writeFrame(applyPalette(rgba,palette,'rgb565'),data.width,data.height,{palette,delay:data.delay,repeat:0});
      if(gif.bytesView().byteLength>256*1024*1024)throw new Error('This GIF is too large. Try a faster playback speed or video.');
      self.postMessage({type:'ready'});
    }else if(data.type==='finish'){
      gif.finish();const bytes=gif.bytes();self.postMessage({type:'done',bytes},[bytes.buffer]);gif=null;
    }
  }catch(error){self.postMessage({type:'error',message:error.message});}
};
