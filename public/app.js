const $=id=>document.getElementById(id);
const CAT_LABEL={thinking:'Thinking',editing:'Editing',reading:'Reading',testing:'Testing / building',git:'Git / PR',delegating:'Delegating',command:'Running command',idle:'Idle'};
const PHASE_LABEL={coding:'Coding',review:'In review','awaiting-review':'Awaiting review',changes:'Changes requested',claimed:'Claimed · no agent',done:'Done',finished:'Finished','needs-you':'Needs you',queued:'Queued',blocked:'Blocked',unknown:'Unknown'};
const STATUS_LABEL={working:'Working',waiting:'Waiting on agents',idle:'Idle',done:'Done',lost:'Stopped responding'};
const MARK_LABEL={pr:'PR opened',merge:'PR merged',verdict:'Review comment',push:'Pushed',commit:'Commit',compact:'Context compacted'};
const IN_FLIGHT=['coding','review','awaiting-review','changes','claimed'];
const LANE=9,LANE_GAP=3,PAD=4,CTX_WARN=80,ALERT_REPEAT=1800;

let snap=null,sys=null,machines=null,peerHistory={},cpuHistory=[],windowHours=Number(localStorage.getItem('window'))||3,colors={};
const expanded=new Set();
let panel=null;
const html={};
const nowSec=()=>Date.now()/1000;

const esc=text=>String(text??'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const fmtTok=n=>n>=1e6?`${(n/1e6).toFixed(n>=1e7?0:1)}M`:n>=1e3?`${Math.round(n/1e3)}K`:String(Math.round(n));
const fmtDur=(s,fine=false)=>{s=Math.max(0,Math.round(s));if(s<60)return `${s}s`;if(s<3600)return fine&&s<600?`${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`:`${Math.floor(s/60)}m`;if(s>=172800)return `${Math.floor(s/86400)}d ${Math.floor(s%86400/3600)}h`;return `${Math.floor(s/3600)}h ${String(Math.floor(s%3600/60)).padStart(2,'0')}m`;};
const fmtClock=s=>new Date(s*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
const model=name=>String(name??'').replace(/^(claude|gpt)-/,'');
const sum=(items,pick)=>items.reduce((total,item)=>total+pick(item),0);
const work=run=>run.tok.in+run.tok.out;
const fmtCost=dollars=>dollars>=100?`$${Math.round(dollars)}`:`$${dollars.toFixed(2)}`;
function costText(runs){
 const priced=runs.filter(run=>run.cost!=null),missing=runs.length-priced.length;
 if(!priced.length)return runs.length?'no price set for these models':'';
 return `≈ ${fmtCost(sum(priced,run=>run.cost))} at API list prices${missing?` · ${missing} run${missing>1?'s':''} with no price set`:''}`;
}
const tokenTitle=runs=>esc(`${fmtTok(sum(runs,run=>run.tok.in))} input · ${fmtTok(sum(runs,run=>run.tok.cached))} cached · ${fmtTok(sum(runs,run=>run.tok.out))} output${cacheRate(runs)==null?'':`\n${cacheRate(runs)}% of input read from cache`}\n${costText(runs)}`);
const cacheRate=runs=>{const cached=sum(runs,run=>run.tok.cached),all=cached+sum(runs,run=>run.tok.in);return all?Math.round(100*cached/all):null;};
const fmtMs=ms=>ms<10_000?`${(ms/1000).toFixed(1)}s`:fmtDur(ms/1000,true);
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
const effort=run=>[`${run.requests} model requests`,plural(run.turns,'turn'),plural(run.tools,'tool call'),cacheRate([run])==null?'':`cache hit ${cacheRate([run])}%`,run.errors?`${run.errors} failed`:'',run.rereads?plural(run.rereads,'repeat read'):'',run.compacts?plural(run.compacts,'compaction'):''].filter(Boolean).join(' · ');
function contextMeter(run){
 if(!run.ctx)return '';
 const share=run.ctxMax?Math.round(100*run.ctx/run.ctxMax):null,hot=share>=CTX_WARN;
 const title=`Context in use: ${fmtTok(run.ctx)}${run.ctxMax?` of ${fmtTok(run.ctxMax)}`:''}${run.compacts?` · compacted ${plural(run.compacts,'time')}`:''}`;
 return `<span class="ctx ${hot?'hot':''}" title="${esc(title)}"><span>${hot?'▲ ':''}ctx ${share==null?fmtTok(run.ctx):`${share}%`}${run.compacts?` · ${run.compacts}×`:''}</span>${share==null?'':`<span class="meter ${hot?'hot':''}"><i style="width:${Math.min(100,share)}%"></i></span>`}</span>`;
}

function readColors(){
 const style=getComputedStyle(document.documentElement),get=name=>style.getPropertyValue(name).trim();
 colors={cats:(snap?.cats??Object.keys(CAT_LABEL)).map(cat=>get(`--cat-${cat}`)),track:get('--track'),line:get('--line'),text:get('--text'),text2:get('--text-2'),text3:get('--text-3'),accent:get('--accent'),warning:get('--warning'),surface:get('--surface')};
}
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>{readColors();draw();});

function setHtml(id,markup){if(html[id]===markup)return false;html[id]=markup;$(id).innerHTML=markup;return true;}

function setupCanvas(canvas,height){
 const ratio=devicePixelRatio||1,width=canvas.clientWidth;
 if(height)canvas.style.height=`${height}px`;
 const h=height??canvas.clientHeight;
 if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(h*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(h*ratio);}
 const ctx=canvas.getContext('2d');
 ctx.setTransform(ratio,0,0,ratio,0,0);
 ctx.clearRect(0,0,width,h);
 return {ctx,width,height:h};
}

/* ---------- derived view ---------- */

function view(){
 const now=nowSec(),from=now-windowHours*3600;
 const runs=snap.runs.filter(run=>(run.end||(run.status==='idle'?run.last:now))>=from);
 const byTask=new Map();
 for(const run of runs)if(run.task)byTask.set(run.task,[...(byTask.get(run.task)??[]),run]);
 const tasks=new Map(snap.tasks.map(task=>[task.id,task]));
 const flight=[],earlier=[];
 for(const task of snap.tasks){
  const taskRuns=byTask.get(task.id)??[];
  if(IN_FLIGHT.includes(task.phase))flight.push({task,runs:taskRuns});
  else if(taskRuns.length)earlier.push({task,runs:taskRuns});
 }
 const lastOf=entry=>Math.max(0,...entry.runs.map(run=>run.end||now));
 const liveFirst=entry=>entry.runs.some(run=>run.status==='working')?0:1;
 flight.sort((a,b)=>liveFirst(a)-liveFirst(b)||lastOf(b)-lastOf(a)||a.task.id.localeCompare(b.task.id));
 earlier.sort((a,b)=>lastOf(b)-lastOf(a));
 const sessions=runs.filter(run=>!run.task||!tasks.has(run.task)).sort((a,b)=>(a.status==='done')-(b.status==='done')||b.last-a.last);
 return {now,from,runs,flight,earlier,sessions};
}

/* ---------- tiles ---------- */

function renderTiles(v){
 const working=v.runs.filter(run=>run.status==='working');
 $('agents').textContent=working.length;
 const groups=new Map();
 for(const run of working){
  const key=[run.account,model(run.model),run.effort].filter(Boolean).join(' · ');
  groups.set(key,(groups.get(key)??0)+1);
 }
 setHtml('agents-sub',[...groups].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([key,count])=>`<span><b>${count}</b> ${esc(key)}</span>`).join('')||'none running');

 const total=sum(v.runs,work),cached=sum(v.runs,run=>run.tok.cached);
 $('tokens').textContent=fmtTok(total);
 $('tokens').parentElement.parentElement.title=costText(v.runs);
 $('tokens-sub').textContent=`+ ${fmtTok(cached)} cached${cacheRate(v.runs)==null?'':` · cache hit ${cacheRate(v.runs)}%`} · last ${windowHours}h`;

 const warn=snap.config.limitWarn;
 setHtml('limits',snap.limits.flatMap(limit=>limit.windows.map(window=>{
  const early=window.early&&window.fullAt>v.now,hot=window.used>=warn||early;
  const reset=window.resetsAt>v.now*1000?Math.round(window.resetsAt/1000):0;
  const title=[limit.plan?`${limit.plan} plan`:'',`read ${fmtClock(limit.asOf/1000)}`,window.rate?`rising ${window.rate}% per hour`:'',reset?`resets ${new Date(reset*1000).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false})}`:''].filter(Boolean).join(' · ');
  return `<div class="limit" title="${esc(title)}"><span>${esc(limit.account)} <em>${esc(window.label)}${reset?` · <span data-until="${reset}"></span> left`:''}</em></span><b class="${hot?'hot':''}">${hot?'▲ ':''}${Math.round(window.used)}%</b><div class="meter ${hot?'hot':''}"><i style="width:${Math.min(100,window.used)}%"></i></div>${early?`<p class="hot">full in <span data-until="${window.fullAt}"></span> at this rate</p>`:''}</div>`;
 })).join('')||'<p>No limit data in the window</p>');

 const count=phases=>snap.tasks.filter(task=>phases.includes(task.phase)).length;
 const cell=(label,value)=>`<div><span>${label}</span><b>${value}</b></div>`;
 setHtml('counts',snap.config.hasCards?cell('In flight',count(IN_FLIGHT))+cell('Can start',count(['queued']))+cell('Blocked',count(['blocked']))+cell('Needs you',count(['needs-you'])):cell('Tasks seen',snap.tasks.length));
 $('board-sub').textContent=snap.config.hasPrs?`${snap.merged} PRs merged in ${snap.config.hours}h`:'';
}

