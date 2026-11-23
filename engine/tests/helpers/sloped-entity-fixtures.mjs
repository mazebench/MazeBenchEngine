// Independently specified scenes. These builders never call the physics engine.
const cube = (blockId, x, y, z, genericId) => ({ blockId, x, y, z, ...(genericId === undefined ? {} : { genericId }) });
const shift = (v, dy = -1, dz = 0) => ({ ...v, y: v.y + dy, z: v.z + dz });
const floor = () => Array.from({ length: 36 }, (_, i) => cube('floor', i % 6, Math.floor(i / 6), 0));
const families = {
  box: { cube: 'weightless-pushbox-1826', slope: 'blue-box-slope', folder: 'box-slopes' },
  clone: { cube: 'clone', slope: 'yellow-clone-slope', folder: 'clone-slopes' },
};
export const rigidSlopeScenarios = ['rigid', 'blocked-slope', 'blocked-crown', 'rider', 'ice', 'mixed-ice', 'independent', 'other-family', 'push-crate', 'two-crates', 'push-floor', 'gem', 'slope-gem', 'remote-ramp'];
export const rampEntityScenarios = ['rider-descends', 'rider-over-ice', 'lift-cargo', 'lift-ceiling', 'low-face', 'low-face-ceiling', 'high-face-blocked', 'cargo-climbs', 'opposing-slopes'];

export function slopedEntityFixture(family, scenario, { orientation = 'right', id = 17 } = {}) {
  if (!families[family] || !rigidSlopeScenarios.includes(scenario)) throw new Error(`Unknown slope fixture: ${family}/${scenario}`);
  const definition = families[family];
  const isClone = family === 'clone';
  const terrain = floor();
  const player = cube('player', isClone ? 0 : 2, 5, 1);
  const body = [cube(definition.cube, 2, 4, 1, id), cube(definition.cube, 2, 4, 2, id),
    { ...cube(definition.slope, 3, 4, 1, id), orientation }];
  const extras = [], other = [];
  const blocked = ['blocked-slope', 'blocked-crown', 'independent', 'other-family', 'two-crates'].includes(scenario);
  if (['blocked-slope', 'independent', 'other-family'].includes(scenario)) terrain.push(cube('wall', 3, 3, 1));
  if (scenario === 'blocked-crown') terrain.push(cube('wall', 2, 3, 2));
  if (scenario === 'remote-ramp') terrain.push({ ...cube('ice-slope', 5, 0, 1), orientation: 'left' });
  if (scenario === 'rider') extras.push(cube('weightless-pushbox-1826', 2, 4, 3, id + 1));
  if (['ice', 'mixed-ice'].includes(scenario)) {
    for (const v of terrain) if (v.y >= 2 && v.y <= 3 && (v.x === 2 || (scenario === 'ice' && v.x === 3))) v.blockId = 'ice-9679';
  }
  if (scenario === 'independent' || scenario === 'other-family') {
    const remote = scenario === 'independent' ? definition : families[isClone ? 'box' : 'clone'];
    other.push({ ...cube(remote.slope, 5, 4, 1, scenario === 'independent' ? id + 1 : id), orientation });
  }
  if (['push-crate', 'two-crates', 'push-floor'].includes(scenario)) extras.push(cube(scenario === 'push-floor' ? 'floating-floor' : 'crate', 2, 3, 1));
  if (scenario === 'two-crates') extras.push(cube('crate', 2, 2, 1));
  const hasGem = scenario === 'gem' || scenario === 'slope-gem';
  if (hasGem) extras.push(cube('goal', scenario === 'slope-gem' ? 3 : 2, 3, 1));
  const start = [...terrain, player, ...body, ...extras, ...other];
  const count = scenario === 'ice' ? 3 : 1;
  const expected = Array.from({length: count}, (_, index) => {
    const distance = blocked ? 0 : index + 1;
    return [...terrain, shift(player, isClone ? -Math.min(index + 1, 1) : -Math.min(distance, 1)),
      ...body.map(v => shift(v, -distance)),
      ...extras.map(v => hasGem || blocked ? v : shift(v, -distance)),
      ...other.map(v => v.blockId === 'yellow-clone-slope' ? shift(v) : v)];
  });
  const descriptions = {
    rigid: 'The cube, raised cube, and slope share one rigid body. All three translate north exactly once without changing their relative positions or slope orientation.',
    'blocked-slope': 'Only the remote slope member touches the wall. That collision blocks the whole body; the player pushing a blue body also stays put.',
    'blocked-crown': 'A ceiling-height wall hits the raised cube. The complete mixed body must stay unchanged; its lower slope cannot move separately.',
    rider: 'A separate blue passenger on the flat crown rides one tile with the complete mixed body, retaining its height.',
    ice: 'Both feet land on Ice. The entire mixed body continues north for three ticks and stops on ordinary floor; the player moves only once.',
    'mixed-ice': 'Only one foot lands on Ice. The ordinary supporting foot stops the whole body after one tile.',
    independent: 'A different object ID stays independent of the blocked body. A yellow slope still receives the command; an unpushed blue slope stays still.',
    'other-family': 'Blue and yellow bodies sharing the same number remain different objects. Blocking one family must not merge or immobilize the other.',
    'push-crate': 'The mixed body pushes one Sokoban crate exactly once, with no split or extra momentum.',
    'two-crates': 'Two crates exceed the push budget and block the whole body, including its remote slope member.',
    'push-floor': 'A supported Floating Floor can be pushed one tile by the mixed body.',
    gem: 'A yellow clone member or blue box enters the gem cell without collecting it. Only the player can collect gems.',
    'slope-gem': 'The slope member itself enters the gem cell. Both yellow and blue slopes leave the gem in place.',
    'remote-ramp': 'An isolated Ice slope must not add momentum to an ordinary mixed-body push.',
  };
  return { family, scenario, folder: definition.folder, section: ['ice','mixed-ice','rider'].includes(scenario) ? 'support' : ['push-crate','two-crates','push-floor','gem','slope-gem'].includes(scenario) ? 'interactions' : 'rigid',
    name: `${isClone ? 'Clone' : 'Box'} slope · ${scenario.replaceAll('-', ' ')}`, description: descriptions[scenario], world: {width:6,height:6,floorLayer:0}, start, expected };
}

