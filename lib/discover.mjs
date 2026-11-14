import {existsSync,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,join} from 'node:path';

const fresh=(path,cutoff)=>{try{return statSync(path).mtimeMs>=cutoff;}catch{return false;}};
const list=dir=>{try{return readdirSync(dir,{withFileTypes:true});}catch{return[];}};

/** Claude Code names a project's transcript folder after its path, with every non-alphanumeric as a dash. */
export const claudeSlug=path=>path.replace(/[^a-zA-Z0-9]/g,'-');

export function* claudeTranscripts(projectPath,cutoff,home=homedir()){
 const root=join(home,'.claude','projects'),slug=claudeSlug(projectPath).toLowerCase();
 for(const dir of list(root)){
  const name=dir.name.toLowerCase();
  if(!dir.isDirectory()||(name!==slug&&!name.startsWith(`${slug}-`)))continue;
  for(const file of list(join(root,dir.name))){
   if(!file.isFile()||!file.name.endsWith('.jsonl'))continue;
   const path=join(root,dir.name,file.name);
   if(!fresh(path,cutoff))continue;
   const id=basename(file.name,'.jsonl');
   yield {path,id};
   const subagents=join(root,dir.name,id,'subagents');
   for(const sub of list(subagents)){
    if(!sub.name.endsWith('.jsonl'))continue;
    const subPath=join(subagents,sub.name);
    if(fresh(subPath,cutoff))yield {path:subPath,id:basename(sub.name,'.jsonl'),parent:id,metaPath:subPath.replace(/\.jsonl$/,'.meta.json')};
   }
  }
 }
}

export function codexHomes(home=homedir()){
 return list(home)
  .filter(dir=>dir.isDirectory()&&/^\.codex/.test(dir.name)&&existsSync(join(home,dir.name,'sessions')))
  .map(dir=>({account:dir.name.slice(1),sessions:join(home,dir.name,'sessions')}));
}

export function* codexTranscripts(cutoff,home=homedir()){
 for(const {account,sessions} of codexHomes(home)){
  const walk=function*(dir,depth){
   for(const entry of list(dir)){
    const path=join(dir,entry.name);
    if(entry.isDirectory()){if(depth<3)yield* walk(path,depth+1);}
    else if(entry.name.endsWith('.jsonl')&&fresh(path,cutoff))yield {path,account};
   }
  };
  yield* walk(sessions,0);
 }
}