/** Every machine's load, this one first. With no other machines listed there is just this one, unnamed. */
function machineLoads(){
 const own={name:machines?.local??'',load:sys,history:cpuHistory,note:'',version:snap?.version};
 if(!machines?.peers.length)return [own];
 return [own,...machines.peers.map(peer=>{
  const up=peer.ok&&peer.cpu!=null;
  return {name:peer.name,version:peer.version,load:up?peer:null,history:up?peerHistory[peer.name]??[]:[],note:up?'':peer.ok?'starting':`unreachable: ${peer.error}`};
 })];
}
const gigabytes=bytes=>(bytes/2**30).toFixed(1);
function renderSystem(){
 const loads=machineLoads(),many=loads.length>1;
 // One colour per machine, shared by its CPU line and its legend entry.
 const palette=[colors.accent,colors.cats[3],colors.cats[2],colors.cats[4],colors.cats[6],colors.cats[1]];
 for(const id of ['cpu','mem'])$(id).closest('.tile').classList.toggle('many',many);
 if(many){
  setHtml('cpu-legend',loads.map(({name,load,note,version},i)=>`<span title="${esc([note||`${load.cores} threads`,version&&`agent-monitor v${version}`].filter(Boolean).join(' · '))}"><i class="dot" style="--c:${palette[i%palette.length]}"></i>${esc(name)}<b class="${load?.cpu>=85?'hot':''}">${load?`${Math.round(load.cpu)}%`:'–'}</b></span>`).join(''));
  setHtml('mem-rows',loads.map(({name,load,note})=>{
   if(!load)return `<div class="mem-row"><span>${esc(name)}</span><em>${esc(note)}</em><div class="meter"><i style="width:0"></i></div></div>`;
   const share=100*load.memUsed/load.memTotal;
   return `<div class="mem-row"><span>${esc(name)}</span><b>${gigabytes(load.memUsed)}<small> of ${gigabytes(load.memTotal)} GB</small></b><div class="meter${share>=90?' hot':''}"><i style="width:${share}%"></i></div></div>`;
  }).join(''));
  $('cpu-sub').textContent='last 10 minutes';
 }else if(sys){
  $('cpu').textContent=Math.round(sys.cpu);
  $('cpu-warn').hidden=sys.cpu<85;
  $('cpu-sub').textContent=`last 10 minutes · ${sys.cores} threads`;
  const share=100*sys.memUsed/sys.memTotal;
  $('mem').textContent=gigabytes(sys.memUsed);
  $('mem-sub').textContent=`of ${gigabytes(sys.memTotal)} GB · ${Math.round(share)}%`;
  $('mem-bar').style.width=`${share}%`;
  $('mem-bar').parentElement.classList.toggle('hot',share>=90);
 }
 const {ctx,width,height}=setupCanvas($('cpu-spark'));
 const span=600_000,end=Math.max(0,...loads.map(({history})=>history.at(-1)?.[0]??0)),x=t=>width-(end-t)/span*width,y=value=>height-1-Math.min(100,value)/100*(height-2);
 loads.forEach(({history},i)=>{
  if(history.length<2)return;
  ctx.beginPath();
  history.forEach(([t,value],at)=>at?ctx.lineTo(x(t),y(value)):ctx.moveTo(x(t),y(value)));
  ctx.strokeStyle=palette[i%palette.length];ctx.lineWidth=1.5;ctx.lineJoin='round';ctx.stroke();
  if(many)return;
  ctx.lineTo(x(history.at(-1)[0]),height);ctx.lineTo(x(history[0][0]),height);ctx.closePath();
  ctx.globalAlpha=.14;ctx.fillStyle=colors.accent;ctx.fill();ctx.globalAlpha=1;
 });
 refreshSnapLists();
}

function drawBurn(v){
 const {ctx,width,height}=setupCanvas($('burn-spark'));
 const bucket=300,first=Math.floor(v.from/bucket)*bucket,slots=Math.ceil((v.now-first)/bucket);
 const values=new Array(slots).fill(0);
 for(const [t,tokens] of snap.burn){const i=Math.floor((t-first)/bucket);if(i>=0&&i<slots)values[i]+=tokens;}
 const peak=Math.max(1,...values),step=width/slots,bar=Math.max(1,step-1);
 ctx.fillStyle=colors.accent;
 values.forEach((value,i)=>{if(!value)return;const h=Math.max(1,value/peak*(height-1));ctx.beginPath();ctx.roundRect(i*step,height-h,bar,h,[Math.min(2,bar/2),Math.min(2,bar/2),0,0]);ctx.fill();});
}

/* ---------- rows ---------- */

