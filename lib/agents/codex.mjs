import {homedir} from 'node:os';
import {join} from 'node:path';
import {fresh,list} from '../discover.mjs';
import {existsSync} from 'node:fs';
import {short} from '../classify.mjs';
import {TOOL_STALE,show,Run} from '../run.mjs';
import {Waits} from '../waits.mjs';


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
 /** A Codex run does not record its role; the first request names it. */
 settle(){if(this.role==='agent'&&this.prompt)this.role=/\bact as (?:an? |the )?([\w-]+)/i.exec(this.prompt)?.[1].toLowerCase()??'agent';}
 kind='exec';
 role='agent';
 #total={in:0,cached:0,out:0};
 waits=new Waits();
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
     const info=this.waits.started(payload.call_id,payload.name,text,this.shared.classify.codexCall(payload.name??'shell',input));
     if(info.wait){this.waited.n++;this.waitOpen.set(payload.call_id,ts);}
     this.callStarted(ts,payload.call_id,info,`${payload.name} ${text}`,this.kind==='exec'?codexCallLimit(text):undefined);
    }
    break;
   case 'custom_tool_call_output':case 'function_call_output':case 'local_shell_call_output':
    this.waits.ended(payload.call_id,payload.output);
    if(this.waitOpen.has(payload.call_id)){this.waited.ms+=ts-this.waitOpen.get(payload.call_id);this.waitOpen.delete(payload.call_id);}
    this.callEnded(ts,payload.call_id,codexFailed(payload.output));break;
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
  const windows=[limits.primary,limits.secondary].filter(Boolean).map(window=>({label:windowLabel(window.window_minutes),used:window.used_percent,minutes:window.window_minutes,resetsAt:window.resets_at*1000}));
  for(const window of windows)this.shared.history?.add(this.account,window.label,ts,window.used);
  const known=this.shared.limits.get(this.account);
  if(known&&known.asOf>ts)return;
  this.shared.limits.set(this.account,{account:this.account,plan:limits.plan_type??'',asOf:ts,windows});
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

/** The Codex adapter. Every `~/.codex*` folder is one account. */
export default {name:'codex',Run:CodexRun,transcripts:({cutoff,home})=>codexTranscripts(cutoff,home)};
