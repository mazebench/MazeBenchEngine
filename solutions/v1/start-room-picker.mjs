import { engineRoleIdForObject } from '../../engine/current/adapter.mjs';

const normalize=value=>String(value).toUpperCase().replace(/ROOM/g,'').replace(/[\s×X,·/-]/g,'');
export const matchesRoom=(room,query)=>normalize(room.position.join('')).startsWith(normalize(query));

export function startingRoomChoices(world) {
  const blocks=new Map(world.blocks.map(block=>[block.id,block]));
  return [...world.rooms].sort((a,b)=>a.rowIndex-b.rowIndex||a.columnIndex-b.columnIndex).map(room=>({
    room,label:room.position.join('×'),
    start:room.objects.find(object=>engineRoleIdForObject(object,blocks)==='player'&&object.x>=0&&object.y>=0&&object.x<room.width&&object.y<room.height&&object.z!==-2147483648),
    gems:room.objects.filter(object=>engineRoleIdForObject(object,blocks)==='goal').length
  }));
}

export function savedSolutionSummary(saved) {
  if(!saved)return null;
  const routes=Array.isArray(saved.routes)?saved.routes:[];
  return {runs:routes.length,moves:routes.reduce((total,route)=>total+(route?.actions?.length||0),0)+(saved.draft?.actions?.length||0)};
}

export function drawRoomPreview(canvas,choice,blocks,resolution=320) {
  const {room,start}=choice;
  canvas.width=resolution;canvas.height=resolution;
  const context=canvas.getContext('2d');
  if(!context)return;
  const size=Math.min(resolution*.9/room.width,resolution*.9/room.height);
  const left=(resolution-size*room.width)/2,top=(resolution-size*room.height)/2,inset=size*.045;
  context.fillStyle='#0d1015';context.fillRect(0,0,resolution,resolution);
  for(let y=0;y<room.height;y++)for(let x=0;x<room.width;x++){
    context.fillStyle=(x+y)%2?'#171c23':'#14181f';
    context.fillRect(left+x*size,top+y*size,size-inset,size-inset);
  }
  const objects=room.objects.filter(object=>object.x>=0&&object.y>=0&&object.x<room.width&&object.y<room.height&&!object.engineHidden&&object.z!==-2147483648)
    .map(object=>({object,role:engineRoleIdForObject(object,blocks)})).sort((a,b)=>a.object.z-b.object.z);
  for(const {object,role} of objects){
    if(role==='player'||role==='goal')continue;
    context.globalAlpha=role==='floor'?.65:.9;context.fillStyle=blocks.get(object.blockId)?.color||'#777f8e';
    context.fillRect(left+object.x*size+inset,top+object.y*size+inset,size-2*inset,size-2*inset);
  }
  context.globalAlpha=1;context.strokeStyle='#0d1015';context.lineWidth=size*.1;
  for(const {object,role} of objects){
    if(role!=='goal')continue;
    const x=left+(object.x+.5)*size,y=top+(object.y+.5)*size,r=size*.3;
    context.fillStyle='#6cd7ff';
    context.beginPath();context.moveTo(x,y-r);context.lineTo(x+r,y);context.lineTo(x,y+r);context.lineTo(x-r,y);context.closePath();context.fill();context.stroke();
  }
  if(start){
    context.fillStyle='#74e6a0';
    context.beginPath();context.arc(left+(start.x+.5)*size,top+(start.y+.5)*size,size*.35,0,Math.PI*2);context.fill();context.stroke();
  }
}

