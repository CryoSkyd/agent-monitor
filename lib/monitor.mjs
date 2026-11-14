import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename,join,relative} from 'node:path';
import {CardStore,parseCard} from './cards.mjs';
import {makeClassifier} from './classify.mjs';
import {makePricer} from './prices.mjs';
import {LimitHistory} from './forecast.mjs';
import {mergeBurn,mergeLimits} from './peers.mjs';
import {claudeTranscripts,codexTranscripts} from './discover.mjs';
import {ClaudeRun,CodexRun} from './runs.mjs';
import {CATS} from './timeline.mjs';

const THINK_STALE=10*60_000,TOOL_STALE=2*3600_000,STALLED=4*60_000;
const TASK_ID=/\b[A-Z][A-Z0-9]{0,6}-\d{1,5}\b/g;
const ACTIVE_CARD=['claimed','in-review','changes-requested'];
const normal=path=>String(path).replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
const seconds=ms=>Math.round(ms/1000);

export class Monitor{
 runs=new Map();
 constructor(config){
  this.config=config;
  const root=normal(config.project),name=basename(root);
  this.shared={
   burn:new Map(),
   limits:new Map(),
   history:new LimitHistory(),
   classify:makeClassifier(config.testPattern),
   price:makePricer(config.prices),
   isProject:cwd=>{const path=normal(cwd);return path===root||path.startsWith(`${root}/`)||basename(path)===name;},
  };
  this.cards=config.tasksDir?new CardStore(join(config.project,config.tasksDir)):null;
 }
 cutoff(now){return now-this.config.hours*3600_000;}
 discover(now){
  const cutoff=this.cutoff(now);
  for(const found of claudeTranscripts(this.config.project,cutoff))if(!this.runs.has(found.path))this.runs.set(found.path,new ClaudeRun(found.path,this.shared,found));
  for(const found of codexTranscripts(cutoff))if(!this.runs.has(found.path))this.runs.set(found.path,new CodexRun(found.path,this.shared,found));
  for(const [path,run] of this.runs)if(run.tail.mtime&&run.tail.mtime<cutoff-3600_000)this.runs.delete(path);
  this.shared.history.prune(now-2*3600_000);
 }
 poll(){
  let changed=false;
  for(const run of this.runs.values())if(run.poll())changed=true;
  return changed;
 }
 refreshCards(){return this.cards?.refresh()??false;}

