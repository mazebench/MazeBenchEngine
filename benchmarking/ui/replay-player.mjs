import { sampleAgentCamera, applyAgentCamera } from './replay-camera.mjs';
import { appendReplayChunk, replayBufferTime } from '../replay-chunks.mjs';
import { benchmarkFetch } from './benchmark-api.mjs';
const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
const playIcon = 'm8 5 11 7-11 7z', pauseIcon = 'M6 5h4v14H6zM14 5h4v14h-4z';
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class RunReplayPlayer {
  constructor(board, id, onPosition) {
    Object.assign(this,{board,id,onPosition,time:0,speed:1,generation:0,playing:false,mode:'3d',following:true,asciiCache:new Map()});
    this.chunkPath = `/api/benchmark/playback/runs/${encodeURIComponent(id)}/chunk`;
    this.container = document.createElement('div');this.container.className='run-replay-player';this.container.tabIndex=-1;
    this.container.innerHTML=`
      <div class="run-replay-toolbar"><div class="run-replay-views" role="group" aria-label="Replay view"><button data-view="3d" aria-pressed="true">3D</button><button data-view="ascii" aria-pressed="false">ASCII</button></div><span class="run-replay-source"></span><button data-command="live" aria-pressed="true" title="Follow new moves automatically">Live</button>
        <details class="run-replay-settings"><summary aria-label="View options" title="View options">ⓘ</summary><div class="run-replay-camera"><label class="run-replay-camera-toggle"><input type="checkbox" data-setting="agent-camera" checked> Agent camera</label><label class="run-replay-camera-toggle"><input type="checkbox" data-setting="neighbors"> Show neighboring rooms</label><div class="run-replay-free-camera" hidden><button data-command="zoom-in" aria-label="Zoom in">+</button><button data-command="zoom-out" aria-label="Zoom out">−</button><button data-command="center" aria-label="Center camera">${icon('M12 3v4m0 10v4M3 12h4m10 0h4M8 8h8v8H8z')}</button></div></div></details>
        <details class="run-replay-download"><summary aria-label="Download replay" title="Download replay">${icon('M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5')}</summary><div class="run-replay-download-menu"><p>Whole run · <span data-export-speed>1×</span></p>${['3d','ascii'].map(mode=>`<div><span>${mode==='3d'?'3D':'ASCII'}</span><button data-export="gif" data-export-view="${mode}" aria-label="Download ${mode==='3d'?'3D':'ASCII'} GIF">GIF</button><button data-export="video" data-export-view="${mode}" aria-label="Download ${mode==='3d'?'3D':'ASCII'} video">Video</button></div>`).join('')}</div></details>
      </div>
      <div class="run-replay-export-status" hidden><progress max="100" value="0" aria-label="Export progress"></progress><span role="status"></span><button data-command="cancel-export">Cancel</button><a hidden>Download again</a></div>
      <div class="run-replay-stage" data-view="3d"><canvas tabindex="0" aria-label="Animated run replay. Following the agent camera."></canvas><div class="run-replay-ascii" hidden aria-label="ASCII replay"></div>
        <div class="run-replay-loading" role="status"><progress max="100" value="0" aria-label="Run loading progress"></progress><span>Loading run…</span></div>
      </div>
      <div class="run-replay-transport"><input class="run-replay-seek" type="range" min="0" max="1" step="0.001" value="0" aria-label="Replay position" disabled>
        <div class="run-replay-controls"><div><button data-command="play" aria-label="Play" disabled>${icon(playIcon)}</button><button data-command="previous" aria-label="Previous move" disabled>${icon('M5 5h2v14H5zm14 0L8 12l11 7z')}</button><button data-command="next" aria-label="Next move" disabled>${icon('M17 5h2v14h-2zM5 5l11 7-11 7z')}</button><output class="run-replay-time">0:00 / 0:00</output></div>
          <span class="run-replay-buffer-status" role="status" hidden></span><div class="run-replay-rates" role="group" aria-label="Playback speed">${[.5,1,2,4,10].map(rate=>`<button data-rate="${rate}" aria-pressed="${rate===1}">${rate}×</button>`).join('')}</div>
          <button data-command="fullscreen" aria-label="Fullscreen">${icon('M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6')}</button>
        </div>
      </div>`;
    board.replaceChildren(this.container);board.removeAttribute('role');board.removeAttribute('aria-label');board.closest('.board-panel').classList.add('tween-replay');
    this.canvas=this.container.querySelector('canvas');this.stage=this.container.querySelector('.run-replay-stage');this.seek=this.container.querySelector('.run-replay-seek');
    this.ascii=this.container.querySelector('.run-replay-ascii');this.agentCamera=this.container.querySelector('[data-setting=agent-camera]');this.neighbors=this.container.querySelector('[data-setting=neighbors]');
    this.agentCamera.addEventListener('change',()=>this.syncCameraMode());this.neighbors.addEventListener('change',()=>this.draw(this.time));
    this.notice=this.container.querySelector('.run-replay-loading');this.playButton=this.button('play');
    this.exportStatus=this.container.querySelector('.run-replay-export-status');
    for(const menu of this.container.querySelectorAll('details'))menu.addEventListener('toggle',()=>{if(menu.open)for(const other of this.container.querySelectorAll('details'))if(other!==menu)other.open=false;});
    this.container.addEventListener('keydown',event=>{if(event.key==='Escape')for(const menu of this.container.querySelectorAll('details'))menu.open=false;});
    this.outsideMenu=event=>{if(!this.container.querySelector('.run-replay-toolbar').contains(event.target))for(const menu of this.container.querySelectorAll('details'))menu.open=false;};
    document.addEventListener('pointerdown',this.outsideMenu);
    this.cancelExportOnLeave=()=>this.exportController?.abort();window.addEventListener('pagehide',this.cancelExportOnLeave);
    this.bufferStatus=this.container.querySelector('.run-replay-buffer-status');
    this.seek.addEventListener('input',()=>this.seekPosition(Number(this.seek.value)));
    this.container.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.export){void this.exportReplay(button.dataset.exportView,button.dataset.export);return;}
      if(button.dataset.view){void this.setMode(button.dataset.view).catch(error=>this.fail(error));return;}
      if(button.dataset.rate){this.speed=Number(button.dataset.rate);this.container.querySelector('[data-export-speed]').textContent=`${this.speed}×`;this.lastFrame=performance.now();for(const b of this.container.querySelectorAll('[data-rate]'))b.setAttribute('aria-pressed',String(b===button));}
      const command=button.dataset.command;
      if(command==='play')this.togglePlay();
      if(command==='cancel-export')this.exportController?.abort();
      if(command==='previous'||command==='next')this.step(command==='previous'?-1:1);
      if(command==='live'){this.setFollowing(this.updateError||!this.following);if(this.following){this.pause();this.pendingSeek=null;this.catchupToLive=!this.complete;this.draw(this.movie?.duration||0);void this.refresh({background:Boolean(this.movie)}).catch(error=>this.fail(error));}}
      if(!this.agentCamera.checked&&command==='center')this.view?.center();
      if(!this.agentCamera.checked&&(command==='zoom-in'||command==='zoom-out'))this.view?.renderer.zoomBy(command==='zoom-in'?.8:1.25);
      if(command==='fullscreen')void(document.fullscreenElement?document.exitFullscreen():this.container.requestFullscreen()).catch(error=>this.fail(error));
    });
    this.container.addEventListener('keydown',event=>{
      if(event.target.closest('input, summary')||event.metaKey||event.ctrlKey||event.altKey||!this.movie)return;
      const key=event.key.toLowerCase();if(!['k',' ','j','l',',','.','home','end'].includes(key))return;
      if(key===' '&&event.target.closest('button')&&event.target!==this.playButton)return;
      event.preventDefault();event.stopPropagation();this.setFollowing(false);
      if(['k',' '].includes(key)){if(!event.repeat)this.togglePlay();}else if([',','.'].includes(key))this.step(key===','?-1:1);
      else if(key==='home'||key==='end')this.seekPosition(key==='home'?0:this.totalActions+1);
      else{this.pause();this.pendingSeek=null;this.draw(this.time+(key==='j'?-5000:5000));this.updateBuffer();}
    });
    this.resize=new ResizeObserver(()=>{if(this.mode==='3d'){this.view?.renderer.resize();if(this.agentCamera.checked)this.draw(this.time);}else this.fitAscii();});this.resize.observe(this.stage);
  }
  button(command){return this.container.querySelector(`[data-command="${command}"]`);}
  setFollowing(value){this.following=value;if(!value)this.catchupToLive=false;this.button('live').setAttribute('aria-pressed',String(value));}
  async update(run){
    const changed=this.run&&run.history_epoch!==this.run.history_epoch;this.run=run;
    this.container.querySelector('.run-replay-source').title=`Agent observations: ${run.observation_mode==='vision'?'Vision':'ASCII'}`;
    if(!this.started){this.started=true;this.mode=run.observation_mode==='vision'?'3d':'ascii';this.setFollowing(Boolean(run.runner_active));this.updateModeUI();await this.refresh();}
    else if(!this.movie||changed||!this.complete||run.action_count>this.actionCount)await this.refresh({background:Boolean(this.movie)});
  }
  refresh(options={}){
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.load(options).finally(()=>{this.refreshing=null;});return this.refreshing;
  }
  async load({background=false}={}){
    const generation=this.generation;
    if(!background){this.busy=true;this.notice.hidden=false;this.notice.classList.remove('replay-error');this.notice.querySelector('span').textContent='Loading run…';this.notice.querySelector('progress').value=0;this.playButton.disabled=true;}
    const [{locateReplay},{replayAscii,asciiFrameAt}]=await Promise.all([import('../../replays/v1/movie.mjs'),import('./replay-ascii.mjs')]);
    this.locate=locateReplay;this.replayAscii=replayAscii;this.asciiFrameAt=asciiFrameAt;
    do {
      const query=new URLSearchParams({after:this.actionCount??-1,epoch:this.epoch||'',templates:this.movie?.templates.length||0,layouts:this.movie?.layouts.length||0,limit:this.movie?256:32});
      const response=await benchmarkFetch(`${this.chunkPath}?${query}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load replay.');if(generation!==this.generation)return;
      await this.acceptChunk(data);if(generation!==this.generation)return;
      // Yield to playback and input before requesting the next verified batch.
      if(!data.complete)await new Promise(resolve=>setTimeout(resolve,0));
    } while(!this.complete&&!this.disposed);
  }
  async acceptChunk(data){
    const append=Boolean(this.movie&&data.from>0&&data.epoch===this.epoch),oldDuration=this.movie?.duration||0;
    if(data.world){
      const world=data.world;world.blocks=world.blocks.map(block=>({...block,visual:{...block.visual,...(block.visual?.modelUrl?{modelUrl:new URL(block.visual.modelUrl,new URL('/level-data/v2/main-world/world.json',location.href)).href}:{})}}));
      world.blockDefinitions=new Map(world.blocks.map(block=>[block.id,block]));this.world=world;
      this.roomLabels=new Map(world.rooms.map(room=>[room.fileName,room.position.join('x')]));
    }
    this.movie=appendReplayChunk(this.movie,this.epoch,data);this.actionCount=data.action_count;this.totalActions=data.total_action_count;this.epoch=data.epoch;this.complete=data.complete;
    if(!append){this.asciiCache.clear();this.asciiKey=null;this.pause();this.pendingSeek=null;this.catchupToLive=this.following&&!this.complete;this.time=this.following&&this.complete?this.movie.duration:0;}
    this.updateBuffer();
    if(this.view){if(append){this.view.movie=this.movie;this.view.gemState.gems=this.movie.gems;}else this.view.setMovie(this.movie);}
    if(this.mode==='3d')await this.ensureView();if(this.disposed)return;
    this.seek.max=String(this.totalActions+1);this.seek.disabled=false;this.playButton.disabled=false;this.busy=false;this.notice.hidden=true;
    this.updateError=false;this.button('live').title='Follow new moves automatically';
    if(this.pendingSeek!=null&&this.pendingSeek<=this.movie.clips.length){this.time=replayBufferTime(this.movie,this.pendingSeek);this.pendingSeek=null;}
    if(this.complete&&this.catchupToLive&&this.following){this.time=this.movie.duration;this.catchupToLive=false;}
    this.draw(this.time);this.updateBuffer();
    if(this.waitingForBuffer&&this.playing&&this.pendingSeek==null)this.startPlayback();
    else if(append&&this.following&&!this.catchupToLive&&this.movie.duration>oldDuration&&!this.playing)this.startPlayback();
  }
  updateBuffer(){
    const percent=100*(this.actionCount+1)/(this.totalActions+1);
    this.seek.style.setProperty('--buffered',`${percent}%`);this.seek.dataset.buffered=String(this.actionCount+1);
    this.notice.querySelector('progress').value=percent;this.notice.querySelector('span').textContent=`Loading run · ${Math.floor(percent)}%`;
    this.bufferStatus.hidden=Boolean(this.complete)&&this.pendingSeek==null;
    this.bufferStatus.textContent=this.updateError?'Loading interrupted · retry with Live':`${this.pendingSeek!=null||this.waitingForBuffer?'Buffering':'Loading'} · ${Math.floor(percent)}%`;
  }
  seekPosition(position){
    if(!this.movie)return;position=Math.max(0,Math.min(this.totalActions+1,position));this.setFollowing(false);this.pause();this.pendingSeek=position>this.movie.clips.length?position:null;
    this.draw(replayBufferTime(this.movie,position));this.updateBuffer();
  }
  async ensureView(){
    if(this.view)return;if(this.creatingView)return this.creatingView;
    this.creatingView=(async()=>{
      const [{ReplayView},{prepareBrowserModels,paintLoadProgress},{installFlyoverControls},{ReplayRoomVisibility}]=await Promise.all([
        import('../../replays/v1/view.mjs'),import('../../ui/browser-world.mjs'),import('../../ui/flyover-controls.mjs'),import('./replay-room-visibility.mjs')]);
      await prepareBrowserModels(new Set(this.world.blocks.map(block=>block.visual?.modelUrl).filter(Boolean)));await paintLoadProgress();
      if(this.disposed)return;
      this.installCameraControls=installFlyoverControls;this.view=new ReplayView(this.canvas,this.world,this.movie);
      this.view.renderer.disposeFlyoverControls();this.view.renderer.disposeFlyoverControls=null;this.roomVisibility=new ReplayRoomVisibility(this.view.renderer);this.syncCameraMode(false);this.view.renderer.resize();
    })().finally(()=>this.creatingView=null);return this.creatingView;
  }
  updateModeUI(){
    for(const button of this.container.querySelectorAll('[data-view]'))if(button.tagName==='BUTTON')button.setAttribute('aria-pressed',String(button.dataset.view===this.mode));
    this.stage.dataset.view=this.mode;this.ascii.hidden=this.mode!=='ascii';this.container.querySelector('.run-replay-settings').hidden=this.mode!=='3d';
  }
  async setMode(mode){
    if(this.mode===mode)return;this.mode=mode;this.updateModeUI();
    if(this.movie&&mode==='3d')await this.ensureView();this.syncCameraMode(false);this.view?.renderer.resize();this.asciiKey=null;this.draw(this.time);
  }
  syncCameraMode(redraw=true){
    const locked=this.agentCamera.checked;this.container.querySelector('.run-replay-free-camera').hidden=locked;
    this.canvas.setAttribute('aria-label',locked?'Animated run replay. Following the agent camera.':'Animated run replay. Drag to orbit; Q and E zoom.');this.canvas.dataset.agentCamera=String(locked);
    if(!this.view)return;const renderer=this.view.renderer;renderer.disposeFlyoverControls?.();renderer.disposeFlyoverControls=null;renderer.cancelCameraMotion();
    if(!locked&&this.mode==='3d')renderer.disposeFlyoverControls=this.installCameraControls(renderer,{window:this.container,document});if(redraw)this.draw(this.time);
  }
  fail(error){
    this.updateError=true;
    if(this.movie){this.button('live').title=`Update failed: ${error.message} Click Live to retry.`;this.updateBuffer();this.bufferStatus.hidden=false;return;}
    this.pause();this.busy=false;this.notice.hidden=false;this.notice.classList.add('replay-error');this.notice.querySelector('span').textContent=`${error.message} Click Live to retry.`;
    if(this.mode==='ascii'&&this.run?.display?.level){this.ascii.textContent=this.run.display.level;this.ascii.style.fontSize='7px';}
  }
  draw(time){
    if(!this.movie)return;let location=this.locate(this.movie,time);this.time=location.time;
    if(this.mode==='ascii')void this.drawAscii(location).catch(error=>this.fail(error));
    else if(this.view){
      const renderer=this.view.renderer;
      if(this.agentCamera.checked){applyAgentCamera(renderer,sampleAgentCamera(location.clip,location.local));if(this.view.lastCamera){renderer.target.x=this.view.lastCamera[0];renderer.target.z=this.view.lastCamera[1];}}
      renderer.renderSuspended=(renderer.renderSuspended||0)+1;
      try{location=this.view.show(time);this.roomVisibility.update(this.neighbors.checked,this.view.scene,location);}finally{renderer.renderSuspended--;}
      renderer.render();
    }
    this.transport(location);
  }
  async drawAscii({clip,local}){
    const frame=this.asciiFrameAt(clip,local),key=`${this.epoch}:${clip.move}:${frame.at}`;if(this.asciiKey===key)return;this.asciiKey=key;
    let rendered=this.asciiCache.get(key);if(!rendered){rendered=await this.replayAscii(this.movie,this.world,clip,local);this.asciiCache.set(key,rendered);while(this.asciiCache.size>100)this.asciiCache.delete(this.asciiCache.keys().next().value);}
    if(this.asciiKey!==key||this.mode!=='ascii')return;
    const pre=document.createElement('pre');
    for(const pixels of rendered.pixels){const row=document.createElement('div');let span,color;
      for(const pixel of pixels){if(!span||color!==pixel.color){span=document.createElement('span');color=pixel.color;span.style.color=color;row.append(span);}span.textContent+=pixel.glyph;}pre.append(row);}
    this.ascii.replaceChildren(pre);this.ascii.dataset.replayMove=String(clip.move);this.fitAscii();
  }
  fitAscii(){
    // Use the world's fixed tile grid, never the current projection's bounds.
    // Camera turns and live moves must not zoom the letters in or out.
    const cells=4*Math.max(this.world?.roomWidth||16,this.world?.roomHeight||16);
    this.ascii.style.fontSize=`${Math.max(3,Math.min(12,(this.stage.clientWidth-28)/(cells*.61),(this.stage.clientHeight-28)/(cells*.86)))}px`;
  }
  transport(location=this.movie&&this.locate(this.movie,this.time)){
    if(!location)return;const{clip,local,index}=location;
    const position=this.pendingSeek??index+local/clip.duration;
    this.seek.value=String(position);this.seek.style.setProperty('--played',`${100*Math.min(position,this.movie.clips.length)/(this.totalActions+1)}%`);this.seek.setAttribute('aria-valuetext',`Move ${Math.min(this.totalActions,Math.floor(position))} of ${this.totalActions}, buffered through move ${this.actionCount}`);
    this.container.querySelector('output').textContent=`${clock(this.time)} / ${this.complete?clock(this.movie.duration):'…'}`;this.playButton.setAttribute('aria-label',this.playing?'Pause':'Play');this.playButton.querySelector('path').setAttribute('d',this.playing?pauseIcon:playIcon);
    this.button('previous').disabled=this.time<=0;this.button('next').disabled=this.complete&&this.time>=this.movie.duration;
    const room=this.roomLabels.get(local>=clip.settledAt?clip.to:clip.room);
    this.container.querySelector('.run-replay-source').textContent=`${room||'—'} · move ${clip.move.toLocaleString()}`;
    this.onPosition({move:clip.move,room,index,mode:this.mode});
  }
  togglePlay(){if(!this.movie||this.busy)return;this.setFollowing(false);if(this.playing){this.pause();this.updateBuffer();return;}if(this.complete&&this.time>=this.movie.duration&&this.pendingSeek==null)this.draw(0);this.startPlayback();}
  startPlayback(){
    if((this.playing&&!this.waitingForBuffer)||!this.movie||document.hidden||!this.container.getClientRects().length)return;
    if(this.pendingSeek!=null||(!this.complete&&this.time>=this.movie.duration)){this.playing=true;this.waitingForBuffer=true;this.transport();this.updateBuffer();return;}
    if(this.time>=this.movie.duration){this.pause();return;}
    this.playing=true;this.waitingForBuffer=false;this.lastFrame=performance.now();this.transport();this.updateBuffer();
    const tick=now=>{if(!this.playing)return;const time=this.time+Math.max(0,now-this.lastFrame)*this.speed;this.lastFrame=now;this.draw(time);
      if(this.time>=this.movie.duration){if(this.complete)this.pause();else{this.waitingForBuffer=true;this.updateBuffer();}}else this.frame=requestAnimationFrame(tick);};this.frame=requestAnimationFrame(tick);
  }
  pause(){this.playing=false;this.waitingForBuffer=false;cancelAnimationFrame(this.frame);this.view?.renderer.cancelCameraMotion();this.transport();}
  step(direction){if(!this.movie)return;const{index,clip}=this.locate(this.movie,this.time);this.seekPosition(direction<0?this.time>clip.start?index:Math.max(0,index-1):Math.min(this.totalActions+1,index+1));}
  seekMove(move){this.seekPosition(move);}
  async exportReplay(mode,format){
    if(this.exportController)return;
    const controller=new AbortController();this.exportController=controller;
    const status=this.exportStatus,link=status.querySelector('a'),cancel=this.button('cancel-export');status.hidden=false;cancel.hidden=false;link.hidden=true;
    if(this.exportURL){URL.revokeObjectURL(this.exportURL);this.exportURL=null;}
    for(const menu of this.container.querySelectorAll('details'))menu.open=false;
    for(const button of this.container.querySelectorAll('[data-export]'))button.disabled=true;
    const progress=({percent=0,message})=>{status.querySelector('progress').value=percent;status.querySelector('span').textContent=message;};
    progress({message:'Preparing export…'});
    try{
      const {exportRunReplay}=await import('./replay-export.mjs');
      const {blob,extension,speed}=await exportRunReplay(this,{mode,format,signal:controller.signal,onProgress:progress});controller.signal.throwIfAborted();
      this.exportURL=URL.createObjectURL(blob);link.href=this.exportURL;link.download=`${this.id}-${mode}-${speed}x.${extension}`;link.hidden=false;
      progress({percent:100,message:`${mode==='3d'?'3D':'ASCII'} ${extension.toUpperCase()} ready · ${(blob.size/1024/1024).toFixed(1)} MB`});link.click();
    }catch(error){progress({message:controller.signal.aborted?'Export cancelled.':`Export failed: ${error.message}`});}
    finally{this.exportController=null;cancel.hidden=true;for(const button of this.container.querySelectorAll('[data-export]'))button.disabled=false;}
  }
  dispose(){this.disposed=true;this.generation++;this.pause();this.exportController?.abort();if(this.exportURL)URL.revokeObjectURL(this.exportURL);document.removeEventListener('pointerdown',this.outsideMenu);window.removeEventListener('pagehide',this.cancelExportOnLeave);this.resize.disconnect();this.view?.renderer.disposeFlyoverControls?.();this.view?.scene?.dispose();this.view?.sceneCache?.clear();}
}
