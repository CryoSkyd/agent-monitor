import {existsSync,readFileSync} from 'node:fs';
import {Tail,readRange} from './tail.mjs';
import {Timeline} from './timeline.mjs';
import {short} from './classify.mjs';

const BURN_BUCKET=300_000;
const LOOP=3,RECENT=10,REREADS=5;
// shortcut: transcripts do not name the context window; assume 500K, or 1M once a request exceeds that.
// Claude Code context windows, from https://support.claude.com/en/articles/8606394: 1M on these models, and on older ones only when the 1M variant is picked.
const CLAUDE_WINDOW=200_000,CLAUDE_LONG_WINDOW=1_000_000,CLAUDE_LONG_MODELS=/fable|mythos|opus-(5|4-[78])|sonnet-5|haiku-5/;
export const claudeWindow=(model,used)=>CLAUDE_LONG_MODELS.test(model)||used>CLAUDE_WINDOW?CLAUDE_LONG_WINDOW:CLAUDE_WINDOW;
// How long a tool call may stay open before its run counts as stopped, when nothing tighter is known: builds and subagents can be slow.
export const TOOL_STALE=2*3600_000;
/** Minutes from a line the agent printed itself, such as `ETA: 30 min` or `ETA: 1.5 h`; null when its text has none. */
export function etaOf(text){
 const found=/^[ >*_`-]*ETA:[ *_`]*~?([0-9]+(?:[.][0-9]+)?) *(h|m)/im.exec(String(text??''));
 if(!found)return null;
 const minutes=Number(found[1])*(found[2].toLowerCase()==='h'?60:1);
 return minutes>0&&minutes<=10080?minutes:null;
}
const DETAIL_LIMIT=40_000;
const clip=text=>text.length>DETAIL_LIMIT?`${text.slice(0,DETAIL_LIMIT)}\n… ${text.length-DETAIL_LIMIT} more characters`:text;
function show(value){
 if(value==null)return '';
 if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(part=>typeof part==='string'?part:part?.text??JSON.stringify(part)).join('\n');
 return Object.entries(value).map(([key,item])=>`${key}: ${typeof item==='string'?item:JSON.stringify(item,null,1)}`).join('\n\n');
}