// The machine comes first: the line is cut short when it does not fit, and where an agent runs matters more than its effort setting.
const chip=run=>[run.machine,run.role,run.account,model(run.model),run.effort].filter(Boolean).join(' · ');
const chipSpan=text=>`<span class="chip" title="${esc(text)}">${esc(text)}</span>`;
function liveLine(run){
 if(run.status==='working'){
  const stalled=(run.stalled?`<span class="alert">▲ no output</span>`:'')+run.warn.map(warning=>`<span class="alert">▲ ${esc(warning)}</span>`).join('');
  return `<div class="l3"><i class="dot" style="--c:var(--cat-${run.cat})"></i><b>${CAT_LABEL[run.cat]}</b>${stalled}<span class="what" title="${esc(run.label)}">${esc(run.label)}</span><span class="for" data-since="${run.since}" data-fine></span></div>`;
 }
 if(run.status==='waiting')return `<div class="l3"><i class="dot" style="--c:var(--cat-delegating)"></i><b>${esc(run.label)}</b><span class="for" data-since="${run.since}"></span></div>`;
 return '';
}
function lanes(runs){
 const ends=[];
 return [...runs].sort((a,b)=>a.start-b.start).map(run=>{
  let lane=ends.findIndex(end=>end<=run.start);
  if(lane<0)lane=ends.length;
  ends[lane]=run.end||Infinity;
  return {run,lane};
 });
}
function activityTotals(runs){
 const now=nowSec(),out=snap.cats.map(()=>0);
 for(const run of runs){
  run.tot.forEach((seconds,i)=>{out[i]+=seconds;});
  const open=run.segs.at(-1);
  if(open&&open[1]===0)out[open[2]]+=Math.max(0,now-open[0]);
 }
 return out;
}
function rollup(id){
 const runs=snap.runs.filter(run=>run.task===id);
 if(!runs.length)return '';
 const totals=activityTotals(runs),working=sum(totals,seconds=>seconds)-totals[snap.cats.indexOf('idle')];
 const reviews=runs.filter(run=>/review/.test(run.role)).length,priced=runs.filter(run=>run.cost!=null);
 const parts=[plural(runs.length,'run'),plural(reviews,'review'),`${fmtDur(working)} working`,`${fmtTok(sum(runs,work))} tokens`,cacheRate(runs)==null?'':`cache hit ${cacheRate(runs)}%`,priced.length?`≈ ${fmtCost(sum(priced,run=>run.cost))}`:''];
 return `<div class="mix-key rollup" title="${tokenTitle(runs)}"><span>Whole task, last ${snap.config.hours}h</span>${parts.filter(Boolean).map(part=>`<span><b>${part}</b></span>`).join('')}</div>`;
}
function breakdown(runs,extra=''){
 const totals=activityTotals(runs),all=sum(totals,seconds=>seconds)||1;
 const parts=totals.map((seconds,i)=>({cat:snap.cats[i],seconds})).filter(part=>part.seconds>0);
 const bar=parts.map(part=>`<i style="flex:${part.seconds};--c:var(--cat-${part.cat})" title="${CAT_LABEL[part.cat]} ${fmtDur(part.seconds)}"></i>`).join('');
 const key=[...parts].sort((a,b)=>b.seconds-a.seconds).map(part=>`<span><i class="dot" style="--c:var(--cat-${part.cat})"></i>${CAT_LABEL[part.cat]} <b>${fmtDur(part.seconds)}</b> ${Math.round(100*part.seconds/all)}%</span>`).join('');
 // The row above cuts long names short, so the opened row spells out each agent in full.
 const who=`<div class="who">${runs.map(run=>`<p><b>${esc(run.title||run.role)}</b><span>${esc(chip(run))}</span></p>`).join('')}</div>`;
 const list=runs.length>1?`<div class="runs">${runs.map(run=>`<b title="${esc(run.title||run.role)}">${esc(run.title||run.role)}</b><span title="${esc(chip(run))}">${esc([run.machine,run.account,model(run.model),run.effort].filter(Boolean).join(' · '))}</span><span>${fmtClock(run.start)}–${run.end?fmtClock(run.end):'now'}</span><span title="${tokenTitle([run])}">${fmtTok(work(run))} tokens · ${effort(run)}</span>`).join('')}</div>`:`<div class="mix-key"><span>${runs.map(effort).join('')}</span></div>`;
 return `<div class="detail">${who}${extra}<div class="mix">${bar}</div><div class="mix-key">${key||'No activity recorded'}</div>${list}<div class="tools" data-tools="${esc(runs.map(run=>run.id).join(','))}"></div></div>`;
}
const expander=key=>`<button class="exp" data-expand="${esc(key)}" aria-expanded="${expanded.has(key)}" title="Time by activity">${expanded.has(key)?'▾':'▸'}</button>`;
const laneCanvas=runs=>{const count=Math.max(1,...lanes(runs).map(item=>item.lane+1));return `<canvas class="lane" data-runs="${esc(runs.map(run=>run.id).join(','))}" data-lanes="${count}"></canvas>`;};
const prLink=pr=>pr?`<button class="pr" data-pr="${pr.number}" title="View this pull request here">PR #${pr.number}</button><a class="ext" href="${esc(pr.url)}" target="_blank" rel="noreferrer" title="Open on GitHub">↗</a>`:'';

function taskRow({task,runs},compact){
 const working=runs.filter(run=>run.status==='working');
 const tokens=sum(runs,work);
 const context=working.map(contextMeter).join('');
 const pill=`<span class="pill ${task.phase}"><i></i>${PHASE_LABEL[task.phase]??task.phase}</span>`;
 const key=`task:${task.id}`,more=expanded.has(key)?breakdown(runs,rollup(task.id)):'';
 const head=`<div class="l1">${expander(key)}<span class="id">${esc(task.id)}</span><button class="title" data-card="${esc(task.id)}" title="${esc(task.title)}">${esc(task.title)}</button></div>`;
 const pr=task.pr?`<span>${prLink(task.pr)}${task.pr.state==='OPEN'?'':` ${task.pr.state.toLowerCase()}`}</span>`:'';
 if(compact){
  const active=sum(runs,run=>(run.end||nowSec())-run.start);
  return `<div class="row compact"><div class="info">${head}<div class="l2">${pill}${pr}<span class="chip">${runs.length} run${runs.length>1?'s':''} · ${fmtDur(active)}</span></div></div>${laneCanvas(runs)}<div class="metrics" title="${tokenTitle(runs)}"><b>${fmtTok(tokens)}</b></div>${more}</div>`;
 }
 let detail=working.map(liveLine).join('');
 if(!detail){
  if(task.phase==='awaiting-review'&&task.pr)detail=`<div class="l3"><b>Waiting for a reviewer</b><span class="for" data-since="${task.pr.created}"></span></div>`;
  else if(task.phase==='changes')detail=`<div class="l3"><b>Changes requested</b><span>no agent on it</span></div>`;
  else if(task.phase==='claimed'){const last=Math.max(0,...runs.map(run=>run.last));detail=`<div class="l3"><span class="alert">▲</span><span>${last?'no agent running · last activity':'claimed, no agent seen in this window'}</span>${last?`<span class="for" data-since="${last}"></span>`:''}</div>`;}
 }
 const who=working.length?working.map(chip).join(' + '):task.agent||'';
 const started=runs.length?`<span data-since="${Math.min(...runs.map(run=>run.start))}"></span>`:'';
 return `<div class="row"><div class="info">${head}<div class="l2">${pill}${pr}${chipSpan(who)}${started}</div>${detail}</div>${laneCanvas(runs)}<div class="metrics" title="${tokenTitle(runs)}"><b>${fmtTok(tokens)}</b>${context}<span>${sum(runs,run=>run.tools)} tool calls</span></div>${more}</div>`;
}

