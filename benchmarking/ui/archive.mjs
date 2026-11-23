import { runCardValues } from './run-library.mjs';
import { modelSlug } from './model-label.mjs';
import { comparisonReport, comparisonBounds, comparisonScale, drawComparisonMap } from './heatmap-comparison.mjs';

const $ = id => document.getElementById(id);
const base = `http://${location.hostname}:8085/api/benchmark/archive/runs`;
const number = value => Number(value || 0).toLocaleString();
let runs = [], filter = 'all', page = 0, serial = 0, active, map, current = 0, total = 0, speed = 1, timer, playing = false;
const frames = new Map(), pending = new Map();
async function api(suffix = '') {
  const response = await fetch(base + suffix);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Archive unavailable.');
  return data;
}
function metrics(node, run) {
  node.replaceChildren();
  for (const [label, value] of [['Actions',run.action_count],['Gems',run.gems_collected],['Rooms',run.rooms_visited]]) {
    const item = document.createElement('div'), caption = document.createElement('span'), count = document.createElement('strong');
    caption.textContent = label; count.textContent = number(value); item.append(caption,count); node.append(item);
  }
}
function paintList() {
  const query = $('search').value.trim().toLowerCase();
  const selected = runs.filter(r => (filter !== 'favorite' || r.favorite) && (filter !== 'video' || r.recorded_video) &&
    [r.model,r.harness,r.id,r.version].join(' ').toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(selected.length / 24)); page = Math.min(page,pages-1);
  $('archive-grid').replaceChildren();
  for (const run of selected.slice(page*24,page*24+24)) {
    const values = runCardValues(run), card = document.createElement('a');
    card.className = 'archive-card'; card.href = `?id=${encodeURIComponent(run.id)}`;
    card.innerHTML = '<div class="card-title"><img alt=""><strong></strong></div><div class="card-badges"></div><div class="archive-metrics"></div><div class="card-footer"><span></span><span class="archive-tag"></span></div>';
    const img = card.querySelector('img'); img.hidden = !values.logo;
    if (values.logo) img.src = values.logo; img.classList.toggle('white-logo',values.monochromeLogo);
    card.querySelector('strong').textContent = modelSlug(run.model);
    for (const [label, className] of [[run.effort || 'Default',''],[run.observation_mode==='json'?'JSON':values.observation,'observation'],[run.tools_enabled?'Coding on':'Coding off','']]) {
      const badge = document.createElement('span'); badge.textContent = label; badge.className=className; card.querySelector('.card-badges').append(badge);
    }
    metrics(card.querySelector('.archive-metrics'), run);
    card.querySelector('.card-footer>span').textContent = [values.timestamp,run.recorded_video?'Video':'',run.favorite?'★':''].filter(Boolean).join(' · ');
    card.querySelector('.archive-tag').textContent=run.version;
    card.querySelector('.archive-tag').title = run.version_evidence.explanation;
    card.addEventListener('click', event => { if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return; event.preventDefault(); history.pushState({},'',card.href); openRun(run.id); });
    $('archive-grid').append(card);
  }
  $('library-status').textContent = selected.length ? `${number(selected.length)} archived runs` : 'No matching runs.';
  $('page-label').textContent = `${page+1} / ${pages}`; $('previous').disabled = page===0; $('next').disabled = page>=pages-1;
}
function pause() { playing=false; clearTimeout(timer); $('play').textContent='▶'; $('play').setAttribute('aria-label','Play recorded frames'); }
async function loadFrames(index, generation) {
  const start=Math.floor(index/64)*64;
  if(!pending.has(start)) pending.set(start,api(`/${active.id}/frames?from=${start}&limit=64`).then(data=>{
    if(generation!==serial)return;
    for(const frame of data.frames)frames.set(frame.index,frame);
    // Keep several adjacent chunks, not an entire long run, in browser memory.
    if(frames.size>640)for(const key of frames.keys())if(Math.abs(key-index)>256)frames.delete(key);
  }).finally(()=>{if(generation===serial)pending.delete(start);}));
  await pending.get(start);
}
async function showFrame(index, generation=serial) {
  index=Math.max(0,Math.min(total-1,index));
  if(total<1)return;
  current=index; $('scrub').value=index;
  if(!frames.has(index)) { $('detail-status').textContent='Loading recorded frames…'; await loadFrames(index,generation); }
  if(generation!==serial || current!==index)return;
  const frame=frames.get(index); if(!frame)return;
  $('detail-status').textContent='';
  $('ascii').textContent=frame.ascii || (frame.observation?JSON.stringify(frame.observation,null,2):'No observation was recorded for this action.');
  $('frame-count').textContent=`${number(index)} / ${number(total-1)}`;
  $('frame-caption').textContent=[frame.room?.replace('level_','').replace('x','×'),`Action ${number(frame.action)}`,frame.command].filter(Boolean).join(' · ');
}
async function tick() {
  if(!playing)return;
  if(current>=total-1)return pause();
  try { await showFrame(current+1); if(playing)timer=setTimeout(tick,250/speed); }
  catch(error){pause();$('detail-status').textContent=error.message;}
}
function drawMap(){if(map&&!$('detail').hidden)drawComparisonMap($('heatmap'),map,comparisonBounds([map]),'count',comparisonScale([map]),null);}
function view(video){pause();$('video').hidden=!video;$('ascii-player').hidden=video;$('video-tab').setAttribute('aria-pressed',String(video));$('ascii-tab').setAttribute('aria-pressed',String(!video));if(!video)$('video').pause();}
async function openRun(id) {
  const generation=++serial;pause();$('video').pause();$('video').removeAttribute('src'); frames.clear();pending.clear();map=null;active=null;total=0;
  $('library').hidden=true;$('detail').hidden=false;$('model').textContent='Loading run…';$('detail-status').textContent='Loading original recording…';
  $('ascii').textContent='';$('detail-metrics').replaceChildren();$('condition').textContent='';$('version').textContent='';$('detail-logo').hidden=true;
  $('heatmap').getContext('2d').clearRect(0,0,$('heatmap').width,$('heatmap').height);$('heatmap-status').textContent='Loading visits…';
  $('version-candidates').replaceChildren();$('evidence-description').textContent='';$('board-hash').textContent='';$('evidence-label').textContent='';
  $('video-tab').hidden=true;$('scrub').disabled=true;$('play').disabled=true;view(false);
  try {
    const run=await api('/'+encodeURIComponent(id));if(generation!==serial)return;active=run;total=run.frame_count;
    const values=runCardValues(run);$('model').textContent=modelSlug(run.model);$('version').textContent=run.version;
    $('condition').textContent=[run.harness,run.effort,run.observation_mode==='json'?'JSON':values.observation,run.tools_enabled?'Coding on':'Coding off'].filter(Boolean).join(' · ');
    $('ascii-tab').textContent=run.observation_mode==='json'?'JSON':'ASCII';
    $('detail-logo').hidden=!values.logo;if(values.logo)$('detail-logo').src=values.logo;$('detail-logo').classList.toggle('white-logo',values.monochromeLogo);
    metrics($('detail-metrics'),run);$('scrub').max=Math.max(0,total-1);$('scrub').disabled=total<2;$('play').disabled=total<2;
    $('video-tab').hidden=!run.recorded_video;if(run.recorded_video)$('video').src=base+'/'+run.id+'/video';
    const evidence=run.version_evidence;$('evidence-label').textContent=evidence.assigned_version?`${evidence.assigned_version} · Git history`:evidence.exact_version?'Verified':'Awaiting assignment';
    $('evidence-description').textContent=evidence.explanation;
    const commitLink=evidence.assignment?.github_url;
    $('version-commit').hidden=!commitLink?.startsWith('https://github.com/mazebench/MazeBenchEngine/commit/');
    if(!$('version-commit').hidden)$('version-commit').href=commitLink;
    if(!evidence.assigned_version)for(const version of evidence.recorded_state_candidates ?? evidence.initial_state_candidates ?? []){const tag=document.createElement('span');tag.className='archive-tag';tag.textContent=version.replace('v1.0.','Historical snapshot ');$('version-candidates').append(tag);}
    $('board-hash').textContent=evidence.board_state_hash?`Recorded initial board SHA-256: ${evidence.board_state_hash}`:'';
    $('compare').href='../v1/compare.html?left='+encodeURIComponent(run.import_id);
    if(run.initial_frame)frames.set(0,run.initial_frame);
    if(total)await showFrame(0,generation);else{$('ascii').textContent='This archive contains metadata only; no recorded frames survived.';$('detail-status').textContent='';$('frame-count').textContent='0 frames';$('frame-caption').textContent='';}
    if(generation!==serial)return;
    if(run.recorded_video)view(true);
    try{const report=await api('/'+run.id+'/heatmap');if(generation!==serial)return;map=comparisonReport(report).map;drawMap();$('heatmap-status').textContent=map.points.length?`${number(map.points.length)} visited cells · Recorded action endpoints`:'No movement was recorded.';}
    catch(error){if(generation===serial)$('heatmap-status').textContent=error.message;}
  }catch(error){if(generation===serial){$('model').textContent='Run unavailable';$('detail-status').textContent=error.message;}}
}
function library(){serial++;pause();$('video').pause();$('detail').hidden=true;$('library').hidden=false;paintList();}
$('back').addEventListener('click',()=>{history.pushState({},'',location.pathname);library();});
window.addEventListener('popstate',()=>{const id=new URLSearchParams(location.search).get('id');if(id)openRun(id);else library();});
$('search').addEventListener('input',()=>{page=0;paintList();});
document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.filter;page=0;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));paintList();}));
$('previous').addEventListener('click',()=>{page--;paintList();});$('next').addEventListener('click',()=>{page++;paintList();});
$('play').addEventListener('click',()=>{if(playing)return pause();if(current>=total-1)current=-1;playing=true;$('play').textContent='Ⅱ';$('play').setAttribute('aria-label','Pause recorded frames');tick();});
$('scrub').addEventListener('input',()=>{pause();showFrame(Number($('scrub').value)).catch(error=>{$('detail-status').textContent=error.message;});});
document.querySelectorAll('[data-speed]').forEach(button=>button.addEventListener('click',()=>{speed=Number(button.dataset.speed);document.querySelectorAll('[data-speed]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));}));
$('ascii-tab').addEventListener('click',()=>view(false));$('video-tab').addEventListener('click',()=>view(true));
new ResizeObserver(drawMap).observe($('heatmap'));
try{runs=(await api()).runs.sort((a,b)=>b.created_at.localeCompare(a.created_at));paintList();const id=new URLSearchParams(location.search).get('id');if(id)openRun(id);}
catch(error){$('library-status').textContent=error.message;}
finally{$('library-progress').hidden=true;}
