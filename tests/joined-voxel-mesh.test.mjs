import assert from "node:assert/strict";
import test from "node:test";
import { V2_BLOCK_CATALOG } from "../render/v1/voxel-world-v2.mjs";
import { collectVoxelSceneV2 } from "../render/v1/voxel-scene-v2.mjs";
import { joinedSurfaceFaces, joinedGeometry, joinedEdges, joinedSceneGroups } from "../ui/joined-voxel-mesh.mjs";

const sub = (a,b) => a.map((v,i) => v-b[i]);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a.reduce((s,v,i) => s+v*b[i],0);
function measurements(faces) {
  const geometry = joinedGeometry(faces), p = geometry.attributes.position.array;
  let area = 0, volume = 0;
  for (let i=0;i<p.length;i+=9) {
    const a=[...p.slice(i,i+3)],b=[...p.slice(i+3,i+6)],c=[...p.slice(i+6,i+9)];
    const n=cross(sub(b,a),sub(c,a));
    area+=Math.hypot(...n)/2;volume+=dot(a,n)/6;
  }
  geometry.dispose();
  return {area,volume};
}
const close = (actual,expected) => assert.ok(Math.abs(actual-expected)<1e-5,`${actual} ≠ ${expected}`);
function stair() {
  const shapes=[];
  for(let x=0;x<3;x++) {
    for(let y=0;y<x;y++)shapes.push({position:[x,y,0]});
    shapes.push({position:[x,x,0],direction:"right"});
  }
  return shapes;
}
const rotatePoint = ([x,y,z]) => [3-z,y,x];
const directions = ["right","down","left","up"];

for (let rotation=0;rotation<4;rotation++) test(`stepped ${directions[rotation]} ramps have only the outer prism edges`,()=>{
  const shapes=stair();
  let points=[[0,0,0],[3,0,0],[3,3,0],[0,0,1],[3,0,1],[3,3,1]];
  for(let turn=0;turn<rotation;turn++) {
    for(const shape of shapes) {
      const [x,y,z]=shape.position;shape.position=[2-z,y,x];
      if(shape.direction)shape.direction=directions[(directions.indexOf(shape.direction)+1)%4];
    }
    points=points.map(rotatePoint);
  }
  const faces=joinedSurfaceFaces(shapes),{area,volume}=measurements(faces);
  close(area,15+3*Math.SQRT2);close(volume,4.5);
  const outer=[[0,1],[1,2],[2,0],[3,4],[4,5],[5,3],[0,3],[1,4],[2,5]].map(([a,b])=>[points[a],points[b]]);
  const geometry=joinedEdges(faces),p=geometry.attributes.position.array;
  let length=0;
  for(let i=0;i<p.length;i+=6) {
    const a=[...p.slice(i,i+3)],b=[...p.slice(i+3,i+6)];
    length+=Math.hypot(...sub(b,a));
    assert(outer.some(([start,end])=>[a,b].every(point=>{
      const edge=sub(end,start),delta=sub(point,start),t=dot(delta,edge)/dot(edge,edge);
      return Math.hypot(...cross(delta,edge))<1e-5&&t>=-1e-5&&t<=1+1e-5;
    })),`internal seam ${a} → ${b}`);
  }
  close(length,15+6*Math.SQRT2);geometry.dispose();
});

test("partial cube/wedge contacts retain the exposed triangle with correct winding",()=>{
  for(const [position,area] of [[[0,0,1],8+Math.SQRT2], [[-1,0,0],7+Math.SQRT2], [[1,0,0],9+Math.SQRT2]]) {
    const shapes=[{position:[0,0,0]},{position,direction:"right"}];
    const measurement=measurements(joinedSurfaceFaces(shapes));
    close(measurement.volume,1.5);close(measurement.area,area);
  }
});

function scene(objects,renderDimmed=false) {
  const world={roomWidth:16,roomHeight:16,blockDefinitions:new Map(V2_BLOCK_CATALOG.map(b=>[b.id,b])),
    rooms:[{columnIndex:0,rowIndex:0,renderDimmed,objects}]};
  return collectVoxelSceneV2({world});
}
const families=[
  ["ice-block","ice-slope"],["ice-floor","ice-slope"],
  ["wall","wall-slope"],["orange-wall","orange-slope"],
  ["weightless-box","weightless-slope"],["clone","clone-slope"]
];
test("every cube/slope family shares one mesh, including elevated Ice floors",()=>{
  for(const [blockId,slopeId] of families)for(const dimmed of [false,true]) {
    const data=scene([
      {x:0,y:0,z:1,blockId,groupId:7},
      {x:0,y:0,z:2,blockId:slopeId,groupId:7,orientation:"right"}
    ],dimmed);
    const joined=joinedSceneGroups(data);
    assert.equal(joined.groups.length,1,blockId);
    assert.equal(joined.groups[0].shapes.length,2,blockId);
    assert.equal(joined.cubeGroups.size,0,blockId);
    assert.equal(joined.groups[0].dimmed,dimmed);
  }
});

test("different materials and numbered bodies retain independent mesh boundaries",()=>{
  const objects=[
    {x:0,y:0,z:0,blockId:"weightless-box",groupId:1},
    {x:0,y:0,z:1,blockId:"weightless-slope",groupId:2,orientation:"right"},
    {x:2,y:0,z:0,blockId:"ice-block"},
    {x:2,y:0,z:1,blockId:"wall-slope",orientation:"right"}
  ];
  const joined=joinedSceneGroups(scene(objects));
  assert.equal(joined.groups.length,4);
  assert(joined.groups.every(group=>group.shapes.length===1));
  assert.equal(joined.cubeGroups.size,0);
});

test("support cubes of another material cannot draw an edge across a continuous orange ramp", () => {
  const data = scene([
    { x:0,y:0,z:0,blockId:"orange-slope",orientation:"right" },
    { x:1,y:0,z:1,blockId:"orange-slope",orientation:"right" },
    { x:1,y:0,z:0,blockId:"wall" },
    { x:8,y:0,z:0,blockId:"ice-block" },
  ]);
  const joined = joinedSceneGroups(data);
  assert.equal(joined.groups.length, 2, "the black support must use contact clipping too");
  assert.equal(joined.cubeGroups.size, 1, "distant cubes keep their existing rendering path");
  const support = joined.groups.find(group => group.color === "#23262c");
  const edges = joinedEdges(joinedSurfaceFaces(support.shapes, joined.occupants)).attributes.position.array;
  for (let i = 0; i < edges.length; i += 6) {
    assert(![edges.slice(i,i+3), edges.slice(i+3,i+6)].every(p => p[0] === 1 && p[1] === 1),
      "the black support's buried top edge must not appear across the orange ramp");
  }
});

test("truncating a joined ramp caps its visible lower surface and opens ghost undersides",()=>{
  const shapes=stair(),lower=shapes.filter(shape=>shape.position[1]<1),upper=shapes.filter(shape=>shape.position[1]>=1);
  const visible=joinedSurfaceFaces(lower);
  assert(visible.some(face=>face.corners.every(p=>p[1]===1)),"exposed cubes get cut surfaces");
  const ghost=joinedSurfaceFaces(upper,upper,{minHeight:1});
  assert(!ghost.some(face=>face.corners.every(p=>p[1]===1)),"ghosts do not overlay an opaque cut surface");
  const covered=joinedSurfaceFaces([{position:[0,0,0],direction:"right"}], [{position:[0,0,0],direction:"right"},{position:[0,0,0]}]);
  assert.equal(covered.length,0,"a fully buried wedge has no surface");
});
