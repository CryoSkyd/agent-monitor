import {closeSync,openSync,readSync,statSync} from 'node:fs';

/** Reads only the bytes appended since the last call, so a poll of an unchanged file costs one stat. */
/** One line of a file, given where it starts and how long it is. */
export function readRange(path,[at,length]){
 const fd=openSync(path,'r');
 try{const buffer=Buffer.allocUnsafe(length);readSync(fd,buffer,0,length,at);return buffer.toString();}finally{closeSync(fd);}
}

export class Tail{
 offset=0;
 mtime=0;
 #rest=null;
 #restAt=0;
 #buffer=Buffer.allocUnsafe(1<<20);
 constructor(path){this.path=path;}
 read(onLine){
  let stat;
  try{stat=statSync(this.path);}catch{return false;}
  this.mtime=stat.mtimeMs;
  if(stat.size<this.offset){this.offset=0;this.#rest=null;}
  if(stat.size===this.offset)return false;
  const fd=openSync(this.path,'r');
  try{
   while(this.offset<stat.size){
    const n=readSync(fd,this.#buffer,0,Math.min(this.#buffer.length,stat.size-this.offset),this.offset);
    if(!n)break;
    this.offset+=n;
    const chunk=this.#buffer.subarray(0,n),base=this.offset-n;
    let start=0,end;
    while((end=chunk.indexOf(10,start))!==-1){
     let line=chunk.subarray(start,end),at=base+start;
     if(this.#rest){line=Buffer.concat([...this.#rest,line]);at=this.#restAt;this.#rest=null;}
     if(line.length>1)onLine(line,at);
     start=end+1;
    }
    if(start<n){
     if(!this.#rest){this.#rest=[];this.#restAt=base+start;}
     this.#rest.push(Buffer.from(chunk.subarray(start)));
    }
   }
  }finally{closeSync(fd);}
  return true;
 }
}
