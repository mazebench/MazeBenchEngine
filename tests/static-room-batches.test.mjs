import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../render/vendor/three.module.min.js";
import { batchStaticRoom } from "../ui/static-room-batches.mjs";
import { RoomLighting } from "../ui/room-lighting.mjs";
import { ModelTruncateCaps } from "../ui/model-truncate-caps.mjs";

test("static room batches preserve world vertices, normals, outline endpoints, and live descendants", () => {
  const root = new THREE.Group(), material = new THREE.MeshBasicMaterial();
  const original = [];
  for (let i=0;i<3;i++) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0,0,1,0,0,1,0,0,1],3));
    geometry.setAttribute("lineOther", new THREE.Float32BufferAttribute([1,0,0,0,0,0,1,0,0],3));
    const mesh = new THREE.Mesh(geometry,material); mesh.position.set(i*3,2,4);mesh.rotation.y=.3*i;root.add(mesh);original.push(mesh);
  }
  const gem=new THREE.Group();gem.userData.gemMotion={};const gemMesh=original[0].clone();gem.add(gemMesh);root.add(gem);
  const marker=original[0].clone();marker.userData.liftMarker=true;root.add(marker);
  root.updateWorldMatrix(true,true);
  const expected=original.map(mesh=>{const geometry=mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);geometry.attributes.lineOther.applyMatrix4(mesh.matrixWorld);return geometry;});
  batchStaticRoom(root);
  const batches=root.children.filter(mesh=>mesh.userData.staticRoomBatch);assert.equal(batches.length,1);
  for(const name of ["position","normal","lineOther"]) assert.deepEqual([...batches[0].geometry.attributes[name].array],expected.flatMap(g=>[...g.attributes[name].array]));
  assert.equal(gemMesh.parent,gem);assert.equal(marker.parent,root);
  assert.equal(batches[0].geometry.attributes.position.count,9);
});

test("batched model sources retain their transforms and colored Truncate caps", () => {
  const root=new THREE.Group(),target=new THREE.Group(),material=new THREE.MeshLambertMaterial({color:0x449933});
  const geometry=new THREE.BoxGeometry(1,2,1);geometry.clearGroups();geometry.userData.persistentGeometry=true;
  const sources=[0,3].map(x=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,1,0);mesh.userData.truncateModel=true;root.add(mesh);return mesh;});
  const caps=new ModelTruncateCaps({},root,target);
  const retired=batchStaticRoom(root,new Set(sources));assert.equal(retired.length,2);
  caps.update(1);
  for(const [i,entry] of caps.entries.entries()) {
    assert.equal(entry.surface.visible,true);assert.equal(entry.surface.material.color.getHex(),0x449933);
    assert.equal(entry.surface.matrix.elements[12],i*3);assert(entry.surface.geometry.drawRange.count>0);
  }
  caps.update(null);assert(caps.entries.every(entry=>!entry.surface.visible));
});

test("unchanged room lighting does not schedule another GPU texture upload", () => {
  const room={rowIndex:0,columnIndex:0},world={columns:[0,1],rows:[0],roomWidth:16,roomHeight:16,contextActiveRoom:room};
  const lighting=new RoomLighting(world),version=lighting.texture.version;
  lighting.setWeights([room],[1]);assert.equal(lighting.texture.version,version);
  lighting.setWeights([room],[.5]);assert.equal(lighting.texture.version,version+1);
  lighting.setWeights([room],[.5]);assert.equal(lighting.texture.version,version+1);
  lighting.dispose();
});