function sessionRow(run){
 const title=run.title||(run.tool==='codex'?`Codex ${run.role}${run.pr?` · PR #${run.pr}`:''}`:'Claude session');
 const hint=run.auto!=null?`${title}\nRenamed here. Automatic name: ${run.auto||'none'}`:title;
 const context=contextMeter(run);
 const compact=run.status==='done'||run.status==='lost';
 const key=`run:${run.id}`;
 return `<div class="row ${compact?'compact':''}"><div class="info"><div class="l1">${expander(key)}<span class="title" title="${esc(hint)}">${esc(title)}</span><button class="rename" data-rename="${esc(run.id)}" data-name="${esc(title)}" title="Rename on this dashboard" aria-label="Rename ${esc(title)}">✎</button></div><div class="l2"><span class="pill ${run.status}"><i></i>${STATUS_LABEL[run.status]}</span>${chipSpan(chip(run))}${compact?'':`<span data-since="${run.start}"></span>`}</div>${liveLine(run)}</div>${laneCanvas([run])}<div class="metrics" title="${tokenTitle([run])}"><b>${fmtTok(work(run))}</b>${compact?'':context}</div>${expanded.has(key)?breakdown([run]):''}</div>`;
}

const group=(label,count)=>`<div class="group">${label}<span>${count}</span></div>`;
function renderRows(v){
 // A name being typed would be wiped by a redraw, so the rows hold still until it is saved or dropped.
 if(renaming)return false;
 let changed=false;
 changed|=setHtml('flight',group('In flight',v.flight.length)+(v.flight.map(entry=>taskRow(entry,false)).join('')||'<div class="empty">Nothing in flight.</div>'));
 changed|=setHtml('sessions',v.sessions.length?group('Sessions',v.sessions.length)+v.sessions.map(sessionRow).join(''):'');
 changed|=setHtml('earlier',v.earlier.length?group(`Earlier in the last ${windowHours}h`,v.earlier.length)+v.earlier.map(entry=>taskRow(entry,true)).join(''):'');
 return changed;
}

function renderLists(){
 if(!snap.config.hasCards){setHtml('lists','');return;}
 const item=(task,note)=>`<li><span class="id">${esc(task.id)}</span><button class="title" data-card="${esc(task.id)}" title="${esc(task.title)}">${esc(task.title)}</button><span class="note">${esc(note)}</span></li>`;
 const list=(label,tasks,note)=>`<div class="list"><h3>${label} · ${tasks.length}</h3><ul>${tasks.map(task=>item(task,note(task))).join('')||'<li><span class="title">none</span></li>'}</ul></div>`;
 const of=phase=>snap.tasks.filter(task=>task.phase===phase).sort((a,b)=>a.id.localeCompare(b.id));
 setHtml('lists',list('Can start',of('queued'),task=>task.unblocks.length?`unblocks ${task.unblocks.join(', ')}`:task.agent)+list('Blocked',of('blocked'),task=>`waits on ${task.waitsOn.join(', ')}`)+list('Needs you',of('needs-you'),task=>task.note));
}

function renderLegend(){
 setHtml('legend',snap.cats.map(cat=>`<span><i class="dot" style="--c:var(--cat-${cat})"></i>${CAT_LABEL[cat]}</span>`).join(''));
}

/* ---------- tool calls ---------- */

const callCache=new Map();
/** The call list of a run, fetched when first needed and again when the run has made more calls. */
async function callsOf(run){
 const known=callCache.get(run.id);
 if(known&&(known.tools===run.tools||Date.now()-known.at<10_000))return known.calls;
 let calls=known?.calls??[];
 try{const response=await fetch(`api/calls?run=${encodeURIComponent(run.id)}`);if(response.ok)calls=(await response.json()).calls;}catch{}
 callCache.set(run.id,{tools:run.tools,at:Date.now(),calls});
 return calls;
}
function toolStats(calls){
 const byName=new Map();
 for(const [start,end,,name,failed] of calls){
  const entry=byName.get(name)??{name,count:0,failed:0,times:[]};
  entry.count++;entry.failed+=failed;
  if(end)entry.times.push(end-start);
  byName.set(name,entry);
 }
 const rows=[...byName.values()].map(entry=>{
  const times=entry.times.sort((a,b)=>a-b),at=share=>times.length?times[Math.max(0,Math.ceil(share*times.length)-1)]:null;
  return {...entry,total:sum(times,ms=>ms),median:at(.5),slow:at(.95)};
 }).sort((a,b)=>b.total-a.total);
 const shown=rows.slice(0,10),rest=rows.length-shown.length;
 const time=ms=>ms==null?'–':fmtMs(ms);
 return ['Tool','Calls','Failed','Median','95th','Total'].map(head=>`<h5>${head}</h5>`).join('')
  +shown.map(row=>`<b title="${esc(row.name)}">${esc(row.name)}</b><span>${row.count}</span><span class="${row.failed?'bad':''}">${row.failed||'–'}</span><span>${time(row.median)}</span><span>${time(row.slow)}</span><span>${time(row.total)}</span>`).join('')
  +(rest>0?`<b>${plural(rest,'other tool')}</b><span>${sum(rows.slice(10),row=>row.count)}</span><span></span><span></span><span></span><span>${time(sum(rows.slice(10),row=>row.total))}</span>`:'');
}
function fillTools(){
 const index=runById();
 for(const el of document.querySelectorAll('[data-tools]')){
  const runs=el.dataset.tools.split(',').map(id=>index.get(id)).filter(Boolean);
  const fresh=runs.every(run=>callCache.get(run.id)?.tools===run.tools||Date.now()-(callCache.get(run.id)?.at??0)<10_000);
  const calls=runs.flatMap(run=>callCache.get(run.id)?.calls??[]);
  if(calls.length){const markup=toolStats(calls);if(el._markup!==markup){el._markup=markup;el.innerHTML=markup;}}
  if(!fresh&&!el._loading){el._loading=true;Promise.all(runs.map(callsOf)).then(()=>{el._loading=false;fillTools();});}
 }
}

function laneHit(event,canvas){
 if(!canvas._items||!snap)return null;
 const box=canvas.getBoundingClientRect(),now=nowSec(),from=now-windowHours*3600;
 const t=from+(event.clientX-box.left)/box.width*(now-from),lane=Math.floor((event.clientY-box.top-PAD+LANE_GAP/2)/(LANE+LANE_GAP));
 const hit=canvas._items.find(item=>item.lane===lane&&t>=item.run.start&&t<=(item.run.end||now))??canvas._items.find(item=>t>=item.run.start&&t<=(item.run.end||now));
 return hit?{run:hit.run,t,now,from,box}:null;
}

/* ---------- timeline drawing ---------- */

const runById=()=>new Map(snap.runs.map(run=>[run.id,run]));
function ticks(from,now){
 const step={1:600,3:1800,6:3600,12:7200,24:14400}[windowHours]??3600,out=[];
 const offset=new Date().getTimezoneOffset()*60;
 for(let t=Math.ceil((from-offset)/step)*step+offset;t<now;t+=step)out.push(t);
 return out;
}

function drawLane(canvas,index,now,from){
 const items=lanes(canvas.dataset.runs.split(',').filter(Boolean).map(id=>index.get(id)).filter(Boolean));
 const laneCount=Number(canvas.dataset.lanes)||1;
 const {ctx,width,height}=setupCanvas(canvas,PAD*2+laneCount*LANE+(laneCount-1)*LANE_GAP);
 const x=t=>(t-from)/(now-from)*width;
 ctx.fillStyle=colors.line;
 for(const t of ticks(from,now))ctx.fillRect(Math.round(x(t)),0,1,height);
 for(const {run,lane} of items){
  const top=PAD+lane*(LANE+LANE_GAP),start=Math.max(0,x(run.start)),end=Math.min(width,x(run.end||now));
  if(end<=0)continue;
  ctx.fillStyle=colors.track;
  ctx.beginPath();ctx.roundRect(start,top,Math.max(2,end-start),LANE,3);ctx.fill();
  ctx.save();ctx.clip();
  for(const [s,e,cat] of run.segs){
   const a=Math.max(0,x(s)),b=Math.min(width,x(e||now));
   if(b<0)continue;
   ctx.fillStyle=colors.cats[cat];
   ctx.fillRect(a,top,Math.max(.75,b-a),LANE);
  }
  ctx.restore();
  for(const [t,type] of run.marks){const mx=x(t);if(mx<0)continue;ctx.fillStyle=type==='compact'?colors.warning:colors.text;ctx.fillRect(Math.round(mx),top-3,type==='compact'?2.5:1.5,LANE+6);}
 }
 canvas._items=items;
}

function drawAxis(v){
 const {ctx,width,height}=setupCanvas($('axis'),46);
 const {now,from}=v,x=t=>(t-from)/(now-from)*width;
 const slots=Math.max(1,Math.floor(width/3)),diff=new Float32Array(slots+1);
 for(const run of v.runs){
  let covered=0;
  for(const [s,e,cat] of run.segs){
   if(snap.cats[cat]==='idle')continue;
   const a=Math.max(covered,Math.floor(x(s)/3)),b=Math.min(slots,Math.ceil(x(e||now)/3));
   if(b>a){diff[a]++;diff[b]--;covered=b;}
  }
 }
 const counts=[];let level=0;
 for(let i=0;i<slots;i++){level+=diff[i];counts.push(level);}
 const peak=Math.max(1,...counts),areaHeight=26;
 ctx.fillStyle=colors.text3;ctx.globalAlpha=.35;
 counts.forEach((count,i)=>{if(count>0){const h=count/peak*areaHeight;ctx.fillRect(i*3,areaHeight-h,3,h);}});
 ctx.globalAlpha=1;
 ctx.font='11px system-ui,sans-serif';ctx.textBaseline='top';
 ctx.fillStyle=colors.text3;
 ctx.fillText(`agents active · peak ${Math.max(0,...counts)}`,0,0);
 ctx.textAlign='center';
 for(const t of ticks(from,now)){
  const tx=x(t);
  ctx.fillStyle=colors.line;ctx.fillRect(Math.round(tx),areaHeight,1,height-areaHeight);
  if(tx>20&&tx<width-20){ctx.fillStyle=colors.text3;ctx.fillText(fmtClock(t),tx,areaHeight+5);}
 }
 ctx.textAlign='right';ctx.fillStyle=colors.text2;ctx.fillText('now',width,areaHeight+5);
 ctx.textAlign='left';
}

function draw(){
 if(!snap)return;
 const v=view(),index=runById();
 drawAxis(v);
 for(const canvas of document.querySelectorAll('canvas.lane'))drawLane(canvas,index,v.now,v.from);
 drawBurn(v);
}

function tick(){
 const now=nowSec();
 $('clock').textContent=new Date().toLocaleTimeString([],{hour12:false});
 for(const el of document.querySelectorAll('[data-since]'))el.textContent=fmtDur(now-Number(el.dataset.since),'fine' in el.dataset);
 for(const el of document.querySelectorAll('[data-until]'))el.textContent=fmtDur(Number(el.dataset.until)-now);
 draw();
}

function render(){
 if(!snap)return;
 if(!colors.cats)readColors();
 const v=view();
 $('project').textContent=snap.project.name;
 $('version').textContent=snap.version?`v${snap.version}`:'';
 document.title=`${v.runs.filter(run=>run.status==='working').length} running · ${snap.project.name}`;
 renderTiles(v);renderLegend();renderRows(v);renderLists();renderPanelHead();fillTools();checkAlerts();
 refreshSnapLists();
 tick();
}

/* ---------- renaming a session ---------- */

let renaming=false;
document.addEventListener('click',event=>{
 const pencil=event.target.closest?.('[data-rename]');
 if(!pencil||renaming)return;
 const label=pencil.previousElementSibling,input=document.createElement('input');
 Object.assign(input,{className:'rename-input',value:pencil.dataset.name,maxLength:80});
 input.setAttribute('aria-label','New name. Leave empty for the automatic name.');
 renaming=true;
 label.replaceWith(input);pencil.hidden=true;
 input.focus();input.select();
 const finish=async save=>{
  if(!renaming)return;
  renaming=false;
  const name=input.value.trim();
  if(save&&name!==pencil.dataset.name){
   try{
    const response=await fetch('api/name',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({run:pencil.dataset.rename,name})});
    if(!response.ok)throw new Error();
    const run=snap.runs.find(run=>run.id===pencil.dataset.rename);
    const saved=(await response.json()).name;
    if(run&&saved){run.auto??=run.title;run.title=saved;}
    else if(run&&run.auto!=null){run.title=run.auto;delete run.auto;}
   }catch{raise('The name was not saved','The dashboard did not accept it.');}
  }
  // The rows were changed by hand, so what was last drawn no longer matches what is remembered.
  for(const id of ['flight','sessions','earlier'])delete html[id];
  render();
 };
 input.addEventListener('keydown',key=>{if(key.key==='Enter')finish(true);else if(key.key==='Escape')finish(false);});
 input.addEventListener('blur',()=>finish(true));
});

