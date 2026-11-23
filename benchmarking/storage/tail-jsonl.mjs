import {closeSync,fstatSync,readSync} from 'node:fs';
import path from 'node:path';
import {safeOpenFile} from '../v1/safe-files.mjs';

// Read backwards from the end, never from byte zero of a multi-GB agent log.
export async function readJsonLinesTail(file,maximum=500,{maximumBytes=8*1024*1024}={}){
  let fd;try{fd=safeOpenFile(path.dirname(file),path.basename(file));}catch(e){if(e.code==='ENOENT')return[];throw e;}
  try{
    let cursor=fstatSync(fd).size,newlines=0,total=0;const chunks=[];
    while(cursor>0&&newlines<=maximum&&total<maximumBytes){const size=Math.min(cursor,256*1024,maximumBytes-total),chunk=Buffer.alloc(size);cursor-=size;const n=readSync(fd,chunk,0,size,cursor);if(n!==size)throw new Error('Event log changed while reading its tail.');chunks.unshift(chunk);total+=size;for(const b of chunk)if(b===10)newlines++;}
    const lines=Buffer.concat(chunks).toString('utf8').split(/\r?\n/);if(cursor>0)lines.shift();
    return lines.filter(Boolean).flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}}).slice(-maximum);
  }finally{closeSync(fd);}
}
