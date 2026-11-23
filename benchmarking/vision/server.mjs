import { resumeExclusively } from "../storage/resume-lock.mjs";
// A companion supervisor keeps existing ASCII runners alive in their original
// process. Its API forwards ASCII operations to that owner; vision has a
// separate record root and cannot be accidentally resumed through ASCII MCP.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { VisionSupervisor } from './supervisor.mjs';
import { VisionRenderer } from './renderer.mjs';
import { VisionRuntime } from './runtime.mjs';
import { verifyVisionIntegrity } from './policy.mjs';
import { loadBenchmarkAssets } from '../v1/runtime.mjs';
import { TokenTelemetry } from '../token-telemetry.mjs';
import { RunTelemetry } from '../run-telemetry.mjs';
export function trustedVisionRequest(request,port,mainPort){
  const host=String(request.headers.host||'').toLowerCase();
  if(![`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`].includes(host)||request.headers['sec-fetch-site']==='cross-site')return false;
  const origin=request.headers.origin;
  return !origin||[`http://${host}`,`http://localhost:${mainPort}`,`http://127.0.0.1:${mainPort}`,`http://[::1]:${mainPort}`].includes(origin);
}
export function createVisionServer(root,options={}){
  const port=options.port||8082,mainPort=options.mainPort||8080;
  const supervisor=options.supervisor||new VisionSupervisor(root,options),renderer=options.renderer||new VisionRenderer(root);
  const tokens=new TokenTelemetry(),charts=new RunTelemetry();
  const reply=(response,status,value,type='application/json')=>{response.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
  const server=createServer(async(request,response)=>{
    if(!trustedVisionRequest(request,port,mainPort))return reply(response,403,{error:'Only trusted localhost requests are accepted.'});
    if(request.headers.origin){response.setHeader('Access-Control-Allow-Origin',request.headers.origin);response.setHeader('Vary','Origin');}
    if(request.method==='OPTIONS'){response.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, DELETE, OPTIONS');response.setHeader('Access-Control-Allow-Headers','Content-Type');response.writeHead(204);return response.end();}
    const url=new URL(request.url,'http://'+request.headers.host),prefix='/api/benchmark/v1';
    let body;
    try{
      if(['POST','DELETE'].includes(request.method)){let length=0;const chunks=[];for await(const chunk of request){length+=chunk.length;if(length>32768)throw new Error('Request too large.');chunks.push(chunk);}body=Buffer.concat(chunks);}
      if(url.pathname==='/api/benchmark/vision/status')return reply(response,200,{available:true,observation_mode:'vision'});
      if(request.method==='GET'&&url.pathname==='/api/benchmark/vision/preview'){
        const assets=await loadBenchmarkAssets(root),room=assets.roomsByLabel.get((url.searchParams.get('room')||'HxI').toUpperCase());
        const yaw=Number(url.searchParams.get('yaw')||0),pitch=Number(url.searchParams.get('pitch')??2);
        if(!room||!Number.isInteger(yaw)||yaw<0||yaw>3||!Number.isInteger(pitch)||pitch<0||pitch>4)throw new Error('Invalid room or camera.');
        const projected=assets.engine.roomFromState(assets.engine.createState(room),room);
        return reply(response,200,await renderer.render({room:{width:projected.width,height:projected.height,objects:projected.objects},blocks:assets.blocks,camera:{yaw,pitch}}),'image/png');
      }
      const main=async()=>fetch(`http://127.0.0.1:${mainPort}${url.pathname}${url.search}`,{method:request.method,headers:body?{'Content-Type':'application/json'}:{},...(body?.length?{body}:{})});
      if(url.pathname===prefix+'/runs'&&request.method==='GET'){
        const existing=await main().then(r=>r.json());return reply(response,200,{runs:[...(existing.runs||[]),...await supervisor.list()].sort((a,b)=>b.created_at.localeCompare(a.created_at))});
      }
      if([prefix+'/runs',prefix+'/pairs'].includes(url.pathname)&&request.method==='POST'){
        const spec=JSON.parse(body||'{}');if(spec.observation_mode==='vision')return reply(response,202,await (url.pathname.endsWith('/pairs')?supervisor.launchPair(spec):supervisor.launch(spec)));
      }
      const match=new RegExp('^'+prefix+'/runs/([^/]+)(?:/(.*))?$').exec(url.pathname);
      if(match){
        const id=decodeURIComponent(match[1]),suffix=match[2]||'',directory=supervisor.runDirectory(id);
        if(existsSync(path.join(directory,'run.json'))){
          if(!suffix&&request.method==='GET'){const run=await supervisor.get(id,{historyCursor:url.searchParams.get("history_cursor")});const t=await tokens.read(directory).catch(()=>null);if(t?.totals)run.usage=t.totals;return reply(response,200,run);}
          if(!suffix&&request.method==='DELETE')return reply(response,200,await supervisor.delete(id));
          if(['pause','stop','resume'].includes(suffix)&&request.method==='POST')return reply(response,200,await (suffix==='resume'?resumeExclusively(supervisor,id):supervisor[suffix](id)));
          if(suffix==='tokens'&&request.method==='GET')return reply(response,200,await tokens.read(directory));
          if(suffix==='charts'&&request.method==='GET')return reply(response,200,await charts.read(directory,{runnerActive:supervisor.active.has(id)}));
          if(suffix==='interviews'&&request.method==='GET')return reply(response,200,await supervisor.listInterviews(id));
          if(/^display\/(0|[1-9]\d*)$/.test(suffix)&&request.method==='GET')return reply(response,200,await supervisor.displayFrame(id,suffix.split('/')[1]));
          if(suffix.startsWith('record/')&&request.method==='GET'){
            const metadata=await supervisor.get(id,{details:false});await verifyVisionIntegrity(root,directory,metadata);
            const runtime=await VisionRuntime.open(root,directory),value=await runtime.readRecord(decodeURIComponent(suffix.slice(7)));
            return value.frame?reply(response,200,await renderer.render(value.frame),'image/png'):reply(response,200,value.content,'text/plain; charset=utf-8');
          }
          return reply(response,404,{error:'Unknown vision operation.'});
        }
      }
      const upstream=await main();reply(response,upstream.status,Buffer.from(await upstream.arrayBuffer()),upstream.headers.get('content-type')||'application/octet-stream');
    }catch(error){reply(response,400,{error:String(error.message||error)});}
  });
  server.on('close',()=>{void renderer.close();});
  return {server,supervisor,renderer};
}
if(process.argv[1]===import.meta.filename){
  const root=path.resolve(import.meta.dirname,'../..');
  const port=Number(process.env.MAZEBENCH_VISION_PORT||8082),mainPort=Number(process.env.MAZEBENCH_BENCHMARK_PORT||8080);
  const {server,supervisor,renderer}=createVisionServer(root,{port,mainPort});
  server.listen(port,'127.0.0.1',()=>console.log(`MazeBench vision available at http://localhost:${port}/benchmarking/v1/`));
  let closing=false;
  const shutdown=async()=>{
    if(closing)return;closing=true;
    await Promise.allSettled([...supervisor.active.keys()].map(id=>supervisor.pause(id)));
    server.close();server.closeAllConnections();await renderer.close();process.exit();
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