class Run{
 tl=new Timeline();
 pending=new Map();
 marks=[];
 tokens={in:0,cached:0,out:0};
 context=0;
 contextMax=0;
 tools=0;
 requests=0;
 turns=0;
 cost=0;
 unpriced=false;
 compactions=0;
 errors=0;
 fileReads=0;
 rereads=0;
 repeat=0;
 calls=[];
 at=null;
 #open=new Map();
 #lastCall='';
 #seenReads=new Set();
 #recent=[];
 start=0;
 last=0;
 ended=0;
 prompt='';
 title='';
 role='';
 model='';
 effort='';
 message='';
 /** The agent's own latest estimate: minutes, and when it said so. */
 eta=null;
 said(ts,text){const minutes=etaOf(text);if(minutes)this.eta={min:minutes,at:ts};}
 constructor(path,shared){this.tail=new Tail(path);this.shared=shared;}
 poll(){return this.tail.read((line,at)=>{this.at=[at,line.length];this.line(line);});}
 touch(ts){if(!this.start)this.start=ts;if(ts>this.last)this.last=ts;}
 burn(ts,amount){
  if(amount<=0)return;
  const key=Math.floor(ts/BURN_BUCKET)*BURN_BUCKET;
  this.shared.burn.set(key,(this.shared.burn.get(key)??0)+amount);
 }
 spend(model,tokens){
  const dollars=this.shared.price(model,tokens);
  if(dollars==null)this.unpriced=true;else this.cost+=dollars;
 }
 /** How long the run may stay silent before it counts as stopped: the longest any of its open calls may take. */
 toolAllowance(){return Math.max(0,...[...this.pending.values()].map(call=>call.limit??TOOL_STALE));}
 /** `limit` is how long this call can stay open while its agent is alive, when the tool makes that knowable. */
 callStarted(ts,id,{cat,name,label,mark,fileRead},key=label,limit){
  this.tools++;
  const call={id,s:ts,e:0,cat,name:name??cat,label,failed:false,at:this.at,out:null};
  this.calls.push(call);
  this.#open.set(id,call);
  if(key===this.#lastCall)this.repeat++;else{this.#lastCall=key;this.repeat=1;}
  // An edit makes reading the same file again reasonable, so the memory of reads starts over.
  if(cat==='editing')this.#seenReads.clear();
  else if(fileRead){
   this.fileReads++;
   if(this.#seenReads.has(key))this.rereads++;else this.#seenReads.add(key);
  }
  this.pending.set(id,{cat,label,limit});
  this.tl.set(ts,cat,label);
  if(mark)this.marks.push([ts,mark]);
 }
 callEnded(ts,id,failed=false){
  if(failed)this.errors++;
  const call=this.#open.get(id);
  if(call){Object.assign(call,{e:ts,failed,out:this.at});this.#open.delete(id);}
  this.#recent.push(failed);
  if(this.#recent.length>RECENT)this.#recent.shift();
  this.pending.delete(id);
  const next=[...this.pending.values()].at(-1);
  if(next)this.tl.set(ts,next.cat,next.label);else this.tl.set(ts,'thinking');
 }
 thinking(ts){if(!this.pending.size)this.tl.set(ts,'thinking');}
 /** A call's input and output are read back from the transcript only when someone opens it. */
 detail(index){
  const call=this.calls[index];
  if(!call)return null;
  const read=at=>{if(!at)return null;try{return JSON.parse(readRange(this.tail.path,at));}catch{return null;}};
  const input=read(call.at),output=read(call.out);
  return {index,count:this.calls.length,name:call.name,cat:call.cat,label:call.label,s:call.s,e:call.e,failed:call.failed,
   input:clip(show(input&&this.inputOf(input,call.id))),output:clip(show(output&&this.outputOf(output,call.id)))};
 }
 compacted(ts){this.compactions++;this.marks.push([ts,'compact']);this.#seenReads.clear();}
 /** Signs that a run is spending tokens without getting anywhere. */
 warnings(){
  const out=[];
  if(this.repeat>=LOOP)out.push(`same call ${this.repeat} times in a row`);
  const failed=this.#recent.filter(Boolean).length;
  if(this.#recent.length>=RECENT&&failed*2>=RECENT)out.push(`${failed} of the last ${RECENT} tool calls failed`);
  if(this.rereads>=REREADS&&this.rereads*4>=this.fileReads)out.push(`${this.rereads} repeat file reads`);
  return out;
 }
 idle(ts){this.pending.clear();this.tl.set(ts,'idle');}
}

const CLAUDE_SKIP=['{"type":"api-request','{"type":"file-history','{"type":"queue-operation','{"type":"bridge-session'];
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';

export class ClaudeRun extends Run{
 tool='claude';
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
   if(part.type==='tool_use')this.callStarted(ts,part.id,this.shared.classify.claudeTool(part.name,part.input),`${part.name} ${JSON.stringify(part.input)}`);
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
   for(const part of content)if(part.type==='tool_result')this.callEnded(ts,part.tool_use_id,part.is_error===true);
   if(content.every(part=>part.type==='tool_result'))return;
  }
  const text=textOf(content);
  if(text.trim()){this.turns++;this.eta=null;}
  if(!this.prompt&&text.trim())this.prompt=text.slice(0,4000);
  if(text.startsWith('[Request interrupted'))this.idle(ts);else this.thinking(ts);
 }
}

const CODEX_SKIP=/"type":"(world_state|token_usage_record|thread_settings_applied)"/;
const CODEX_PREAMBLE=/^\s*(# AGENTS\.md instructions|<environment_context|<user_instructions)/;
// Exit code 1 is left out: search commands return it for "no match".
const codexFailed=output=>{
 const head=(typeof output==='string'?output:JSON.stringify(output??'')).slice(0,600);
 return /Script failed/.test(head)||/exit_code\\*":\s*(?:-\d+|[2-9]|\d{2,})/.test(head);
};
// A Codex command does not block until it finishes: it hands control back after the wait the call names, and long work
// carries on in the background. So a call still open well past that wait means the agent is gone, not that a build is slow.
// shortcut: with no wait named, twice the longest wait seen in practice (60 s); revisit if Codex allows longer default waits.
const CODEX_WAIT=/(?:yield_time_ms|duration_ms|timeout_ms)["']?\s*:\s*(\d+)/g,CODEX_UNNAMED_WAIT=120_000,CODEX_MARGIN=60_000;
export function codexCallLimit(input){
 const named=Math.max(0,...[...String(input).matchAll(CODEX_WAIT)].map(match=>Number(match[1])));
 return Math.min(TOOL_STALE,Math.max(CODEX_UNNAMED_WAIT,named+CODEX_MARGIN));
}
const windowLabel=minutes=>minutes>=10080?'week':minutes>=1440?`${Math.round(minutes/1440)}d`:`${Math.round(minutes/60)}h`;

export class CodexRun extends Run{
 tool='codex';
 kind='exec';
 role='agent';
 #total={in:0,cached:0,out:0};
 constructor(path,shared,{account}){super(path,shared);this.account=account;}
 line(buffer){
  if(CODEX_SKIP.test(buffer.subarray(0,160).toString()))return;
  let entry;
  try{entry=JSON.parse(buffer.toString());}catch{return;}
  const ts=Date.parse(entry.timestamp),payload=entry.payload??{};
  if(!ts)return;
  if(entry.type==='session_meta'){
   Object.assign(this,{id:payload.id,sessionId:payload.session_id,cwd:payload.cwd??'',originator:payload.originator??''});
   this.guardian=typeof payload.source==='object'&&payload.source!==null;
   this.foreign=!this.shared.isProject(this.cwd);
   if(payload.originator!=='codex_exec')this.kind='session';
   this.touch(Date.parse(payload.timestamp)||ts);
   return;
  }
  if(entry.type==='turn_context'){this.model=payload.model??this.model;this.effort=payload.effort??this.effort;return;}
  if(payload.type==='token_count')return this.tokenCount(ts,payload);
  if(this.guardian||this.foreign)return;
  if(entry.type==='compacted'){this.compacted(ts);return;}
  this.touch(ts);
  switch(payload.type){
   case 'message':
    if(payload.role==='user')this.userMessage(ts,payload);
    else if(payload.role==='assistant'){
     const text=(payload.content??[]).map(part=>part.text??'').join('\n');
     if(text.trim()){this.message=short(text,200);this.said(ts,text);}
     this.thinking(ts);
    }
    break;
   case 'task_started':this.turns++;this.thinking(ts);break;
   case 'reasoning':this.thinking(ts);break;
   case 'custom_tool_call':case 'function_call':case 'local_shell_call':
    if(payload.name==='wait')break;
    {
     const input=payload.input??payload.arguments??payload.action;
     const text=typeof input==='string'?input:JSON.stringify(input);
     // An interactive session can sit in a call while it waits for its user's approval, so only unattended runs get the short limit.
     this.callStarted(ts,payload.call_id,this.shared.classify.codexCall(payload.name??'shell',input),`${payload.name} ${text}`,this.kind==='exec'?codexCallLimit(text):undefined);
    }
    break;
   case 'custom_tool_call_output':case 'function_call_output':case 'local_shell_call_output':this.callEnded(ts,payload.call_id,codexFailed(payload.output));break;
   case 'task_complete':case 'turn_aborted':case 'error':
    if(payload.last_agent_message)this.message=short(payload.last_agent_message,200);
    if(this.kind==='exec'){this.tl.end(ts);this.pending.clear();this.ended=ts;}else this.idle(ts);
    break;
  }
 }
 inputOf(entry){return entry.payload?.input??entry.payload?.arguments??entry.payload?.action;}
 /** Shell results arrive as a JSON string holding the exit code and the text; show them as plain text. */
 outputOf(entry){
  const parts=[].concat(entry.payload?.output??[]).map(part=>typeof part==='string'?part:part?.text??'');
  return parts.map(text=>{
   try{const inner=JSON.parse(text);if(typeof inner?.output==='string')return inner.exit_code==null?inner.output:`exit code ${inner.exit_code}\n${inner.output}`;}catch{}
   return text;
  }).join('\n');
 }
 userMessage(ts,payload){
  const text=(payload.content??[]).map(part=>part.text??'').filter(part=>!CODEX_PREAMBLE.test(part)).join('\n');
  if(!text.trim())return;
  if(!this.prompt)this.prompt=text.slice(0,4000);
  this.eta=null;
  this.ended=0;
  this.thinking(ts);
 }
 tokenCount(ts,payload){
  const usage=payload.info?.total_token_usage;
  if(usage){
   const cached=usage.cached_input_tokens??0;
   const now={in:(usage.input_tokens??0)-cached,cached,out:usage.output_tokens??0};
   if(!this.foreign){
    this.burn(ts,now.in+now.out-this.#total.in-this.#total.out);
    this.requests++;
    this.spend(this.model,{fresh:now.in-this.#total.in,cached:now.cached-this.#total.cached,out:now.out-this.#total.out});
   }
   this.#total=now;this.tokens={...now};
   this.context=payload.info.last_token_usage?.input_tokens??this.context;
   this.contextMax=payload.info.model_context_window??this.contextMax;
  }
  const limits=payload.rate_limits;
  if(!limits)return;
  const windows=[limits.primary,limits.secondary].filter(Boolean).map(window=>({label:windowLabel(window.window_minutes),used:window.used_percent,resetsAt:window.resets_at*1000}));
  for(const window of windows)this.shared.history?.add(this.account,window.label,ts,window.used);
  const known=this.shared.limits.get(this.account);
  if(known&&known.asOf>ts)return;
  this.shared.limits.set(this.account,{account:this.account,plan:limits.plan_type??'',asOf:ts,windows});
 }
}
