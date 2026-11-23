import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {decodeVoxelRoom,V2_BLOCK_CATALOG} from '../render/v1/voxel-world-v2.mjs';
import {renderAsciiFrameV1} from '../render-ascii/v1/ascii-scene.mjs';
import {renderAsciiFrameV2} from '../render-ascii/v2/ascii-scene.mjs';

// Removing empty borders from v2 must reproduce v1's exact visible pixels.
function occupiedRectangle(frame){
  let left=frame.width,right=-1,top=frame.height,bottom=-1;
  frame.pixels.forEach((row,y)=>row.forEach((pixel,x)=>{
    if(pixel.name==='empty')return;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }));
  return bottom<top?[]:frame.pixels.slice(top,bottom+1).map(row=>row.slice(left,right+1));
}

test('empty rectangular rooms retain their whole footprint at every yaw and pitch',async()=>{
  const room={width:5,height:3,objects:[]};
  for(let yaw=0;yaw<4;yaw++)for(let pitch=0;pitch<5;pitch++){
    const width=(yaw%2?room.height:room.width)*4;
    const height=pitch===4?1:(yaw%2?room.width:room.height)*(4-pitch);
    for(const hideNames of [false,true]){
      const frame=await renderAsciiFrameV2(room,V2_BLOCK_CATALOG,{yaw,pitch,hideNames});
      assert.equal(frame.width,width,`yaw ${yaw}, pitch ${pitch}`);
      assert.equal(frame.height,height,`yaw ${yaw}, pitch ${pitch}`);
      assert(frame.pixels.every(row=>row.length===width&&row.every(pixel=>pixel.name==='empty')));
    }
  }
});

test('a sparse room keeps empty rows and columns at their projected coordinates',async()=>{
  const room={width:5,height:4,objects:[{x:2,y:1,z:0,blockId:'floor'}]};
  for(let yaw=0;yaw<4;yaw++)for(let pitch=1;pitch<4;pitch++){
    const coordinates=[[2,1],[2,2],[2,2],[1,2]][yaw];
    const frame=await renderAsciiFrameV2(room,V2_BLOCK_CATALOG,{yaw,pitch});
    assert.equal(frame.width,(yaw%2?room.height:room.width)*4);
    const x=coordinates[0]*4,y=coordinates[1]*(4-pitch);
    assert.equal(frame.height,Math.max((yaw%2?room.width:room.height)*(4-pitch),y+4));
    assert.equal(frame.pixels[y][x].glyph,'A');
    assert(frame.pixels.slice(0,y).flat().every(pixel=>pixel.name==='empty'));
    assert(frame.pixels.every(row=>row.slice(0,x).every(pixel=>pixel.name==='empty')));
  }
});

test('G×E keeps its empty area through all camera pitches and rotations',async()=>{
  const root=new URL('../level-data/v2/main-world/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('world.json',root),'utf8'));
  const [fileName]=Object.entries(manifest.rooms).find(([,position])=>position.join('x')==='GxE');
  const room=decodeVoxelRoom(JSON.parse(await readFile(new URL(fileName,root),'utf8')));
  for(let yaw=0;yaw<4;yaw++)for(let pitch=0;pitch<5;pitch++)for(const hideNames of [false,true]){
    const options={yaw,pitch,hideNames};
    const previous=await renderAsciiFrameV1(room,manifest.blocks,options);
    const frame=await renderAsciiFrameV2(room,manifest.blocks,options);
    assert.equal(frame.width,64,`yaw ${yaw}, pitch ${pitch}`);
    assert(frame.height>=Math.max(1,16*(4-pitch)));
    assert.deepEqual(occupiedRectangle(frame),occupiedRectangle(previous));
  }
});

test('room footprint padding never clips tall objects or geometry below ground',async()=>{
  const room={width:5,height:4,objects:[
    {x:0,y:0,z:4,blockId:'wall'},
    {x:2,y:2,z:0,blockId:'floor'},
    {x:2,y:2,z:0,blockId:'player'},
    {x:4,y:3,z:-3,blockId:'crate'}
  ]};
  for(let yaw=0;yaw<4;yaw++)for(let pitch=0;pitch<5;pitch++){
    const options={yaw,pitch};
    const previous=await renderAsciiFrameV1(room,V2_BLOCK_CATALOG,options);
    const frame=await renderAsciiFrameV2(room,V2_BLOCK_CATALOG,options);
    assert.equal(frame.width,(yaw%2?room.height:room.width)*4);
    assert.deepEqual(occupiedRectangle(frame),occupiedRectangle(previous));
  }
});
