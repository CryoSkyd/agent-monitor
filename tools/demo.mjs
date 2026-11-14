// Usage: node tools/demo.mjs [--theme theme.json] [--port 4600]
// Serves the dashboard on an invented project whose agents keep working: transcripts and task cards are written to a temporary folder as time passes.
// A theme file names the project and its tasks: {"name": "my-project", "tasks": [{"title": "Add cart totals endpoint", "area": "cart"}]}
// It may also rename the two roles: {"roles": {"worker": "pilot", "checker": "mission-reviewer"}}
import {spawn} from 'node:child_process';
import {appendFileSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeSlug} from '../lib/discover.mjs';

const DEFAULT={name:'orbit-shop',tasks:[
 ['Add cart totals endpoint','cart'],['Paginate order history','orders'],['Retry failed webhook deliveries','webhooks'],['Cache product search results','search'],
 ['Fix timezone in invoice dates','invoices'],['Export orders as CSV','exports'],['Rotate API signing keys','auth'],['Dark mode for the admin pages','admin'],
 ['Validate shipping addresses','shipping'],['Send low-stock alerts','inventory'],['Apply discount codes at checkout','checkout'],['Resize product images on upload','media'],
].map(([title,area])=>({title,area}))};

const args=process.argv.slice(2),flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const given=flag('--theme')?JSON.parse(readFileSync(flag('--theme'),'utf8')):DEFAULT;
const word=(text,fallback)=>String(text??'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||fallback;
const theme={name:word(given.name,'demo'),tasks:(given.tasks??[]).filter(task=>task?.title).map(task=>({title:String(task.title).replace(/\s+/g,' '),area:word(task.area,'core')}))};
// The dashboard shows a task as in review while a live run's role contains "review", so the checker's name keeps that word.
const worker=word(given.roles?.worker,'coder'),checker=/review/.test(word(given.roles?.checker,''))?word(given.roles.checker):'reviewer';
const title=name=>name[0].toUpperCase()+name.slice(1);
if(theme.tasks.length<4){console.error('A theme needs a name and at least 4 tasks, each with a title and an area.');process.exit(2);}

const root=join(tmpdir(),'agent-monitor-demo'),home=join(root,'home'),project=join(root,theme.name);
const MIN=60_000,HOUR=60*MIN,iso=ms=>new Date(ms).toISOString();
const between=(low,high)=>Math.round(low+Math.random()*(high-low));
const save=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
rmSync(root,{recursive:true,force:true});

/* ---------- task cards ---------- */
const cards=[];
let nextId=101,nextPr=41;
function saveCard(card){
 save(join(project,'tasks',`${card.id}.md`),`---\nid: ${card.id}\ntitle: ${card.title}\nstatus: ${card.status}\nagent: ${card.agent}\nbranch: ${card.branch}\npr: ${card.pr}\ndepends_on: [${card.deps.join(', ')}]\n${card.manual?'dispatch: manual\n':''}---\n`);
}
function addCard(status){
 const index=nextId-101,{title,area}=theme.tasks[index%theme.tasks.length];
 const card={id:`T-${nextId++}`,title,area,status,agent:'',branch:'',pr:'',round:1,manual:index===6,deps:index===5?[`T-${nextId-2}`]:[]};
 cards.push(card);saveCard(card);
 return card;
}
const done=id=>cards.find(card=>card.id===id)?.status==='done';
const roleFor=card=>card.status==='in-review'?'reviewer':card.status==='changes-requested'||(card.status==='ready'&&!card.manual&&card.deps.every(done))?'coder':null;

/* ---------- transcripts ---------- */
const turn=value=>typeof value==='function'?value():value;
const work=(area,flaky=0)=>[
 ['Read',{file_path:`src/${area}/index.ts`},2],['Grep',{pattern:area,path:'src'},3],['Read',{file_path:`src/${area}/store.ts`},2],['Edit',{file_path:`src/${area}/index.ts`},5],
 ['Bash',{command:`npm test -- ${area}`},()=>between(25,70),flaky],['Edit',{file_path:`tests/${area}.test.ts`},6],['Bash',{command:'npm run build'},()=>between(20,40)],
 ['Bash',{command:`git commit -am "Update ${area}"`},3],
];

function* claudeLines({start,end,prompt,model,loop,context=40_000}){
 let t=start,n=0,size=context;
 const usage=()=>({input_tokens:between(300,1500),cache_creation_input_tokens:between(1500,5000),cache_read_input_tokens:size,output_tokens:between(150,900)});
 const say=(content,stop)=>[t,{type:'assistant',timestamp:iso(t),message:{id:`m${n}`,model,stop_reason:stop,usage:usage(),content}}];
 yield [t,{type:'user',timestamp:iso(t),message:{role:'user',content:prompt}}];
 for(;;){
  const [name,input,seconds,fails]=loop[n%loop.length];
  t+=between(4,35)*1000;
  if(t>=end)break;
  if(size>600_000){yield [t,{type:'system',subtype:'compact_boundary',timestamp:iso(t)}];size=Math.round(size*.3);}
  n++;size+=between(2500,7000);
  yield say([{type:'tool_use',id:`t${n}`,name,input}],'tool_use');
  t+=turn(seconds)*1000;
  const failed=Math.random()<(fails??0);
  yield [t,{type:'user',timestamp:iso(t),message:{role:'user',content:[{type:'tool_result',tool_use_id:`t${n}`,is_error:failed,content:failed?'3 tests failed':'ok'}]}}];
 }
 n++;
 yield say([{type:'text',text:'Done. Tests and build pass.'}],'end_turn');
}

/** A usage limit that climbs through its window and resets, so the meters and the forecast keep moving. */
function limit(t,period,peak,phase){
 const turns=t/period+phase;
 return {used:Math.round(6+(turns%1)*peak),resets:Math.round((Math.floor(turns)+1-phase)*period/1000)};
}
function codexLimits(t){
 const short=limit(t,5*HOUR,80,.15),week=limit(t,168*HOUR,70,.4);
 return {plan_type:'pro',primary:{used_percent:short.used,window_minutes:300,resets_at:short.resets},secondary:{used_percent:week.used,window_minutes:10080,resets_at:week.resets}};
}
function saveClaudeLimits(t){
 const short=limit(t,5*HOUR,60,.6),week=limit(t,168*HOUR,85,.75);
 save(join(home,'.agent-monitor','claude-limits.json'),JSON.stringify({asOf:t,rate_limits:{five_hour:{used_percentage:short.used,resets_at:short.resets},seven_day:{used_percentage:week.used,resets_at:week.resets}}}));
}

function* codexLines({start,end,prompt,area,name}){
 const item=(type,payload)=>[t,{timestamp:iso(t),type,payload}];
 const loop=[`sed -n 1,80p src/${area}/index.ts`,`rg ${area} src`,'apply_patch',`npm test -- ${area}`,'git status','npm run build'];
 let t=start,n=0,input=0,cached=0,out=0,last=30_000;
 yield item('session_meta',{id:name,session_id:name,cwd:project,originator:'codex_exec',source:'exec',timestamp:iso(start)});
 yield item('turn_context',{model:'gpt-6.1-sol',effort:'high'});
 yield item('response_item',{type:'message',role:'user',content:[{type:'input_text',text:prompt}]});
 for(;;){
  const cmd=loop[n%loop.length];
  t+=between(5,30)*1000;
  if(t>=end)break;
  n++;
  yield item('response_item',{type:'custom_tool_call',call_id:`c${n}`,name:'exec',input:cmd==='apply_patch'?'apply_patch':`text(await tools.exec_command({cmd:"${cmd}"}))`});
  t+=(/npm/.test(cmd)?between(20,60):between(2,6))*1000;
  yield item('response_item',{type:'custom_tool_call_output',call_id:`c${n}`,output:[JSON.stringify({exit_code:0,output:'ok'})]});
  cached+=last;last+=between(1500,4000);input+=last;out+=between(200,900);
  yield item('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:out},last_token_usage:{input_tokens:last},model_context_window:400_000},rate_limits:codexLimits(t)});
 }
 yield item('event_msg',{type:'task_complete',last_agent_message:'Done. Tests and build pass.'});
}

/** Writes a transcript line by line as its timestamps come due, so a tool call stays open until its result time. */
class Writer{
 constructor(path,lines){this.path=path;this.lines=lines;this.next=lines.next();mkdirSync(dirname(path),{recursive:true});}
 /** Returns true once the transcript is complete. */
 advance(now){
  let text='';
  while(!this.next.done&&this.next.value[0]<=now){text+=JSON.stringify(this.next.value[1])+'\n';this.next=this.lines.next();}
  if(text)appendFileSync(this.path,text);
  return this.next.done;
 }
}

/* ---------- the invented team ---------- */
const session=join(home,'.claude','projects',claudeSlug(project),'demo-session');
const active=[];
let runs=0,nextStart=0,architect;

function startAgent(card,role,now){
 const codex=Math.random()<(role==='reviewer'?.6:.35),review=role==='reviewer',number=++runs;
 const end=now+(review?between(6,14):between(18,45))*MIN;
 if(!review){
  if(card.status==='changes-requested')card.round++;
  Object.assign(card,{status:'claimed',agent:codex?'codex':worker,branch:`task/${card.id}-${card.area}`});
  saveCard(card);
 }
 const round=card.round>1&&!review?`, fix round ${card.round}`:'';
 const prompt=review?`Act as ${title(checker)} for PR #${card.pr} (${card.id})`:`Act as ${title(worker)} for ${card.id}${round}`;
 let writer,meta=null;
 if(codex)writer=new Writer(join(home,'.codex','sessions','2026','01','01',`rollout-${number}.jsonl`),codexLines({start:now,end,prompt:prompt.replace('Act','act'),area:card.area,name:`demo-${number}`}));
 else{
  const path=join(session,'subagents',`agent-${number}.jsonl`);
  // Now and then an agent gets stuck rerunning a failing test, which is what the dashboard's warnings are for.
  const loop=!review&&Math.random()<.15?[['Bash',{command:`npm test -- ${card.area}`},40,1]]:work(card.area,card.round>1?.5:.1);
  writer=new Writer(path,claudeLines({start:now,end,prompt,model:'claude-opus-5-5',loop,context:between(40_000,250_000)}));
  meta={path:path.replace(/\.jsonl$/,'.meta.json'),description:review?`${title(checker)} ${card.id} PR ${card.pr}`:`${title(worker)} ${card.id} ${card.area}${round}`,agentType:review?checker:worker};
  save(meta.path,JSON.stringify({...meta,path:undefined,finished:false}));
 }
 active.push({card,role,writer,meta});
}

function finish({card,role,meta}){
 if(meta)save(meta.path,JSON.stringify({...meta,path:undefined,finished:true}));
 if(role==='coder'){card.pr||=nextPr++;card.status='in-review';}
 else card.status=card.round<2&&Math.random()<.25?'changes-requested':'done';
 saveCard(card);
}

function tick(now){
 for(const agent of [...active]){
  if(!agent.writer.advance(now))continue;
  active.splice(active.indexOf(agent),1);
  finish(agent);
 }
 architect.advance(now);
 saveClaudeLimits(now);
 const count=status=>cards.filter(card=>card.status===status&&!card.manual).length;
 while(count('ready')<2){const waiting=cards.find(card=>card.status==='proposed');if(waiting){waiting.status='ready';saveCard(waiting);}else addCard('ready');}
 while(count('proposed')<2)addCard('proposed');
 if(active.length>=4||now<nextStart)return;
 const card=cards.find(card=>roleFor(card)&&!active.some(agent=>agent.card===card));
 if(!card)return;
 startAgent(card,roleFor(card),now);
 nextStart=now+between(30,240)*1000;
}

const started=Date.now(),history=3*HOUR;
architect=new Writer(`${session}.jsonl`,claudeLines({start:started-history,end:Infinity,prompt:`Plan the next wave of ${theme.name} work and dispatch it`,model:'claude-fable-5-2',context:120_000,
 loop:[['Glob',{pattern:'tasks/*.md'},2],['Agent',{description:`${title(worker)} for the next ready task`},()=>between(600,1500)],['Bash',{command:'git status'},2],['Agent',{description:`${title(checker)} for the open pull request`},()=>between(400,900)]]}));
for(let i=0;i<6;i++)addCard('ready');
for(let t=started-history;t<started;t+=15_000)tick(t);
setInterval(()=>tick(Date.now()),2000);

console.log(`Demo project "${theme.name}" with ${theme.tasks.length} task topics, written to ${root}`);
const server=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'..','server.mjs'),project,'--no-gh','--port',flag('--port')??'4600'],
 {stdio:'inherit',env:{...process.env,HOME:home,USERPROFILE:home}});
server.on('exit',code=>process.exit(code??0));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.kill();process.exit(0);});
