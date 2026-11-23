// Additive owner: the existing Codex vision and ASCII processes keep running.
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {ProviderVisionSupervisor} from './supervisor.mjs';
import {PROVIDERS,verifyProviderVisionIntegrity} from './policy.mjs';
import {trustedVisionRequest} from '../vision/server.mjs';
import {VisionRuntime} from '../vision/runtime.mjs';
import {VisionRenderer} from './renderer.mjs';
import {ReportReader} from '../report-reader.mjs';
import {RunDashboard} from '../run-dashboard.mjs';
import {RunLibrary} from '../run-library.mjs';
import {readRunVersion} from '../run-version.mjs';
import {safeReadFile} from '../v1/safe-files.mjs';
import {resumeExclusively} from '../storage/resume-lock.mjs';
export function createProviderVisionServer(root,options={}) {
  const port=options.port||8086,mainPort=options.mainPort||8080,upstreamPort=options.upstreamPort||8084;
  const supervisor=options.supervisor||new ProviderVisionSupervisor(root,options),renderer=new VisionRenderer(root),reports=new ReportReader(),library=new RunLibrary(),dashboard=new RunDashboard(library);
  const reply=(res,status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
  async function decorate(run){const directory=supervisor.runDirectory(run.id),metadata=JSON.parse(safeReadFile(directory,'run.json'));run.benchmark_version=readRunVersion(directory,metadata,(await library.snapshot(directory)).summary);run.capability_boundary_verified=!existsSync(path.join(directory,'integrity-violation.json'));return run;}
  const server=createServer(async(req,res)=>{
    if(!trustedVisionRequest(req,server.address()?.port||port,mainPort))return reply(res,403,{error:'Only trusted localhost requests are accepted.'});
    if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');return reply(res,204,'');}
    const url=new URL(req.url,'http://'+req.headers.host),prefix='/api/benchmark/v1';
    try {
      if(url.pathname==='/api/benchmark/vision-providers/status')return reply(res,200,{available:true,providers:PROVIDERS,observation_mode:'vision',coding_modes:['off']});
      let body;
      if(['POST','DELETE'].includes(req.method)){const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>32768)throw new Error('Request too large.');chunks.push(chunk);}body=Buffer.concat(chunks);}
      const forward=async()=>{
        const upstream=await fetch(`http://127.0.0.1:${upstreamPort}${url.pathname}${url.search}`,{method:req.method,headers:body?.length?{'Content-Type':'application/json'}:{},...(body?.length?{body}:{})});
        return upstream;
      };
      if(req.method==='GET'&&url.pathname===prefix+'/providers'){
        const upstream=await forward();if(!upstream.ok)return reply(res,upstream.status,await upstream.text());const values=await upstream.json();
        for(const name of PROVIDERS)if(values[name])Object.assign(values[name],{vision_available:true,vision_coding_modes:['off']});
        return reply(res,200,values);
      }
      if(req.method==='GET'&&url.pathname===prefix+'/runs'){
        const upstream=await forward();if(!upstream.ok)return reply(res,upstream.status,await upstream.text());const value=await upstream.json(),runs=new Map((value.runs||[]).map(run=>[run.id,run]));
        for(const run of await supervisor.list())runs.set(run.id,await decorate(run));
        return reply(res,200,{...value,runs:[...runs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at))});
      }
      if(req.method==='POST'&&[prefix+'/runs',prefix+'/pairs'].includes(url.pathname)){
        const spec=JSON.parse(body||'{}');
        if(spec.observation_mode==='vision'&&PROVIDERS.includes(spec.provider)){
          if(url.pathname.endsWith('/pairs'))throw new Error('This vision harness supports coding off. Start a single run.');
          return reply(res,202,await decorate(await supervisor.launch(spec)));
        }
      }
      const match=new RegExp('^'+prefix+'/runs/([^/]+)(?:/(.*))?$').exec(url.pathname);
      if(match&&supervisor.owns(decodeURIComponent(match[1]))){
        const id=decodeURIComponent(match[1]),suffix=match[2]||'',directory=supervisor.runDirectory(id);
        if(req.method==='GET'&&!suffix){
          const view=url.searchParams.get('view');
          if(view==='analysis')return reply(res,200,await reports.read(directory,'analysis',supervisor.active.has(id)));
          if(view==='activity')return reply(res,200,await dashboard.activity(supervisor,id));
          const run=view==='overview'?await dashboard.overview(supervisor,id):await supervisor.get(id,{historyCursor:url.searchParams.get('history_cursor')});
          const tokens=await reports.read(directory,'tokens').catch(()=>null);if(tokens?.totals)run.usage=tokens.totals;
          return reply(res,200,await decorate(run));
        }
        if(req.method==='POST'&&['pause','stop','resume'].includes(suffix))return reply(res,200,await(suffix==='resume'?resumeExclusively(supervisor,id):supervisor[suffix](id)));
        if(req.method==='DELETE'&&!suffix)return reply(res,200,await supervisor.delete(id));
        if(req.method==='GET'&&['tokens','charts'].includes(suffix))return reply(res,200,await reports.read(directory,suffix,supervisor.active.has(id)));
        if(req.method==='GET'&&suffix==='interviews')return reply(res,200,await supervisor.listInterviews(id));
        if(req.method==='GET'&&/^display\/(0|[1-9]\d*)$/.test(suffix))return reply(res,200,await dashboard.frame(supervisor,id,suffix.split('/')[1]));
        if(req.method==='GET'&&suffix.startsWith('record/')){
          const metadata=JSON.parse(safeReadFile(directory,'run.json'));await verifyProviderVisionIntegrity(root,directory,metadata);
          const runtime=await VisionRuntime.open(root,directory),value=await runtime.readRecord(decodeURIComponent(suffix.slice(7)));
          return value.frame?reply(res,200,await renderer.render(value.frame),'image/png'):reply(res,200,value.content,'text/plain; charset=utf-8');
        }
        return reply(res,404,{error:'Unknown vision operation.'});
      }
      if(!url.pathname.startsWith('/api/benchmark/'))return reply(res,404,{error:'Unknown route.'});
      const upstream=await forward();return reply(res,upstream.status,Buffer.from(await upstream.arrayBuffer()),upstream.headers.get('content-type')||'application/json');
    }catch(error){return reply(res,400,{error:String(error.message||error)});}
  });
  return {server,supervisor,renderer};
}
if(process.argv[1]===import.meta.filename){
  const root=path.resolve(import.meta.dirname,'../..'),{server,supervisor,renderer}=createProviderVisionServer(root);
  server.listen(8086,'127.0.0.1',()=>console.log('Subscription vision runner ready on localhost:8086'));
  let closing=false;const shutdown=async()=>{if(closing)return;closing=true;await Promise.allSettled([...supervisor.active.keys()].map(id=>supervisor.pause(id)));server.close();server.closeAllConnections();await renderer.close();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
