// The owning HTTP supervisor reserves a run before asynchronous resume checks.
// Double clicks/concurrent requests cannot launch two agent processes.
const owners=new WeakMap();
export async function resumeExclusively(supervisor,id){
  let pending=owners.get(supervisor);if(!pending){pending=new Set();owners.set(supervisor,pending);}
  if(pending.has(id))throw new Error('This benchmark is already resuming.');pending.add(id);
  try{return await supervisor.resume(id);}finally{pending.delete(id);}
}