export class StartRoomPicker {
  constructor({document,world,readProject,readProjectKeys,projectKey}) {
    Object.assign(this,{document,world,readProject,readProjectKeys,projectKey});
    this.$=id=>document.getElementById(id);
    this.choices=startingRoomChoices(world);
    this.blocks=new Map(world.blocks.map(block=>[block.id,block]));
    this.buttons=new Map();this.savedKeys=new Set();this.onlySaved=false;this.generation=0;this.selectionGeneration=0;
    this.buildMap();
    this.$('start-search').addEventListener('input',()=>{
      this.filter();
      const exact=this.choices.find(choice=>choice.start&&normalize(choice.label)===normalize(this.$('start-search').value));
      if(exact&&this.visible(exact))this.select(exact);
    });
    this.$('start-search').addEventListener('keydown',event=>{
      if(event.key!=='Enter')return;
      event.preventDefault();
      const first=this.choices.find(choice=>this.visible(choice));
      if(first)this.select(first,{focus:true});
    });
    this.$('start-saved-filter').onclick=()=>{
      this.onlySaved=!this.onlySaved;
      this.$('start-saved-filter').setAttribute('aria-pressed',String(this.onlySaved));
      this.filter();
    };
    for(const [id,find]of [['start-default',()=>this.choices.find(choice=>choice.label==='H×I')],['start-current',()=>this.choices.find(choice=>choice.room.fileName===this.current)]]){
      this.$(id).onclick=()=>{this.resetFilter();const choice=find();if(choice)this.select(choice,{focus:true});};
    }
    this.$('start-map').addEventListener('keydown',event=>this.navigate(event));
    this.$('start-dialog').addEventListener('keydown',event=>event.stopPropagation());
    this.$('close-start').onclick=()=>this.$('start-dialog').close();
    this.$('start-dialog').addEventListener('close',()=>{this.generation++;this.selectionGeneration++;});
  }
  buildMap() {
    const grid=this.$('start-map');
    const columns=Math.max(...this.choices.map(choice=>choice.room.columnIndex))+1;
    grid.style.setProperty('--start-columns',columns);
    grid.style.setProperty('--start-rows',Math.max(...this.choices.map(choice=>choice.room.rowIndex))+1);
    const axis=(text,column,row)=>{
      const element=this.document.createElement('span');element.className='start-axis';element.textContent=text;
      element.style.gridColumn=column;element.style.gridRow=row;element.setAttribute('aria-hidden','true');grid.append(element);
    };
    const seenColumns=new Set(),seenRows=new Set();
    for(const choice of this.choices){
      const {room}=choice;
      if(!seenColumns.has(room.columnIndex)){axis(room.position[0],room.columnIndex+2,1);seenColumns.add(room.columnIndex);}
      if(!seenRows.has(room.rowIndex)){axis(room.position[1],1,room.rowIndex+2);seenRows.add(room.rowIndex);}
      const button=this.document.createElement('button');button.type='button';button.className='start-room-tile';
      button.style.gridColumn=room.columnIndex+2;button.style.gridRow=room.rowIndex+2;
      const preview=this.document.createElement('canvas');preview.className='start-tile-preview';preview.setAttribute('aria-hidden','true');
      // Paint each thumbnail once; filtering and selection reuse the same canvases.
      drawRoomPreview(preview,choice,this.blocks,128);
      const coordinate=this.document.createElement('span');coordinate.className='start-room-coordinate';coordinate.textContent=choice.label;
      button.append(preview,coordinate);
      button.disabled=!choice.start;button.tabIndex=-1;button.onclick=()=>this.select(choice);
      this.buttons.set(room.fileName,button);grid.append(button);
    }
  }
  resetFilter() {
    this.$('start-search').value='';this.onlySaved=false;
    this.$('start-saved-filter').setAttribute('aria-pressed','false');this.filter();
  }
  visible(choice) {
    return Boolean(choice.start)&&matchesRoom(choice.room,this.$('start-search').value)&&(!this.onlySaved||this.savedKeys.has(this.projectKey(choice.room.fileName)));
  }
  filter() {
    const available=this.choices.filter(choice=>this.visible(choice));
    for(const choice of this.choices){
      const id=choice.room.fileName,button=this.buttons.get(id),saved=this.savedKeys.has(this.projectKey(id)),match=this.visible(choice);
      button.disabled=!match;
      button.classList.toggle('is-dimmed',Boolean(choice.start)&&!match);
      button.classList.toggle('is-unavailable',!choice.start);
      button.classList.toggle('is-saved',saved);
      button.classList.toggle('is-current',id===this.current);
      button.classList.toggle('is-selected',id===this.selected?.room.fileName);
      button.setAttribute('aria-pressed',String(id===this.selected?.room.fileName));
      button.title=`Room ${choice.label}${!choice.start?' · No player start':id===this.current?' · Current solution':saved?' · Saved solution':''}`;
      button.setAttribute('aria-label',button.title);
      button.tabIndex=match&&(id===this.selected?.room.fileName||(!available.includes(this.selected)&&choice===available[0]))?0:-1;
    }
    this.$('start-results').textContent=available.length?`${available.length} room${available.length===1?'':'s'} available`:'No matching starting rooms. Try another coordinate or turn off Saved.';
    this.$('confirm-start').disabled=!this.selected||!this.visible(this.selected);
    this.$('start-saved-filter').textContent=`Saved (${this.choices.filter(choice=>choice.start&&this.savedKeys.has(this.projectKey(choice.room.fileName))).length})`;
  }
  async open(current,{initialRoom=current}={}) {
    this.current=current;this.savedKeys.clear();this.resetFilter();
    this.$('start-current').hidden=!current;
    this.$('start-current').textContent=`Current · ${this.choices.find(choice=>choice.room.fileName===current)?.label||''}`;
    this.$('start-dialog').showModal();
    this.select(this.choices.find(choice=>choice.room.fileName===initialRoom)||this.choices.find(choice=>choice.start));
    this.$('start-search').focus();
    const generation=++this.generation;
    try {
      const keys=await this.readProjectKeys();
      if(generation!==this.generation)return;
      this.savedKeys=new Set(keys);this.filter();
    }catch{if(generation===this.generation)this.$('start-results').textContent='Saved-room markers unavailable. You can still choose a room.';}
  }
  async select(choice,{focus=false}={}) {
    if(!choice?.start)return;
    this.selected=choice;this.$('start-room').value=choice.room.fileName;this.filter();
    this.$('start-preview-name').textContent=choice.label;
    this.$('start-preview-badge').textContent=choice.room.fileName===this.current?'Current solution':choice.label==='H×I'?'Game start':'Starting room';
    this.$('start-gem-count').textContent=choice.gems;
    this.$('start-spawn').textContent=`${choice.start.x}, ${choice.start.y}, ${choice.start.z}`;
    this.$('start-save-title').textContent='Checking saved progress…';
    this.$('start-save-detail').textContent='';
    const confirm=this.$('confirm-start');confirm.disabled=false;confirm.textContent=`Open ${choice.label}`;
    this.drawPreview(choice);
    if(focus){const button=this.buttons.get(choice.room.fileName);button.focus();button.scrollIntoView({block:'nearest',inline:'nearest'});}
    const generation=++this.selectionGeneration;
    try {
      const saved=await this.readProject(this.projectKey(choice.room.fileName));
      if(generation!==this.selectionGeneration)return;
      const summary=savedSolutionSummary(saved),current=choice.room.fileName===this.current;
      const hasProgress=summary&&(summary.runs>0||summary.moves>0);
      this.$('start-save-title').textContent=current?'Your current solution':hasProgress?'Saved solution':'Fresh start';
      this.$('start-save-detail').textContent=hasProgress?`${summary.runs.toLocaleString()} saved run${summary.runs===1?'':'s'} · ${summary.moves.toLocaleString()} move${summary.moves===1?'':'s'}`: 'Begin at the room’s original player position.';
      confirm.textContent=current?'Return to solution':hasProgress?`Continue ${choice.label}`:`Start in ${choice.label}`;
    }catch{if(generation===this.selectionGeneration){this.$('start-save-title').textContent='Saved progress unavailable';this.$('start-save-detail').textContent='Open the room to try loading its solution.';}}
  }
  navigate(event) {
    const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!direction||!this.selected)return;
    event.preventDefault();
    const [dx,dy]=direction,{columnIndex:x,rowIndex:y}=this.selected.room;
    const choices=this.choices.filter(choice=>this.visible(choice)&&(dx?choice.room.rowIndex===y&&(choice.room.columnIndex-x)*dx>0:choice.room.columnIndex===x&&(choice.room.rowIndex-y)*dy>0));
    choices.sort((a,b)=>Math.abs(a.room.columnIndex-x)+Math.abs(a.room.rowIndex-y)-Math.abs(b.room.columnIndex-x)-Math.abs(b.room.rowIndex-y));
    if(choices[0])this.select(choices[0],{focus:true});
  }
  drawPreview(choice) {
    const canvas=this.$('start-preview');
    canvas.setAttribute('aria-label',`Top view of room ${choice.label}. ${choice.gems} gems. Player starts at ${choice.start.x}, ${choice.start.y}, ${choice.start.z}.`);
    drawRoomPreview(canvas,choice,this.blocks);
  }
}
