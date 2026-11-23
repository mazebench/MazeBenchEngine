import assert from "node:assert/strict";
import test from "node:test";
import { joinedSurfaceFaces, joinedTrianglePositions, joinedEdgePositions, slopeContactGroups, mountedNumberFaces } from "../public/mazebench-runtime/joined-voxel-surface.mjs";
const joinedGeometry = faces => ({ attributes: { position: { array: joinedTrianglePositions(faces) } }, dispose() {} });
const joinedEdges = faces => ({ attributes: { position: { array: joinedEdgePositions(faces) } }, dispose() {} });

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

test("fixtures hide just the mounted numbered face, including underside and negative elevations", () => {
  for (const [face, x, y, z] of [["top", 4, 5, 0], ["bottom", 4, 5, -2],
    ["north", 4, 4, -1], ["east", 5, 5, -1], ["south", 4, 6, -1], ["west", 3, 5, -1]]) {
    assert.deepEqual([...mountedNumberFaces([{ x, y, z, face }])], [`4,5,-1:${face}`]);
  }
  assert.equal(mountedNumberFaces([]).size, 0);
});

test("fractional rigid-body motion retains the same connected surface", () => {
  const shapes = stair().map(shape => ({ ...shape,
    position: shape.position.map((value, axis) => value + [0.1, -2.4, 3.7][axis]) }));
  const faces = joinedSurfaceFaces(shapes);
  close(measurements(faces).area, 15 + 3 * Math.SQRT2);
  const edges = joinedEdgePositions(faces);
  let length = 0;
  for (let i = 0; i < edges.length; i += 6) length += Math.hypot(...sub(edges.slice(i, i+3), edges.slice(i+3, i+6)));
  close(length, 15 + 6 * Math.SQRT2);
});

test("cubes under a ramp join are clipped even when their material or body differs", () => {
  for (const offset of [[0,0,0], [0.1,-2.4,3.7]]) {
    const shape = (position, direction) => ({
      position: position.map((v, axis) => v + offset[axis]),
      ...(direction ? { direction } : {}),
    });
    const ramp = { shapes: [shape([0,0,0], "right"), shape([1,1,0], "right")] };
    const support = { shapes: [shape([1,0,0])] };
    const distant = { shapes: [shape([8,0,0])] };
    assert.deepEqual([...slopeContactGroups([ramp, support, distant])], [ramp, support]);
    const occupants = [...ramp.shapes, ...support.shapes, ...distant.shapes];
    const supportFaces = joinedSurfaceFaces(support.shapes, occupants);
    // Its top is beneath the upper wedge; its left face is inside the lower
    // wedge's high face. Neither may leave a black line across the ramp.
    assert(!supportFaces.some(face => face.corners.every(p => Math.abs(p[1] - offset[1] - 1) < 1e-8)));
    assert(!supportFaces.some(face => face.corners.every(p => Math.abs(p[0] - offset[0] - 1) < 1e-8)));
    const edges = joinedEdgePositions(supportFaces);
    for (let i = 0; i < edges.length; i += 6) {
      const [a, b] = [edges.slice(i, i+3), edges.slice(i+3, i+6)];
      assert(![a,b].every(p => Math.abs(p[0] - offset[0] - 1) < 1e-8 &&
        Math.abs(p[1] - offset[1] - 1) < 1e-8), "covered support edge must not cross the slope join");
    }
  }
});
