import {readdirSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';

/** Reads the YAML-like front matter of a task card: `key: value` lines and `[a, b]` lists. */
export function parseCard(text){
 const block=/^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
 if(block==null)return null;
 const fields={};
 for(const line of block.split(/\r?\n/)){
  const match=/^([A-Za-z_]+):\s*(.*?)\s*(#.*)?$/.exec(line);
  if(!match)continue;
  const list=/^\[(.*)\]$/.exec(match[2]);
  fields[match[1]]=list?list[1].split(',').map(item=>item.trim()).filter(Boolean):match[2].replace(/^(["'])(.*)\1$/,'$2');
 }
 return fields.id?fields:null;
}

/** Keeps every card under a folder in memory and re-reads only files whose size or mtime changed. */
export class CardStore{
 #files=new Map();
 constructor(root){this.root=root;}
 refresh(){
  let entries,changed=false;
  try{entries=readdirSync(this.root,{recursive:true,withFileTypes:true});}catch{return false;}
  const seen=new Set();
  for(const entry of entries){
   if(!entry.isFile()||!entry.name.endsWith('.md')||/template|readme/i.test(entry.name))continue;
   const path=join(entry.parentPath,entry.name);
   seen.add(path);
   let stat;
   try{stat=statSync(path);}catch{continue;}
   const known=this.#files.get(path);
   if(known&&known.mtime===stat.mtimeMs&&known.size===stat.size)continue;
   let card=null;
   try{card=parseCard(readFileSync(path,'utf8').slice(0,4000));}catch{}
   this.#files.set(path,{mtime:stat.mtimeMs,size:stat.size,card});
   changed=true;
  }
  for(const path of this.#files.keys())if(!seen.has(path)){this.#files.delete(path);changed=true;}
  return changed;
 }
 pathOf(id){
  for(const [path,{card}] of this.#files)if(card?.id===id)return path;
  return null;
 }
 cards(){
  const byId=new Map();
  for(const {card} of this.#files.values())if(card)byId.set(card.id,card);
  return byId;
 }
}
