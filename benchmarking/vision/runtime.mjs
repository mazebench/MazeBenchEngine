import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BenchmarkGameRuntime } from '../v1/runtime.mjs';
import { signCheckpoint } from '../v1/integrity.mjs';
import { writeCheckpointJson } from '../v1/checkpoint-json.mjs';
import { safeDirectory, safeReadFile } from '../v1/safe-files.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const label=room=>room.position.join('x');
export function visionAction(a){
  return Object.fromEntries(['index','action','at','roomBefore','roomAfter','stateChanged','moved','blocked','died','gemsCollected','totalGems','roomsVisited','animation'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));
}
export class VisionRuntime extends BenchmarkGameRuntime {
  static async create(root,directory,options={}){
    const base=await BenchmarkGameRuntime.create(root,directory,{...options,incremental:false});
    Object.setPrototypeOf(base,this.prototype);base.internal.pitch=2;
    await base.persist({writeSnapshot:true});
    for(const file of ['records/current_board.txt','records/move_history/move_0.txt'])await rm(path.join(directory,file),{force:true});
    if(options.incremental)await base.enableIncremental();
    return base;
  }
  static async open(root,directory){const base=await BenchmarkGameRuntime.open(root,directory);Object.setPrototypeOf(base,this.prototype);return base;}
  frameSet(move){return move===0?this.internal.visionInitial:this.internal.actions[move-1];}
  recordIndex(){return ['current_board.png','current_state.json','moves.txt','history.jsonl','move_history/index.json',...Array.from({length:Math.min(100,this.internal.actionCount+1)},(_,i)=>`move_history/move_${Math.max(0,this.internal.actionCount-99)+i}/index.json`)];}
  async renderObservation(){
    if(this.persistenceError)throw this.persistenceError;
    const count=this.internal.actionCount,frames=this.frameSet(count)?.visionFrames;
    return {schema_version:1,observation_mode:'vision',observation_revision:count,
      ...(this.internal.actions.at(-1)?.roomUpdated?{operator_notice:'The operator updated this room. Inspect the current board before continuing.'}:{}),action_count:count,action_limit:this.internal.actionLimit,
      game_status:this.status(),room:label(this.room),gems_collected:this.internal.gemsCollected.length,gems_total:100,
      rooms_visited:this.internal.visitedRooms.length,visited_rooms:this.internal.visitedRooms.map(f=>label(this.assets.roomsByFile.get(f))).sort(),
      camera:{yaw:this.internal.yaw,pitch:this.internal.pitch},image_record:frames?.at(-1)?.record||'current_board.png',
      recent_actions:this.internal.actions.slice(-12).map(visionAction),records:{read_with:'maze_observe({record: <path>})',files:this.recordIndex()}};
  }
  async apply(action){const result=await super.apply(action);return{action:visionAction(result.action),observation:result.observation};}
  async applySequence(actions){const result=await super.applySequence(actions);for(const step of result.steps){step.action=visionAction(step.action);delete step.status.novel_state;}return result;}
  async persist({animationFrames=null,animationCycle=null}={}){
    if(this.persistenceError)throw this.persistenceError;
    let stage;
    try{
      stage=await mkdtemp(path.join(this.runDirectory,'.vision-save-'));
      const artifacts=[];
      const write=async(relative,bytes)=>{const file=path.join(stage,relative);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(file,bytes,{flag:'wx',mode:0o600});artifacts.push(relative);};
      const json=async(relative,value)=>{const file=path.join(stage,relative);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeCheckpointJson(file,value);artifacts.push(relative);};
      const count=this.internal.actionCount;
      const frames=animationFrames||[{room:this.room,state:this.internal.state,camera:{yaw:this.internal.yaw,pitch:this.internal.pitch}}];
      const target=count?this.internal.actions.at(-1):(this.internal.visionInitial={});
      target.visionFrames=[];
      const publicFrames=[];
      for(const [index,frame]of frames.entries()){
        const stem=`move_${count}/frame_${String(index).padStart(4,'0')}`;
        const record=`move_history/${stem}.png`;
        const projected=this.assets.engine.roomFromState(frame.state,frame.room);
        const source={room:{width:projected.width,height:projected.height,objects:projected.objects},blocks:this.assets.blocks,
          camera:frame.camera||{yaw:this.internal.yaw,pitch:this.internal.pitch}};
        const bytes=JSON.stringify(source);
        await write(`vision-source/${stem}.json`,bytes);
        target.visionFrames.push({record,source_sha256:digest(bytes)});
        publicFrames.push({index,record,room:label(frame.room),camera:source.camera,kind:index===0?'before':index===frames.length-1?'final':'animation'});
      }
      const indexRecord=`move_history/move_${count}/index.json`;
      const indexText=JSON.stringify({schema_version:1,action_index:count,action:count?target.action:'initial',frame_count:frames.length,final_frame:frames.length-1,cycle:animationCycle,frames:publicFrames},null,2)+'\n';
      target.animation={frame_count:frames.length,index_record:indexRecord,index_sha256:digest(indexText)};
      await write('records/'+indexRecord,indexText);
      const observation=await this.renderObservation();
      if(this.journal){
        const display={observation_revision:count,room:observation.room,observation_mode:'vision',image_record:observation.image_record};
        await json(`display-history/move_${count}.json`,display);
        await this.journal.commit(this.internal,this.summary({compact:true}),display,{staging:stage,artifacts,observation:{...observation,records:undefined}});
        return;
      }
      await json('game-state.json',this.internal);await json('summary.json',this.summary());
      await json('display.json',{observation_revision:count,room:observation.room,observation_mode:'vision',image_record:observation.image_record});
      await json(`display-history/move_${count}.json`,{observation_revision:count,room:observation.room,observation_mode:'vision',image_record:observation.image_record});
      await json('records/current_state.json',observation);
      await write('records/moves.txt',this.internal.actions.map(a=>a.action).join('\n'));
      await write('records/history.jsonl',this.internal.actions.map(a=>JSON.stringify(visionAction(a))).join('\n'));
      const signed=await signCheckpoint(this.runDirectory,{artifactsDirectory:stage});
      for(const file of artifacts){if(path.dirname(file)!=='.')safeDirectory(this.runDirectory,path.dirname(file),{create:true});await rename(path.join(stage,file),path.join(this.runDirectory,file));}
      if(signed)await rename(path.join(stage,'checkpoint.json'),path.join(this.runDirectory,'checkpoint.json'));
    }catch(error){this.persistenceError=new Error('Vision checkpoint save failed; reopen the last verified checkpoint.',{cause:error});throw this.persistenceError;}
    finally{if(stage)await rm(stage,{recursive:true,force:true});}
  }
  async readRecord(requested){
    const record=String(requested||'').trim();
    if(record==='move_history/index.json')return{record,content:JSON.stringify({action_count:this.internal.actionCount,page_size:100,page_count:Math.ceil((this.internal.actionCount+1)/100),first_page:'move_history/page_0.json'})};
    const page=/^move_history\/page_(0|[1-9]\d*)\.json$/.exec(record);
    if(page){const n=Number(page[1]);if(!Number.isSafeInteger(n)||n*100>this.internal.actionCount)throw new Error('Unknown history page.');return{record,content:JSON.stringify({page:n,next_page:(n+1)*100<=this.internal.actionCount?`move_history/page_${n+1}.json`:null,files:Array.from({length:Math.min(100,this.internal.actionCount-n*100+1)},(_,i)=>`move_history/move_${n*100+i}/index.json`)})};}
    if(record==='current_state.json')return{record,content:JSON.stringify(await this.renderObservation())};
    if(record==='moves.txt')return{record,content:this.internal.actions.map(a=>a.action).join('\n')};
    if(record==='history.jsonl')return{record,content:this.internal.actions.map(a=>JSON.stringify(visionAction(a))).join('\n')};
    if(record==='current_board.png')return this.readRecord((await this.renderObservation()).image_record);
    const match=/^move_history\/move_(0|[1-9]\d*)\/(index\.json|frame_(\d{4,})\.png)$/.exec(record);
    if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])>this.internal.actionCount)throw new Error('Unknown vision record. Choose a path from the image records index.');
    const move=Number(match[1]),set=this.frameSet(move);
    if(!set?.visionFrames||(!move?false:set.index!==move))throw new Error('Image is outside the saved action history.');
    const index=safeReadFile(this.recordsDirectory,set.animation.index_record);
    if(digest(index)!==set.animation.index_sha256)throw new Error('Vision animation index failed integrity verification.');
    if(match[2]==='index.json')return{record,content:index};
    const frame=set.visionFrames.find(f=>f.record===record);
    if(!frame)throw new Error('Unknown frame in this move.');
    const source=safeReadFile(this.runDirectory,`vision-source/move_${move}/frame_${match[3]}.json`);
    if(digest(source)!==frame.source_sha256)throw new Error('Vision frame failed integrity verification.');
    return{record,frame:JSON.parse(source)};
  }
}
