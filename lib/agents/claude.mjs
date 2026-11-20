import {homedir} from 'node:os';
import {basename,join} from 'node:path';
import {fresh,list} from '../discover.mjs';
import {existsSync,readFileSync} from 'node:fs';
import {short} from '../classify.mjs';
import {Run} from '../run.mjs';

// Claude Code context windows, from https://support.claude.com/en/articles/8606394: 1M on these models, and on older ones only when the 1M variant is picked.
const CLAUDE_WINDOW=200_000,CLAUDE_LONG_WINDOW=1_000_000,CLAUDE_LONG_MODELS=/fable|mythos|opus-(5|4-[78])|sonnet-5|haiku-5/;
export const claudeWindow=(model,used)=>CLAUDE_LONG_MODELS.test(model)||used>CLAUDE_WINDOW?CLAUDE_LONG_WINDOW:CLAUDE_WINDOW;
const SHELLS=['Bash','PowerShell'],BACKGROUND_ID=/running in background with ID: ([A-Za-z0-9]+)/,TASK_ID=/<task-id>([A-Za-z0-9]+)<[/]task-id>/g;
const CLAUDE_SKIP=['{"type":"api-request','{"type":"file-history','{"type":"queue-operation','{"type":"bridge-session'];
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';

export class ClaudeRun extends Run{
 tool='claude';
 /** A session belongs to its user, not to one task card. */
 get standalone(){return this.kind==='session';}
 // Claude is told when a background command ends, so it does not poll: it ends its turn and is woken later.
 #starting=new Map();
 #background=new Map();
 #stopWaiting(ts){
  for(const [key,since] of this.waitOpen){this.waited.ms+=ts-since;this.callEnded(ts,key);}
  this.waitOpen.clear();
 }
 #notices(ts,text){if(text.includes('<task-notification>'))for(const match of text.matchAll(TASK_ID))this.#backgroundEnded(ts,match[1]);}
 #backgroundEnded(ts,id){if(this.#background.delete(id)&&this.waitOpen.has(`bg:${id}`))this.#stopWaiting(ts);}
 /** A turn that ends while a build or test the agent started is still running is a wait for it, not idleness. */
 idle(ts){
  super.idle(ts);
  this.waitOpen.clear();
  const [id,info]=[...this.#background].find(([,started])=>started.cat==='testing')??[];
  if(!id)return;
  this.waited.n++;
  this.waitOpen.set(`bg:${id}`,ts);
  this.callStarted(ts,`bg:${id}`,{cat:info.cat,name:`wait: ${info.name}`,label:`waiting for: ${info.label}`});
 }
 account='claude';
 #usageId='';
 #usage={in:0,cached:0,out:0};
 constructor(path,shared,{id,parent,metaPath}={}){
  super(path,shared);
  Object.assign(this,{id,parent:parent??null,metaPath,kind:parent?'subagent':'session',role:parent?'agent':'session'});
 }
 poll(){
  const changed=super.poll();
  if(this.metaPath&&!this.ended&&(changed||!this.meta))this.readMeta();
  return changed;
 }
 readMeta(){
  if(!existsSync(this.metaPath))return;
  try{this.meta=JSON.parse(readFileSync(this.metaPath,'utf8'));}catch{return;}
  this.title=this.meta.description??this.title;
  this.role=this.meta.agentType??this.role;
  if(!this.model)this.model=this.meta.pickedEffortModel??this.meta.model??'';
  if(this.meta.finished&&this.last){this.ended=this.last;this.tl.end(this.last);}
 }
 line(buffer){
  const head=buffer.subarray(0,24).toString();
  if(CLAUDE_SKIP.some(prefix=>head.startsWith(prefix)))return;
  let entry;
  try{entry=JSON.parse(buffer.toString());}catch{return;}
  if(entry.type==='custom-title'){this.title=entry.customTitle;return;}
  if(entry.type==='agent-name'&&!this.title){this.title=entry.agentName;return;}
  const ts=Date.parse(entry.timestamp);
  if(!ts||(this.kind==='session'&&entry.isSidechain))return;
  if(entry.type==='system'){if(entry.subtype==='compact_boundary')this.compacted(ts);return;}
  if(entry.type==='assistant')this.assistant(ts,entry);
  else if(entry.type==='user')this.user(ts,entry);
  // A notice that arrives while the agent is mid-turn is queued, and recorded this way instead of as a user message.
  else if(entry.type==='attachment'&&entry.attachment?.type==='queued_command')this.#notices(ts,String(entry.attachment.prompt??''));
 }
 inputOf(entry,id){return entry.message?.content?.find?.(part=>part.type==='tool_use'&&part.id===id)?.input;}
 outputOf(entry,id){return entry.message?.content?.find?.(part=>part.type==='tool_result'&&part.tool_use_id===id)?.content;}
 assistant(ts,entry){
  const message=entry.message??{};
  if(message.model==='<synthetic>')return;
  this.touch(ts);
  if(message.model)this.model=message.model;
  if(entry.effort)this.effort=entry.effort;
  if(message.usage)this.usage(ts,message.id,message.usage);
  for(const part of message.content??[]){
   if(part.type==='tool_use'){
    const info=this.shared.classify.claudeTool(part.name,part.input);
    if(part.input?.run_in_background&&SHELLS.includes(part.name))this.#starting.set(part.id,info);
    if(part.name==='TaskStop')this.#backgroundEnded(ts,part.input?.task_id);
    this.callStarted(ts,part.id,info,`${part.name} ${JSON.stringify(part.input)}`);
   }
   else if(part.type==='text'){
    if(part.text?.trim()){this.message=short(part.text,200);this.said(ts,part.text);}
    if(message.stop_reason&&message.stop_reason!=='tool_use')this.idle(ts);else this.thinking(ts);
   }else this.thinking(ts);
  }
 }
 usage(ts,id,usage){
  const now={in:(usage.input_tokens??0)+(usage.cache_creation_input_tokens??0),cached:usage.cache_read_input_tokens??0,out:usage.output_tokens??0};
  const writes=usage.cache_creation??{};
  now.write1h=writes.ephemeral_1h_input_tokens??0;
  now.write5m=usage.cache_creation_input_tokens!=null?Math.max(0,usage.cache_creation_input_tokens-now.write1h):0;
  now.fresh=usage.input_tokens??0;
  const same=id===this.#usageId,before=same?this.#usage:{in:0,cached:0,out:0,fresh:0,write5m:0,write1h:0};
  if(!same)this.requests++;
  for(const key of ['in','cached','out'])this.tokens[key]+=now[key]-before[key];
  this.spend(this.model,Object.fromEntries(['fresh','cached','out','write5m','write1h'].map(key=>[key,now[key]-before[key]])));
  this.burn(ts,now.in+now.out-before.in-before.out);
  this.#usageId=id;this.#usage=now;
  this.context=now.in+now.cached;
  this.contextMax=Math.max(this.contextMax,claudeWindow(this.model,this.context));
 }
 user(ts,entry){
  this.touch(ts);
  const content=entry.message?.content;
  if(Array.isArray(content)){
   for(const part of content)if(part.type==='tool_result'){
    const info=this.#starting.get(part.tool_use_id);
    if(info){
     this.#starting.delete(part.tool_use_id);
     const id=BACKGROUND_ID.exec(JSON.stringify(part.content??''))?.[1];
     if(id)this.#background.set(id,info);
    }
    this.callEnded(ts,part.tool_use_id,part.is_error===true);
   }
   if(content.every(part=>part.type==='tool_result'))return;
  }
  const text=textOf(content);
  this.#notices(ts,text);
  this.#stopWaiting(ts);
  if(text.trim()){this.turns++;this.eta=null;}
  if(!this.prompt&&text.trim())this.prompt=text.slice(0,4000);
  if(text.startsWith('[Request interrupted'))this.idle(ts);else this.thinking(ts);
 }
}

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

/** Claude Code keeps no usage limits in its transcripts; its status line helper writes them to a file. */
function claudeLimits(config){
 const path=config.claudeLimitsFile??join(homedir(),'.agent-monitor','claude-limits.json');
 if(!existsSync(path))return [];
 try{
  const {asOf,rate_limits:limits={}}=JSON.parse(readFileSync(path,'utf8'));
  const labels={five_hour:'5h',seven_day:'week'};
  const windows=Object.entries(limits).filter(([,window])=>typeof window?.used_percentage==='number').map(([key,window])=>({label:labels[key]??key.replace(/_/g,' '),used:window.used_percentage,minutes:key==='five_hour'?300:key.startsWith('seven_day')?10080:0,resetsAt:typeof window.resets_at==='number'?window.resets_at*1000:Date.parse(window.resets_at)||0}));
  return windows.length?[{account:'claude',plan:'',asOf,windows}]:[];
 }catch{return [];}
}

/** The Claude Code adapter. */
export default {name:'claude',Run:ClaudeRun,transcripts:({project,cutoff,home})=>claudeTranscripts(project,cutoff,home),limits:claudeLimits};