export function rampEntityFixture(family, scenario, { id = 17 } = {}) {
  const definition = families[family], isClone = family === 'clone';
  const terrain = floor();
  let player = cube('player', isClone ? 0 : 2, 5, 1), body, cargo = [], expected;
  const slope = (x,y,z,orientation) => ({...cube(definition.slope,x,y,z,id),orientation});
  const passenger = (x,y,z) => cube('weightless-pushbox-1826',x,y,z,id+1);
  if (scenario.startsWith('rider-')) {
    if (!isClone) player = cube('player',3,5,1);
    body = [slope(3,4,1,'right')]; cargo = [passenger(3,4,2)];
    if (scenario === 'rider-over-ice') for (const v of terrain) if (v.y === 3 && [1,2].includes(v.x)) v.blockId='ice-9679';
    const moved = [shift(player), shift(body[0])];
    expected = [[...terrain,...moved,passenger(3,3,2)],...Array.from({length:scenario==='rider-over-ice'?3:1},(_,i)=>[...terrain,...moved,passenger(2-i,3,1)])];
  } else if (scenario === 'lift-cargo' || scenario === 'lift-ceiling') {
    body = [slope(2,4,1,'down')]; cargo = [passenger(2,3,1)]; terrain.push(cube('wall',2,2,1));
    if (scenario === 'lift-ceiling') terrain.push(cube('wall',2,3,2));
    expected = [[...terrain,scenario==='lift-ceiling'&&!isClone?player:shift(player),
      scenario==='lift-ceiling'?body[0]:shift(body[0]),scenario==='lift-ceiling'?cargo[0]:{...cargo[0],z:2}]];
  } else if (scenario === 'low-face' || scenario === 'low-face-ceiling' || scenario === 'cargo-climbs') {
    const withCargo = scenario === 'cargo-climbs', y = withCargo ? 3 : 4;
    player = cube('player',2,5,1);
    body = [slope(2,y,1,'up'),cube(definition.cube,2,y-1,1,id)]; terrain.push(cube('wall',2,y-2,1));
    if (withCargo) cargo=[passenger(2,4,1)];
    if (scenario==='low-face-ceiling') {terrain.push(cube('wall',2,4,2));expected=[[...terrain,player,...body]];}
    else expected = [0,1].map(i=>[...terrain,...body,withCargo?shift(player):{...player,y:y-i,z:2},...(withCargo?[passenger(2,y-i,2)]:[])]);
  } else if (scenario === 'high-face-blocked') {
    body = [slope(2,4,1,'down')]; terrain.push(cube('wall',2,3,1));
    expected=[[...terrain,isClone?shift(player):player,...body]];
  } else if (scenario === 'opposing-slopes') {
    player=cube('player',2,5,1);body=[slope(2,4,1,'up'),slope(2,3,1,'down')];
    expected=isClone?[[...terrain,shift(player),...body.map(v=>shift(v))]]:
      [4,3,2].map((y,i)=>[...terrain,{...player,y,z:i===2?1:2},...body]);
  } else throw new Error(`Unknown ramp scenario: ${scenario}`);
  return {family,scenario,folder:definition.folder,section:'ramp-contacts',name:`${isClone?'Clone':'Box'} slope · ${scenario.replaceAll('-',' ')}`,
    description: ({'rider-descends':'A passenger first rides the moving ramp north, then descends its west-facing low edge onto ordinary floor.',
      'rider-over-ice':'After riding north and descending west, the passenger crosses two Ice cells and stops on ordinary floor. The ramp moves only once.',
      'lift-cargo':'A downhill-facing moving ramp wedges under cargo blocked by a wall and raises it one level.',
      'lift-ceiling':'A ceiling prevents the ramp from lifting cargo. The entire push remains blocked.',
      'low-face':'A wall pins the ramp body. The player climbs its low face and continues onto the flat crown in two ticks.',
      'low-face-ceiling':'A ceiling blocks ascent and the front wall blocks the body. Neither player nor body can move.',
      'cargo-climbs':'A pushed blue body climbs a pinned ramp and reaches its flat crown. The player advances only one tile.',
      'high-face-blocked':'A wall beyond the ramp blocks the command against its high face.',
      'opposing-slopes':'Two same-ID opposing slopes act as one object. A blue body stays still while the player traverses its ridge; a yellow body receives the command and vacates ahead of the player.'})[scenario],
    world:{width:6,height:6,floorLayer:0},start:[...terrain,player,...body,...cargo],expected};
}