 /** The card's text is read only when someone opens it. */
 card(id){
  const path=this.cards?.pathOf(id);
  if(!path)return null;
  const text=readFileSync(path,'utf8');
  return {id,file:relative(this.config.project,path).replace(/\\/g,'/'),fields:parseCard(text)??{},body:text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/,'')};
 }

 #run(id){
  for(const run of this.runs.values())if((run.id??run.tail.path)===id)return run;
  return null;
 }
 calls(id){
  const run=this.#run(id);
  return run&&{calls:run.calls.map(call=>[call.s,call.e,CATS.indexOf(call.cat),call.name,call.failed?1:0,call.label])};
 }
 call(id,index){return this.#run(id)?.detail(index)??null;}

 /** Written by tools/claude-statusline.mjs, because Claude Code reports plan limits only to a status line command. */
 #claudeLimits(){
  const path=this.config.claudeLimitsFile??join(homedir(),'.agent-monitor','claude-limits.json');
  if(!existsSync(path))return [];
  try{
   const {asOf,rate_limits:limits={}}=JSON.parse(readFileSync(path,'utf8'));
   const labels={five_hour:'5h',seven_day:'week'};
   const windows=Object.entries(limits).filter(([,window])=>typeof window?.used_percentage==='number').map(([key,window])=>({label:labels[key]??key.replace(/_/g,' '),used:window.used_percentage,resetsAt:typeof window.resets_at==='number'?window.resets_at*1000:Date.parse(window.resets_at)||0}));
   for(const window of windows)this.shared.history.add('claude',window.label,asOf,window.used);
   return windows.length?[{account:'claude',plan:'',asOf,windows}]:[];
  }catch{return [];}
 }

 #limits(now){
  const all=[...this.shared.limits.values(),...this.#claudeLimits()].sort((a,b)=>a.account.localeCompare(b.account));
  return all.map(limit=>({...limit,windows:limit.windows.map(window=>{
   const trend=this.shared.history.trend(limit.account,window.label,now);
   if(!trend||trend.rate<=0)return window;
   const fullAt=trend.at+(100-trend.used)/trend.rate*3600_000;
   return {...window,rate:Math.round(trend.rate*10)/10,fullAt:seconds(fullAt),early:!window.resetsAt||fullAt<window.resetsAt};
  })}));
 }

 #resolve(run,cards,prs){
  if(run.tool==='codex'&&run.role==='agent'&&run.prompt)run.role=/\bact as (?:an? |the )?([\w-]+)/i.exec(run.prompt)?.[1].toLowerCase()??'agent';
  if(run.task||(run.tool==='claude'&&run.kind==='session'))return;
  const text=`${run.title}\n${run.prompt}`;
  const ids=text.match(TASK_ID)??[];
  run.task=(cards.size?ids.find(id=>cards.has(id)):ids[0])??null;
  run.pr??=Number(/\bPR\s*#?(\d+)/i.exec(text)?.[1])||null;
  if(!run.task&&run.pr){
   const branch=prs.find(pr=>pr.number===run.pr)?.branch;
   if(branch)run.task=[...cards.values()].find(card=>card.branch===branch)?.id??(branch.match(TASK_ID)??[]).find(id=>!cards.size||cards.has(id))??null;
  }
 }

 /** `remote` holds what other machines contribute: {machine, views, limits, burn}, with `machine` naming this one. */
 snapshot(now,prs=[],remote=null){
  const cutoff=this.cutoff(now),cards=this.cards?.cards()??new Map();
  const guardianTokens=new Map();
  for(const run of this.runs.values()){
   if(!run.guardian||run.foreign)continue;
   const sum=guardianTokens.get(run.sessionId)??{in:0,cached:0,out:0,cost:0,unpriced:false};
   for(const key of ['in','cached','out'])sum[key]+=run.tokens[key];
   sum.cost+=run.cost;sum.unpriced||=run.unpriced;
   guardianTokens.set(run.sessionId,sum);
  }
  const visible=[...this.runs.values()].filter(run=>!run.guardian&&!run.foreign&&run.start&&run.last>=cutoff);
  const children=new Map();
  const views=[];
  for(const run of visible){
   this.#resolve(run,cards,prs);
   const age=now-run.last,current=run.tl.cur;
   const status=run.ended?'done':current?.c==='idle'||!current?'idle':age>(run.pending.size?TOOL_STALE:THINK_STALE)?'lost':'working';
   if(status==='working'&&run.parent)children.set(run.parent,(children.get(run.parent)??0)+1);
   const extra=guardianTokens.get(run.id);
   views.push({
    id:run.id??run.tail.path,tool:run.tool,account:run.account,kind:run.kind,role:run.role,title:run.title,model:run.model,effort:run.effort,
    task:run.task??null,pr:run.pr??null,parent:run.parent??null,
    start:seconds(run.start),last:seconds(run.last),end:run.ended?seconds(run.ended):status==='lost'?seconds(run.last):0,
    status,cat:status==='working'||status==='idle'?current?.c??'idle':null,label:status==='working'?current.label:'',since:current?seconds(current.s):0,
    stalled:status==='working'&&!run.pending.size&&age>STALLED,
    tok:extra?{in:run.tokens.in+extra.in,cached:run.tokens.cached+extra.cached,out:run.tokens.out+extra.out}:{...run.tokens},
    cost:run.unpriced?null:Math.round((run.cost+(extra?.cost??0))*100)/100,
    ctx:run.context,ctxMax:run.contextMax,tools:run.tools,requests:run.requests,turns:run.turns,
    compacts:run.compactions,errors:run.errors,rereads:run.rereads,warn:status==='working'?run.warnings():[],
    segs:run.tl.view(cutoff,status==='lost'?run.last:null),
    tot:run.tl.totals(status==='lost'?run.last:0),
    marks:run.marks.filter(([ts])=>ts>=cutoff).map(([ts,type])=>[seconds(ts),type]),
    msg:run.message,
   });
  }
  for(const view of views){
   const waiting=view.status==='idle'&&children.get(view.id);
   if(waiting)Object.assign(view,{status:'waiting',cat:'delegating',label:`Waiting on ${waiting} agent${waiting>1?'s':''}`});
  }
  views.sort((a,b)=>a.start-b.start);
  // What this machine alone knows, which is all it hands to another machine that asks.
  this.own={runs:views,limits:this.#limits(now),burn:[...this.shared.burn].filter(([ts])=>ts>=cutoff).sort((a,b)=>a[0]-b[0]).map(([ts,tokens])=>[seconds(ts),tokens])};
  const all=remote?[...views.map(view=>({...view,machine:remote.machine})),...remote.views].sort((a,b)=>a.start-b.start):views;
  return {
   now:seconds(now),
   project:{name:this.config.name,path:this.config.project},
   config:{hours:this.config.hours,limitWarn:this.config.limitWarn,hasCards:Boolean(this.cards),hasPrs:prs.length>0},
   cats:CATS,
   runs:all,
   tasks:this.#tasks(all,cards,prs,cutoff),
   limits:remote?mergeLimits([this.own.limits,...remote.limits]):this.own.limits,
   burn:remote?mergeBurn([this.own.burn,...remote.burn]):this.own.burn,
   merged:prs.filter(pr=>pr.merged>=cutoff).length,
  };
 }

 #tasks(views,cards,prs,cutoff){
  const done=new Set([...cards.values()].filter(card=>card.status==='done').map(card=>card.id));
  const byTask=new Map();
  for(const view of views)if(view.task)byTask.set(view.task,[...(byTask.get(view.task)??[]),view]);
  const prFor=card=>prs.find(pr=>pr.number===Number(card.pr))??prs.find(pr=>card.branch&&pr.branch===card.branch)??prs.find(pr=>new RegExp(`\\b${card.id}\\b`).test(pr.branch))??null;
  const tasks=[];
  const ids=new Set([...cards.keys(),...byTask.keys()]);
  for(const id of ids){
   const card=cards.get(id)??{id,title:byTask.get(id)[0].title||id,status:''},runs=byTask.get(id)??[];
   const pr=cards.has(id)||prs.length?prFor(card):null;
   const isDone=card.status==='done'||pr?.state==='MERGED';
   if(isDone&&!runs.length&&!(pr?.merged>=cutoff))continue;
   const waitsOn=[].concat(card.depends_on??[]).filter(dep=>!done.has(dep));
   const live=runs.filter(run=>run.status==='working');
   const reviewing=live.some(run=>/review/.test(run.role));
   const needsHuman=card.status==='needs-human'||pr?.labels.includes('needs-human');
   let phase;
   if(reviewing)phase='review';
   else if(live.length)phase='coding';
   else if(isDone)phase='done';
   else if(needsHuman)phase='needs-you';
   else if(card.status==='changes-requested')phase='changes';
   else if(pr?.state==='OPEN'||card.status==='in-review')phase='awaiting-review';
   else if(card.status==='claimed')phase='claimed';
   else if(waitsOn.length)phase='blocked';
   else if(card.status==='ready')phase=card.dispatch==='manual'?'needs-you':'queued';
   else if(card.status==='proposed')phase='needs-you';
   else phase=runs.length?'finished':'unknown';
   const note=phase==='needs-you'?(needsHuman?'question':card.dispatch==='manual'&&card.status==='ready'?'manual start':card.status==='proposed'?'proposed':''):'';
   tasks.push({
    id,title:card.title??id,status:card.status??'',phase,note,agent:card.agent??'',risk:card.risk??'',feature:card.feature??'',
    waitsOn,unblocks:[...cards.values()].filter(other=>other.status!=='done'&&[].concat(other.depends_on??[]).includes(id)).map(other=>other.id),
    pr:pr?{number:pr.number,state:pr.state,url:pr.url,created:seconds(pr.created),merged:seconds(pr.merged)}:null,
    active:ACTIVE_CARD.includes(card.status),
   });
  }
  return tasks;
 }
}
