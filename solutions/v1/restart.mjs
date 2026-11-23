// Finish any save already in flight before deleting the selected solution.
// Once stopped, late worker replies cannot recreate it or change the active room.
export class SolutionRestartController {
  constructor({stop,remove,select,reload}) {
    Object.assign(this,{stop,remove,select,reload});
    this.stopped=false;
    this.restarting=false;
    this.pendingSaves=new Set();
  }
  async save(write) {
    if(this.stopped)return;
    const pending=Promise.resolve().then(write);
    this.pendingSaves.add(pending);
    try{return await pending;}
    finally{this.pendingSaves.delete(pending);}
  }
  async restart(room) {
    if(this.restarting)return;
    this.restarting=true;
    this.stopped=true;
    this.stop();
    try {
      await Promise.allSettled([...this.pendingSaves]);
      await this.remove(room);
      await this.select(room);
      this.reload();
    } catch(error) {
      this.restarting=false;
      throw error;
    }
  }
}
