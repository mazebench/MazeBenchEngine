export const supportedCloneComponentFixtures = [];
for (const playerCarrier of [false,true]) for (const stack of [1,2]) {
  for (const blocked of playerCarrier?[false]:[false,true]) {
    const terrain = Array.from({length:36},(_,i)=>({blockId:'floor',x:i%6,y:Math.floor(i/6),z:0}));
    if (blocked) terrain.push({blockId:'wall',x:1,y:2,z:1});
    const base = [[2,1],[3,1],[4,1],[4,2],[4,3]].map(([x,z])=>({
      blockId:playerCarrier?'player':'clone',x,y:2,z,...(playerCarrier?{}:{genericId:1})
    }));
    const riders = Array.from({length:stack},(_,i)=>[2,3].map(x=>({
      blockId:'clone',x,y:2,z:2+i,genericId:2+i
    }))).flat();
    const free = [{blockId:'clone',x:4,y:5,z:1,genericId:17},
      ...(playerCarrier?[]:[{blockId:'player',x:1,y:4,z:1}])];
    supportedCloneComponentFixtures.push({name:`${playerCarrier?'player':'clone'} carrier, ${stack} riders, blocked=${blocked}`,
      world:{width:6,height:6,floorLayer:0},start:[...terrain,...base,...riders,...free],
      expected:[...terrain,...base.map(o=>({...o,x:o.x-Number(!blocked)})),
        ...[...riders,...free].map(o=>({...o,x:o.x-1}))]});
  }
}
