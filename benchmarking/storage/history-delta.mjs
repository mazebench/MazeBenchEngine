const fields=['actions','positions','novelty'];
export function historyResponse(run,cursorValue){
  let cursor;try{cursor=typeof cursorValue==='string'&&cursorValue.length<1024?JSON.parse(cursorValue):cursorValue;}catch{}
  const epoch=run.history_epoch||run.integrity?.manifest_sha256||run.created_at||run.id;
  const valid=cursor?.epoch===epoch&&fields.every(k=>Number.isSafeInteger(cursor[k])&&cursor[k]>=0&&cursor[k]<=(run[k]?.length||0));
  const next={epoch,...Object.fromEntries(fields.map(k=>[k,run[k]?.length||0]))};
  return{...run,...Object.fromEntries(fields.map(k=>[k,valid?(run[k]||[]).slice(cursor[k]):run[k]||[]])),
    history_cursor:next,history_delta:valid?{from:cursor}:null};
}
export function mergeRunUpdate(previous,update){
  if(!update.history_delta)return update;
  const from=update.history_delta.from;
  if(!previous||previous.id!==update.id||previous.history_cursor?.epoch!==from.epoch||fields.some(k=>previous[k]?.length!==from[k]))throw new Error('History update does not match the displayed run. Refresh the full record.');
  const result={...update};for(const k of fields){result[k]=previous[k];for(const value of update[k]||[])result[k].push(value);}return result;
}
