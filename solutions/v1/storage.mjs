const database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('mazebench-solutions',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('projects');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
export async function readProject(key) {
  const db=await database;
  return new Promise((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
export async function readProjectKeys() {
  const db=await database;
  return new Promise((resolve,reject)=>{const request=db.transaction('projects').objectStore('projects').getAllKeys();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
export async function saveProject(key,value) {
  const db=await database;
  return new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
export async function deleteProject(key) {
  const db=await database;
  return new Promise((resolve,reject)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});
}
