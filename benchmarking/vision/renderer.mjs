import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
async function playwright(){
  const candidates=[process.env.MAZEBENCH_PLAYWRIGHT_MODULE];
  try{candidates.push(require.resolve('playwright'));}catch{}
  candidates.push(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
  for(const file of candidates.filter(Boolean)){try{await access(file);return await import(pathToFileURL(file).href);}catch{}}
  throw new Error('Vision rendering requires Playwright. Install it or set MAZEBENCH_PLAYWRIGHT_MODULE.');
}
export class VisionRenderer {
  constructor(root){this.root=root;this.queue=Promise.resolve();}
  async initialize(){
    if(this.page)return;
    const {chromium}=await playwright();
    const chrome=process.env.MAZEBENCH_CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    this.browser=await chromium.launch({headless:true,executablePath:chrome,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    this.page=await this.browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1,serviceWorkers:'block'});
    await this.page.route('**/*',async route=>{
      const url=new URL(route.request().url()),relative=decodeURIComponent(url.pathname).slice(1);
      if(url.origin!=='http://vision-render.invalid'||route.request().method()!=='GET'||relative.split('/').some(p=>p==='..'||p.startsWith('.'))||
        !(/^(render\/(v1|vendor)\/.*\.(mjs|js|glb)|benchmarking\/vision\/render-page\.(html|mjs))$/.test(relative)))return route.abort();
      try{const body=await readFile(path.join(this.root,relative));await route.fulfill({status:200,contentType:relative.endsWith('.html')?'text/html':relative.endsWith('.glb')?'model/gltf-binary':'text/javascript',body});}catch{await route.abort();}
    });
    await this.page.goto('http://vision-render.invalid/benchmarking/vision/render-page.html');
    await this.page.waitForFunction(()=>typeof window.renderVisionFrame==='function');
  }
  render(frame){
    const job=this.queue.then(async()=>{await this.initialize();await this.page.evaluate(frame=>window.renderVisionFrame(frame),frame);return this.page.locator('#board').screenshot({type:'png',animations:'disabled'});});
    this.queue=job.catch(()=>{});return job;
  }
  async close(){await this.queue;await this.browser?.close();this.page=null;this.browser=null;}
}