/* ---------- lists that scroll ---------- */

// A list longer than its limit shows that many rows, scrolls one row at a time, and gets a column of dots to step through it.
const SNAP_LISTS=[['#mem-rows',3],['#limits',4],['#agents-sub',3],['.list ul',6]],MAX_DOTS=8;
const rowTop=(rows,index)=>rows.children[index].offsetTop-rows.children[0].offsetTop;
function firstRowInView(rows){
 const last=rows.children.length-Number(rows.dataset.shown);
 let first=0;
 while(first<last&&rowTop(rows,first)<rows.scrollTop-1)first++;
 return first;
}
/** Cuts the list to exactly the rows in view, whatever their heights, so no slice of the next row shows. */
function fitSnapHeight(rows){
 const first=firstRowInView(rows),shown=Number(rows.dataset.shown);
 const end=first+shown<rows.children.length?rowTop(rows,first+shown)-parseFloat(getComputedStyle(rows).rowGap||0):rows.scrollHeight;
 rows.style.maxHeight=`${end-rowTop(rows,first)}px`;
}
function markSnapDots(rows){
 const dots=rows.nextElementSibling,count=rows.children.length,shown=Number(rows.dataset.shown);
 if(!dots?.classList.contains('snap-dots'))return;
 const first=firstRowInView(rows);
 // Up to MAX_DOTS rows get a dot each, lit while in view; a longer list gets MAX_DOTS dots, one lit for how far down it is.
 const lit=count<=MAX_DOTS?index=>index>=first&&index<first+shown:index=>index===Math.round(first*(MAX_DOTS-1)/(count-shown));
 [...dots.children].forEach((dot,index)=>dot.classList.toggle('on',lit(index)));
}
function refreshSnapLists(){
 for(const [selector,shown] of SNAP_LISTS)for(const rows of document.querySelectorAll(selector)){
  const count=rows.children.length,over=count>shown,host=rows.parentElement;
  let dots=rows.nextElementSibling?.classList.contains('snap-dots')?rows.nextElementSibling:null;
  rows.classList.toggle('snap-rows',over);
  if(!over){rows.style.maxHeight='';dots?.remove();continue;}
  rows.dataset.shown=shown;
  if(!dots){dots=document.createElement('div');dots.className='snap-dots';rows.after(dots);host.classList.add('snap-host');}
  const wanted=Math.min(count,MAX_DOTS);
  if(dots.childElementCount!==wanted)dots.innerHTML='<button aria-label="Scroll the list"></button>'.repeat(wanted);
  dots.style.top=`${rows.offsetTop+rows.offsetHeight/2}px`;
  if(!settling.has(rows))fitSnapHeight(rows);
  markSnapDots(rows);
 }
}
// Scroll events do not bubble, so they are caught on the way down.
// The height is refitted only once a scroll has come to rest: resizing a list mid-scroll stops the scroll.
const settling=new Map();
document.addEventListener('scroll',event=>{
 const rows=event.target;
 if(!rows.classList?.contains('snap-rows'))return;
 markSnapDots(rows);
 clearTimeout(settling.get(rows));
 settling.set(rows,setTimeout(()=>{settling.delete(rows);if(rows.isConnected&&rows.classList.contains('snap-rows'))fitSnapHeight(rows);},160));
},true);
document.addEventListener('click',event=>{
 const dot=event.target.closest?.('.snap-dots button');
 if(!dot)return;
 const dots=dot.parentElement,rows=dots.previousElementSibling,count=rows.children.length,last=count-Number(rows.dataset.shown);
 const index=[...dots.children].indexOf(dot),row=count<=MAX_DOTS?Math.min(index,last):Math.round(index*last/(MAX_DOTS-1));
 rows.scrollTo({top:rowTop(rows,row),behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'});
});

/* ---------- task panel ---------- */

function markdown(text){
 const inline=part=>esc(part).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>');
 const out=[];
 let list=false,code=false;
 const closeList=()=>{if(list){out.push('</ul>');list=false;}};
 for(const line of text.split(/\r?\n/)){
  if(/^```/.test(line)){closeList();out.push(code?'</pre>':'<pre>');code=!code;continue;}
  if(code){out.push(`${esc(line)}\n`);continue;}
  const heading=/^#{1,4}\s+(.*)/.exec(line);
  if(heading){closeList();out.push(`<h4>${inline(heading[1])}</h4>`);continue;}
  const item=/^\s*[-*]\s+(?:\[( |x)\]\s+)?(.*)/i.exec(line);
  if(item){
   if(!list){out.push('<ul>');list=true;}
   out.push(item[1]?`<li class="check">${item[1]===' '?'☐':'☑'} ${inline(item[2])}</li>`:`<li>${inline(item[2])}</li>`);
   continue;
  }
  closeList();
  if(line.trim())out.push(`<p>${inline(line)}</p>`);
 }
 closeList();
 if(code)out.push('</pre>');
 return out.join('');
}

function renderPanelHead(){
 if(!panel||!snap||panel.kind!=='card')return;
 const task=snap.tasks.find(item=>item.id===panel.id),runs=snap.runs.filter(run=>run.task===panel.id);
 if(!task){setHtml('panel-head',`<h2>${esc(panel.id)}</h2>`);return;}
 const fact=(label,value)=>value?`<span>${label} <b>${value}</b></span>`:'';
 const facts=[`<span class="pill ${task.phase}"><i></i>${PHASE_LABEL[task.phase]??task.phase}</span>`,task.pr?`<span>${prLink(task.pr)} ${task.pr.state.toLowerCase()}</span>`:'',fact('card status',esc(task.status)),fact('agent',esc(task.agent)),fact('risk',esc(task.risk)),fact('feature',esc(task.feature)),fact('waits on',esc(task.waitsOn.join(', '))),fact('unblocks',esc(task.unblocks.join(', ')))].join('');
 setHtml('panel-head',`<span class="id">${esc(task.id)}</span><h2>${esc(task.title)}</h2><div class="facts">${facts}</div>${runs.length?breakdown(runs,rollup(panel.id)):''}`);
}

async function openCall(runId,pick){
 const run=runById().get(runId);
 if(!run)return;
 const token={};
 panel={kind:'call',run:runId,token};
 $('panel').hidden=false;
 const calls=await callsOf(run);
 if(panel?.token!==token)return;
 if(!calls.length){setHtml('panel-head',`<h2>${esc(run.title||chip(run))}</h2>`);setHtml('panel-body','<p>This run has made no tool calls.</p>');return;}
 const index=typeof pick==='number'?Math.min(calls.length-1,Math.max(0,pick)):nearestCall(calls,pick.t*1000);
 const [start,end,cat,name,failed,label]=calls[index],category=snap.cats[cat];
 panel.index=index;
 const span=end?`${fmtClock(start/1000)} · took ${fmtMs(end-start)}`:`started ${fmtClock(start/1000)} · no result yet`;
 setHtml('panel-head',`<span class="id">${esc(run.task??(run.title||chip(run)))} · tool call ${index+1} of ${calls.length}</span><h2>${esc(name)}</h2><div class="facts"><span><i class="dot" style="--c:var(--cat-${category});display:inline-block;margin-right:6px"></i>${CAT_LABEL[category]}</span><span>${span}</span>${failed?'<span class="alert">▲ failed</span>':''}<span>${esc(chip(run))}</span></div><div class="nav"><button data-call-step="-1" ${index?'':'disabled'}>‹ Previous</button><button data-call-step="1" ${index<calls.length-1?'':'disabled'}>Next ›</button></div><div class="detail"><div class="tools" data-tools="${esc(runId)}"></div></div>`);
 fillTools();
 setHtml('panel-body','<p>Loading the call…</p>');
 let detail=null;
 try{const response=await fetch(`api/call?run=${encodeURIComponent(runId)}&i=${index}`);if(response.ok)detail=await response.json();}catch{}
 if(panel?.token!==token)return;
 const block=(title,text)=>`<h4>${title}</h4>${text?`<pre class="io">${esc(text)}</pre>`:'<p>Nothing recorded.</p>'}`;
 setHtml('panel-body',detail?block('Input',detail.input)+block('Output',detail.output):`<p>${esc(label)}</p><p>The transcript no longer has this call.</p>`);
 $('panel').scrollTop=0;
}
function nearestCall(calls,at){
 let best=0;
 for(let i=0;i<calls.length;i++){
  const [start,end]=calls[i];
  if(start<=at&&(end||Infinity)>=at)return i;
  if(Math.abs(start-at)<Math.abs(calls[best][0]-at))best=i;
 }
 return best;
}

const PR_STATE={OPEN:['Open','working'],DRAFT:['Draft',''],MERGED:['Merged','done'],CLOSED:['Closed','lost']};
const fmtWhen=ms=>new Date(ms).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
function diffMarkup(file){
 if(!file.lines.length)return '<p>No text diff for this file. It may be binary, renamed or too large.</p>';
 const kind=line=>line.startsWith('@@')?'h':line[0]==='+'?'a':line[0]==='-'?'d':'';
 return `<pre class="diff">${file.lines.map(line=>`<span class="${kind(line)}">${esc(line)||' '}</span>`).join('')}</pre>${file.more?`<p>${file.more} more lines not shown. Open the pull request on GitHub for the rest.</p>`:''}`;
}
async function openPr(number){
 const token={};
 panel={kind:'pr',number,token};
 $('panel').hidden=false;
 const task=snap.tasks.find(item=>item.pr?.number===number);
 setHtml('panel-head',`<span class="id">PR #${number}</span><h2>${esc(task?.title??'')}</h2>`);
 setHtml('panel-body','<p>Loading the pull request…</p>');
 let pr=null,problem='';
 try{const response=await fetch(`api/pr?n=${number}`),data=await response.json();if(response.ok)pr=data;else problem=data.error??'';}catch{}
 if(panel?.token!==token)return;
 if(!pr){setHtml('panel-body',`<p>Could not load the pull request.</p><p>${esc(problem)}</p>`);return;}
 panel.files=pr.files;
 const [stateLabel,stateClass]=PR_STATE[pr.state]??[pr.state,''];
 const failed=pr.checks.filter(check=>/fail|error|cancel|timed/.test(check.result)).length,pending=pr.checks.filter(check=>/pending|queued|progress|expected/.test(check.result)).length;
 const checks=pr.checks.length?`<span>checks <b>${failed?`${failed} failing`:pending?`${pending} running`:'passing'}</b></span>`:'';
 const facts=[`<span class="pill ${stateClass}"><i></i>${stateLabel}</span>`,task?`<button class="pr" data-card="${esc(task.id)}">${esc(task.id)}</button>`:'',`<span><b>${esc(pr.branch)}</b> into <b>${esc(pr.base)}</b></span>`,`<span><b class="add">+${pr.additions}</b> <b class="del">−${pr.deletions}</b> in ${plural(pr.files.length,'file')}</span>`,pr.decision?`<span>review <b>${esc(pr.decision)}</b></span>`:'',checks,`<span>opened ${fmtWhen(pr.created)}</span>`,pr.merged?`<span>merged ${fmtWhen(pr.merged)}</span>`:'',`<a href="${esc(pr.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>`].join('');
 setHtml('panel-head',`<span class="id">PR #${pr.number}</span><h2>${esc(pr.title)}</h2><div class="facts">${facts}</div>`);
 const checkList=pr.checks.length?`<h4>Checks</h4><ul>${pr.checks.map(check=>`<li>${esc(check.name)} · ${esc(check.result||'unknown')}</li>`).join('')}</ul>`:'';
 const notes=pr.notes.length?`<h4>Reviews and comments</h4>${pr.notes.map(note=>`<div class="note"><b>${esc(note.who)}</b><span>${esc(note.kind)} · ${fmtWhen(note.at)}</span>${markdown(note.body)}</div>`).join('')}`:'';
 // Diffs are drawn when a file is opened; the first files open on their own while they stay short.
 let budget=300;
 const files=pr.files.map((file,i)=>{
  const open=file.lines.length>0&&(budget-=file.lines.length)>=0;
  return `<details class="file" data-file="${i}" ${open?'open':''}><summary><b>${esc(file.path)}</b><span class="add">+${file.additions}</span><span class="del">−${file.deletions}</span></summary>${open?diffMarkup(file):''}</details>`;
 }).join('');
 setHtml('panel-body',`<h4>Description</h4>${pr.body.trim()?markdown(pr.body):'<p>No description.</p>'}${checkList}${notes}<h4>Files</h4>${files||'<p>No files changed.</p>'}`);
 $('panel').scrollTop=0;
}
document.addEventListener('toggle',event=>{
 const el=event.target;
 if(!el.matches?.('details.file')||!el.open||el.children.length>1||panel?.kind!=='pr')return;
 const file=panel.files?.[Number(el.dataset.file)];
 if(file)el.insertAdjacentHTML('beforeend',diffMarkup(file));
},true);

async function openPanel(id){
 panel={kind:'card',id};
 html['panel-head']=null;
 setHtml('panel-body','<p>Loading the card…</p>');
 $('panel').hidden=false;
 renderPanelHead();
 let card=null;
 try{const response=await fetch(`api/card?id=${encodeURIComponent(id)}`);if(response.ok)card=await response.json();}catch{}
 if(panel?.id!==id)return;
 setHtml('panel-body',card?`<p class="file">${esc(card.file)}</p>${markdown(card.body)}`:'<p>No card file for this task.</p>');
}
function closePanel(){panel=null;$('panel').hidden=true;}
$('panel-close').addEventListener('click',closePanel);
addEventListener('keydown',event=>{if(event.key==='Escape')closePanel();});
document.addEventListener('click',event=>{
 const expand=event.target.closest?.('[data-expand]'),card=event.target.closest?.('[data-card]'),step=event.target.closest?.('[data-call-step]'),lane=event.target.closest?.('canvas.lane'),pull=event.target.closest?.('[data-pr]');
 const hit=lane&&laneHit(event,lane);
 if(expand){const key=expand.dataset.expand;if(!expanded.delete(key))expanded.add(key);render();}
 else if(pull)openPr(Number(pull.dataset.pr));
 else if(card)openPanel(card.dataset.card);
 else if(step){if(panel?.kind==='call'&&!step.disabled)openCall(panel.run,panel.index+Number(step.dataset.callStep));}
 else if(hit)openCall(hit.run.id,{t:hit.t});
 else if(panel&&!event.target.closest?.('#panel'))closePanel();
});

/* ---------- alerts ---------- */

let alertMode=localStorage.getItem('alerts')??'off',alertKnown=null,audio=null;
const alerted=new Map();
function alertKeys(){
 const keys=new Map(),now=nowSec();
 for(const task of snap.tasks)if(task.phase==='needs-you')keys.set(`needs:${task.id}:${task.note}`,[`${task.id} needs you`,task.title]);
 for(const run of snap.runs){
  const name=run.task??(run.title||chip(run));
  if(run.status==='lost'&&now-run.last<3600)keys.set(`lost:${run.id}`,[`${name} stopped responding`,chip(run)]);
  else if(run.stalled)keys.set(`stalled:${run.id}`,[`${name} has had no output for a while`,chip(run)]);
  for(const warning of run.warn)keys.set(`warn:${run.id}:${warning.replace(/\d+/g,'')}`,[`${name}: ${warning}`,chip(run)]);
 }
 for(const limit of snap.limits)for(const window of limit.windows){
  const name=`${limit.account} ${window.label} limit`;
  if(window.used>=snap.config.limitWarn)keys.set(`limit:${name}`,[`${name} is at ${Math.round(window.used)}%`,'']);
  if(window.early&&window.fullAt>now)keys.set(`early:${name}`,[`${name} will fill before it resets`,`Full in about ${fmtDur(window.fullAt-now)} at this rate.`]);
 }
 return keys;
}
function beep(){
 try{
  audio??=new AudioContext();
  [660,880].forEach((frequency,i)=>{
   const tone=audio.createOscillator(),gain=audio.createGain(),at=audio.currentTime+i*.18;
   tone.frequency.value=frequency;
   gain.gain.setValueAtTime(.0001,at);gain.gain.exponentialRampToValueAtTime(.12,at+.02);gain.gain.exponentialRampToValueAtTime(.0001,at+.16);
   tone.connect(gain).connect(audio.destination);tone.start(at);tone.stop(at+.17);
  });
 }catch{}
}
function raise(title,body=''){
 if(typeof Notification!=='undefined'&&Notification.permission==='granted'){try{new Notification(title,{body,tag:title});}catch{}}
 if(alertMode==='sound')beep();
 const toast=document.createElement('button');
 toast.className='toast';
 toast.innerHTML=`<b>${esc(title)}</b><time>${fmtClock(nowSec())}</time><span>${esc(body)}</span>`;
 toast.addEventListener('click',()=>toast.remove());
 $('toasts').prepend(toast);
 setTimeout(()=>toast.remove(),90_000);
 while($('toasts').children.length>5)$('toasts').lastChild.remove();
}
function checkAlerts(){
 const keys=alertKeys(),now=nowSec();
 if(alertKnown&&alertMode!=='off')for(const [key,[title,body]] of keys){
  if(alertKnown.has(key)||now-(alerted.get(key)??0)<ALERT_REPEAT)continue;
  alerted.set(key,now);
  raise(title,body);
 }
 alertKnown=new Set(keys.keys());
}
function renderAlerts(){
 const blocked=typeof Notification==='undefined'||Notification.permission==='denied';
 $('alerts').title=alertMode==='off'?'Alert when a task needs you, an agent stops or goes in circles, or a usage limit runs hot':blocked?'Browser notifications are blocked for this page, so alerts show on the page only':'Alerts show as browser notifications and on the page';
 $('alerts').innerHTML='<span class="lbl">Alerts</span>'+['off','on','sound'].map(mode=>`<button aria-pressed="${mode===alertMode}" data-alert-choice="${mode}">${mode[0].toUpperCase()}${mode.slice(1)}</button>`).join('');
}
$('alerts').addEventListener('click',event=>{
 const choice=event.target.dataset?.alertChoice;
 if(!choice)return;
 alertMode=choice;localStorage.setItem('alerts',choice);
 renderAlerts();
 if(choice==='off')return;
 raise('Alerts are on',choice==='sound'?'With sound.':'Without sound.');
 // The permission prompt can stay open indefinitely, so nothing waits on it.
 if(typeof Notification!=='undefined'&&Notification.permission==='default')Notification.requestPermission().then(renderAlerts,()=>{});
});
renderAlerts();

/* ---------- theme ---------- */

function renderTheme(){
 const current=document.documentElement.dataset.theme??'auto';
 $('theme').innerHTML=['auto','light','dark'].map(theme=>`<button aria-pressed="${theme===current}" data-theme-choice="${theme}">${theme[0].toUpperCase()}${theme.slice(1)}</button>`).join('');
}
$('theme').addEventListener('click',event=>{
 const choice=event.target.dataset?.themeChoice;
 if(!choice)return;
 if(choice==='auto'){delete document.documentElement.dataset.theme;localStorage.removeItem('theme');}
 else{document.documentElement.dataset.theme=choice;localStorage.setItem('theme',choice);}
 renderTheme();readColors();renderSystem();draw();
});
renderTheme();

/* ---------- tooltip ---------- */

const tip=$('tip');
document.addEventListener('mousemove',event=>{
 const canvas=event.target.closest?.('canvas.lane');
 const hit=canvas&&laneHit(event,canvas);
 if(!hit){tip.hidden=true;return;}
 const {run,t,now,from,box}=hit,seg=run.segs.find(([s,e])=>t>=s&&t<=(e||now));
 const secondsPerPixel=(now-from)/box.width,mark=run.marks.find(([at])=>Math.abs(at-t)<4*secondsPerPixel);
 const lines=[`<b>${esc(run.title||chip(run))}</b>`,`<span>${esc(chip(run))}</span>`];
 if(seg){const cat=snap.cats[seg[2]],end=seg[1]||now;lines.push(`<span><i class="dot" style="--c:var(--cat-${cat})"></i>${CAT_LABEL[cat]} · ${fmtClock(seg[0])}–${seg[1]?fmtClock(end):'now'} · ${fmtDur(end-seg[0],true)}</span>`);if(!seg[1]&&run.label)lines.push(`<span>${esc(run.label)}</span>`);}
 if(mark)lines.push(`<span>${MARK_LABEL[mark[1]]} at ${fmtClock(mark[0])}</span>`);
 lines.push(`<span>${fmtClock(run.start)}–${run.end?fmtClock(run.end):'now'} · ${fmtTok(work(run))} tokens${run.cost!=null?` · ≈ ${fmtCost(run.cost)}`:''}</span>`,`<span>${effort(run)}</span>`);
 if(run.tools)lines.push('<span>Click to open the tool call</span>');
 tip.innerHTML=lines.join('');tip.hidden=false;
 const width=tip.offsetWidth,height=tip.offsetHeight;
 tip.style.left=`${Math.min(innerWidth-width-8,event.clientX+14)}px`;
 tip.style.top=`${event.clientY+18+height>innerHeight?event.clientY-height-10:event.clientY+18}px`;
});

/* ---------- wiring ---------- */

function renderWindow(){
 const max=snap?.config.hours??12,options=[1,3,6,12,24].filter(hours=>hours<=max);
 if(!options.includes(windowHours))windowHours=options.at(-1);
 $('window').innerHTML=options.map(hours=>`<button aria-pressed="${hours===windowHours}" data-hours="${hours}">${hours}h</button>`).join('');
}
$('window').addEventListener('click',event=>{
 const hours=Number(event.target.dataset?.hours);
 if(!hours)return;
 windowHours=hours;localStorage.setItem('window',hours);
 renderWindow();render();
});

const events=new EventSource('events');
events.onopen=()=>$('live').classList.remove('off');
events.onerror=()=>$('live').classList.add('off');
events.addEventListener('snap',event=>{if(!event.data)return;const first=!snap;snap=JSON.parse(event.data);if(first)renderWindow();render();});
events.addEventListener('machines',event=>{
 machines=JSON.parse(event.data);
 for(const peer of machines.peers){
  if(peer.history)peerHistory[peer.name]=peer.history;
  else if(peer.ok&&peer.cpu!=null){const history=peerHistory[peer.name]??=[];history.push([Date.now(),peer.cpu]);if(history.length>300)history.shift();}
 }
 renderSystem();
});
events.addEventListener('history',event=>{cpuHistory=JSON.parse(event.data);});
events.addEventListener('sys',event=>{sys=JSON.parse(event.data);cpuHistory.push([sys.t,sys.cpu]);if(cpuHistory.length>600)cpuHistory.shift();renderSystem();});
setInterval(tick,1000);
addEventListener('resize',draw);
