// Test 690 and related actor chains: vacancies depend on successful movement.
export const cloneChainVacancyFixtures = [
  'blocked', 'clear', 'chain-blocked', 'chain-clear', 'push-blocked', 'push-clear',
  'wrapper-blocked', 'wrapper-clear', 'ledge', 'passive', 'player-body-blocked', 'player-body-clear'
].map(kind => {
  const world = {width:8,height:8,floorLayer:0};
  const terrain = Array.from({length:64},(_,i) => ({blockId:'floor',x:i%8,y:Math.floor(i/8),z:0}));
  const wrapper = kind.startsWith('wrapper');
  const z = kind === 'ledge' ? 2 : 1;
  const player = {blockId:'player',x:2,y:3,z};
  const lead = {blockId:'clone',x:2,y:2,z,genericId:kind==='passive'?(1<<30)|17:17};
  const trail = {blockId:'clone',x:2,y:4,z,genericId:wrapper?17:29};
  const group = [player,lead,trail];
  if (kind.startsWith('chain')) group.push({...lead,y:1,genericId:43});
  if (kind.startsWith('push')) group.push({blockId:'crate',x:2,y:1,z:1});
  if (wrapper) group.push(...[1,2,3,4].map(y => ({...lead,x:3,y})));
  if (kind.startsWith('player-body')) group.push({...player,x:1});
  if (kind === 'blocked') terrain.push({blockId:'wall',x:2,y:1,z:1});
  if (['chain-blocked','push-blocked'].includes(kind)) terrain.push({blockId:'wall',x:2,y:0,z:1});
  if (kind === 'wrapper-blocked') terrain.push({blockId:'wall',x:3,y:0,z:1});
  if (kind === 'player-body-blocked') terrain.push({blockId:'wall',x:1,y:2,z:1});
  if (kind === 'ledge') terrain.push(...[2,3,4].map(y => ({blockId:'wall',x:2,y,z:1})));
  const independent = {blockId:'clone',x:6,y:4,z:1,genericId:71};
  const moveGroup = kind.endsWith('clear');
  const expected = group.map(object => ({...object,y:object.y-Number(moveGroup ||
    kind==='player-body-blocked' && object===lead)}));
  return {name:kind,world,start:[...terrain,...group,independent],
    expected:[...terrain,...expected,{...independent,y:3}]};
});
