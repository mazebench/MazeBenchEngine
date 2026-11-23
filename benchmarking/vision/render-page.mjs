import { ThreeMazeRendererV1 } from '../../render/v1/three-renderer.mjs';
import { loadAssetModels, assetReady } from '../../render/v1/asset-renderers.mjs';
import { V2_WORLD_FORMAT } from '../../render/v1/voxel-world-v2.mjs';
import * as THREE from '../../render/vendor/three.module.min.js';
let renderer;
window.renderVisionFrame = async ({ room, blocks, camera }) => {
  // The trusted caller provides one already-projected room. This page never
  // loads a world manifest, neighboring rooms, or hidden engine state.
  const definitions = blocks.map(block => ({ ...block, visual: { ...block.visual,
    ...(block.visual?.modelUrl ? { modelUrl: new URL(block.visual.modelUrl, new URL('/level-data/v2/main-world/world.json',location.origin)).href } : {}) } }));
  const present = new Set(room.objects.map(o=>o.blockId));
  const models = definitions.filter(b=>present.has(b.id)&&b.visual?.modelUrl).map(b=>b.visual.modelUrl);
  await loadAssetModels(models);
  if(models.some(url=>!assetReady(url)))throw new Error('A required 3D model could not be loaded.');
  const world = { storageFormat: V2_WORLD_FORMAT, columns:['A'],rows:['A'],roomWidth:room.width,roomHeight:room.height,
    rooms:[{...room,columnIndex:0,rowIndex:0,position:['A','A']}],blocks:definitions,blockDefinitions:new Map(definitions.map(b=>[b.id,b])) };
  if(!renderer)renderer=new ThreeMazeRendererV1(document.getElementById('board'),world,{mode:'play'});
  else renderer.setWorld(world);
  renderer.fuzzyOverlay.setEnabled?.(false);
  renderer.heading=camera.yaw;renderer.yaw=camera.yaw*Math.PI/2;
  renderer.pitch=[Math.PI/2-0.001,3*Math.PI/8,Math.PI/4,Math.PI/8,0][camera.pitch];
  const top=Math.max(1,...room.objects.map(o=>o.z+1));
  renderer.target.y=top/3;
  renderer.distance=Math.max(renderer.fitDistance(),(Math.max(room.width,room.height)+top)*1.65);
  renderer.resize();
  const bounds=new THREE.Box3().setFromObject(renderer.content);
  const corners=[];for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])corners.push(new THREE.Vector3(x,y,z));
  for(let attempt=0;attempt<30;attempt++){
    renderer.updateCamera();renderer.camera.updateMatrixWorld();
    if(corners.every(c=>{const p=c.clone().project(renderer.camera);return Math.abs(p.x)<=0.90&&Math.abs(p.y)<=0.90&&p.z<1;}))break;
    renderer.distance*=1.08;
  }
  renderer.render();
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  renderer.render();
  return {rooms:world.rooms.length,width:1024,height:1024};
};
