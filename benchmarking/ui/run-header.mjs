import {harnessName,runCardValues} from './run-library.mjs';
import {modelLabel,modelSpeed} from './model-label.mjs';
import {codingLabel} from '../capabilities.mjs';

// Reorganize the live UI without editing the signed historical HTML shell.
export function createRunHeader(elements){
  const hero=elements['model-hero'],actions=hero.querySelector('.run-actions');
  const title=elements['run-title'],setup=elements['run-kicker'],logo=elements['model-monogram'];
  const back=document.querySelector('.topbar .back-link');
  back.setAttribute('aria-label','Back to runs');back.title='Back to runs';
  logo.className='record-logo run-header-logo';logo.removeAttribute('aria-hidden');logo.setAttribute('role','img');
  logo.innerHTML='<img alt="" width="24" height="24" hidden><span class="record-logo-fallback" aria-hidden="true">?</span>';
  const first=document.createElement('div');first.className='run-header-main';
  const identity=document.createElement('div');identity.className='run-header-identity';
  const version=document.createElement('span');version.className='run-header-version';
  identity.append(logo,title,version);first.append(back,identity,setup,actions);
  const second=document.createElement('div');second.className='run-header-bottom';
  const metrics=elements['stat-actions'].closest('.stat-grid');metrics.classList.add('run-header-metrics');
  elements['stat-cells'].previousElementSibling.textContent='Cells';
  second.append(metrics,document.querySelector('.run-tabs'));
  hero.replaceChildren(first,second);
  document.querySelector('#view-analysis .analysis-grid').append(document.querySelector('.progress-panel'));
  return {update(run){
    document.body.classList.add('compact-run');
    const values=runCardValues(run),image=logo.querySelector('img');
    logo.setAttribute('aria-label',values.company);logo.title=values.company;logo.classList.toggle('monochrome',values.monochromeLogo);
    if(values.logo&&image.getAttribute('src')!==values.logo)image.src=values.logo;
    image.hidden=!values.logo;logo.querySelector('.record-logo-fallback').hidden=Boolean(values.logo);
    title.textContent=modelLabel(run.model);title.title=[run.created_at&&new Date(run.created_at).toLocaleString(),run.id].filter(Boolean).join(' · ');
    version.textContent=values.version.label;version.title=values.version.detail;
    setup.textContent=[run.world==='ice-maze'?'Ice Maze':run.world==='slotski'?'Slotski':null,
      `${harnessName(run)} ${run.effort||''}`.trim(),run.observation_mode==='vision'?'Vision':'ASCII',codingLabel(run),
      modelSpeed(run)==='fast'?'Fast':null,run.character_seed?`Character seed ${run.character_seed}`:null,
      run.world==='slotski'?(run.sequence_enabled===false?'Single moves':'Batched moves'):null].filter(Boolean).join(' · ');
  }};
}
