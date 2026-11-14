import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';

const MAX_LENGTH=80,MAX_NAMES=2000;

/** What a name typed on the page becomes: one line, no control characters, at most MAX_LENGTH long. */
export const cleanName=name=>String(name??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_LENGTH);

/** Names given to runs on the dashboard, kept in the monitor's own file. Transcripts are never written to. */
export class Names{
 #names=new Map();
 constructor(file=join(homedir(),'.agent-monitor','names.json')){
  this.file=file;
  try{if(existsSync(file))this.#names=new Map(Object.entries(JSON.parse(readFileSync(file,'utf8'))));}catch{}
 }
 get(id){return this.#names.get(id)??'';}
 /** An empty name removes the entry, which brings the automatic name back. */
 set(id,name){
  const clean=cleanName(name);
  this.#names.delete(id);
  if(clean)this.#names.set(id,clean);
  // The oldest entries go first once the file is full.
  while(this.#names.size>MAX_NAMES)this.#names.delete(this.#names.keys().next().value);
  mkdirSync(dirname(this.file),{recursive:true});
  writeFileSync(`${this.file}.tmp`,JSON.stringify(Object.fromEntries(this.#names),null,1));
  renameSync(`${this.file}.tmp`,this.file);
  return clean;
 }
 /** Puts the given names on a snapshot's runs, keeping each automatic name as `auto`. */
 apply(runs){
  for(const run of runs){
   const name=this.#names.get(run.id);
   if(name){run.auto=run.title;run.title=name;}
  }
 }
}
