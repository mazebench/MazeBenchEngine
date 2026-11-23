export const wrappingClonePushFixtures = [];
for (const swap of [false, true]) {
  for (const crate of [false, true]) {
    for (const obstacle of ['clear', 'wrapper', 'unrelated', ...(crate ? [] : ['box-branch'])]) {
      const terrain = Array.from({length:36}, (_,i) => ({
        blockId:'floor',x:i%6,y:Math.floor(i/6),z:0
      }));
      const player = {blockId:'player',x:2,y:swap?2:3,z:1};
      const box = {blockId:crate?'crate':'weightless-pushbox-1826',x:2,y:swap?3:2,z:1};
      if (!crate) box.genericId = 0;
      const wrapper = [[2,1],[2,4],[3,1],[3,2],[3,3],[3,4]].map(([x,y]) => ({
        blockId:'clone',x,y,z:1,genericId:17
      }));
      const independent = {blockId:'clone',x:5,y:4,z:1,genericId:71};
      if (obstacle === 'wrapper') terrain.push({blockId:'wall',x:3,y:0,z:1});
      if (obstacle === 'unrelated') terrain.push({blockId:'wall',x:5,y:3,z:1});
      const boxes = [box];
      if (obstacle === 'box-branch') {
        boxes.push({...box,x:1});
        terrain.push({blockId:'wall',x:1,y:box.y-1,z:1});
      }
      const group = [player,...boxes,...wrapper];
      const blocked = ['wrapper','box-branch'].includes(obstacle);
      wrappingClonePushFixtures.push({
        name:`wrapping clone push: player ${swap?'ahead':'behind'}, ${crate?'crate':'weightless box'}, ${obstacle}`,
        world:{width:6,height:6,floorLayer:0},
        start:[...terrain,...group,independent],
        expected:[...terrain,...group.map(object => ({...object,y:object.y-Number(!blocked)})),
          {...independent,y:independent.y-Number(obstacle!=='unrelated')}]
      });
    }
  }
}
{
  const terrain = Array.from({length:36},(_,i) => ({blockId:'floor',x:i%6,y:Math.floor(i/6),z:0}));
  const supports = [[2,0],[2,1],[2,3],[2,4],...[0,1,2,3,4].map(y=>[3,y])];
  terrain.push(...supports.map(([x,y])=>({blockId:'wall',x,y,z:1})));
  const group = [{blockId:'player',x:2,y:3,z:2},
    ...[[2,2,2],[1,2,2],[1,2,1]].map(([x,y,z])=>({blockId:'weightless-pushbox-1826',x,y,z,genericId:0})),
    ...[[2,1],[2,4],[3,1],[3,2],[3,3],[3,4]].map(([x,y])=>({blockId:'clone',x,y,z:2,genericId:17}))];
  const independent = {blockId:'clone',x:5,y:4,z:1,genericId:71};
  wrappingClonePushFixtures.push({name:'a wrapping clone cannot rely on the player walking off a wall',
    world:{width:6,height:6,floorLayer:0},start:[...terrain,...group,independent],
    expected:[...terrain,...group,{...independent,y:3}]});
}
