// Usage: node tools/demo.mjs [--port 4600]
// Writes an invented project with invented transcripts to a temporary folder and serves the dashboard on it.
import {spawn} from 'node:child_process';
import {mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeSlug} from '../lib/discover.mjs';

const root=join(tmpdir(),'agent-monitor-demo'),home=join(root,'home'),project=join(root,'orbit-shop');
const now=Date.now(),MIN=60_000,iso=ms=>new Date(ms).toISOString();
let seed=11;
const rand=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
const between=(low,high)=>Math.round(low+rand()*(high-low));
const save=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
const jsonl=(path,lines)=>save(path,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
rmSync(root,{recursive:true,force:true});

const CARDS=[
 ['T-101','Add cart totals endpoint','done','coder','task/T-101-cart-totals',41,[]],
 ['T-102','Paginate order history','in-review','coder','task/T-102-order-pages',42,[]],
 ['T-103','Retry failed webhook deliveries','claimed','coder','task/T-103-webhook-retries','',[]],
 ['T-104','Cache product search results','claimed','codex','task/T-104-search-cache','',[]],
 ['T-105','Fix timezone in invoice dates','changes-requested','coder','task/T-105-invoice-dates',43,[]],
 ['T-106','Export orders as CSV','ready','','','',['T-102']],
 ['T-107','Rotate API signing keys','ready','','','',[],'manual'],
 ['T-108','Dark mode for the admin pages','proposed','','','',[]],
];
for(const [id,title,status,agent,branch,pr,deps,dispatch] of CARDS){
 save(join(project,'tasks',`${id}.md`),`---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\nagent: ${agent}\nbranch: ${branch}\npr: ${pr}\ndepends_on: [${deps.join(', ')}]\n${dispatch?`dispatch: ${dispatch}\n`:''}---\n`);
}

/** The work loop an invented agent repeats: [tool, input, seconds, fails]. */
const steps=area=>[
 ['Read',{file_path:`src/${area}/index.ts`},2],
 ['Grep',{pattern:area,path:'src'},3],
 ['Read',{file_path:`src/${area}/store.ts`},2],
 ['Edit',{file_path:`src/${area}/index.ts`},5],
 ['Bash',{command:`npm test -- ${area}`},between(25,70)],
 ['Edit',{file_path:`tests/${area}.test.ts`},6],
 ['Bash',{command:'npm run build'},between(20,40)],
 ['Bash',{command:`git commit -am "Update ${area}"`},3],
];

function claudeRun(path,{start,end,prompt,model,area,context=40_000,compactAt,live,loop=steps(area)}){
 const lines=[{type:'user',timestamp:iso(start),message:{role:'user',content:prompt}}];
 let t=start,n=0,size=context;
 const usage=()=>({input_tokens:between(300,1500),cache_creation_input_tokens:between(1500,5000),cache_read_input_tokens:size,output_tokens:between(150,900)});
 const say=(content,stop='tool_use')=>lines.push({type:'assistant',timestamp:iso(t),message:{id:`m${n}`,model,stop_reason:stop,usage:usage(),content}});
 for(;;){
  const [name,input,seconds,fails]=loop[n%loop.length];
  t+=between(4,35)*1000;
  if(t>=end)break;
  if(compactAt&&t>=compactAt){lines.push({type:'system',subtype:'compact_boundary',timestamp:iso(t)});size=Math.round(size*.4);compactAt=0;}
  n++;size+=between(2500,7000);
  say([{type:'tool_use',id:`t${n}`,name,input}]);
  t+=seconds*1000;
  if(t>=end){if(!live)lines.pop();break;}
  lines.push({type:'user',timestamp:iso(t),message:{role:'user',content:[{type:'tool_result',tool_use_id:`t${n}`,is_error:Boolean(fails),content:fails?'3 tests failed':'ok'}]}});
 }
 if(!live){t=end;n++;say([{type:'text',text:'Done. Tests and build pass.'}],'end_turn');}
 jsonl(path,lines);
}

/** Usage limits that rise through the last hours, so the forecast has a trend to show. */
const limits=ts=>({plan_type:'pro',
 primary:{used_percent:Math.round(Math.max(20,74-(now-ts)/MIN*.38)),window_minutes:300,resets_at:Math.round((now+95*MIN)/1000)},
 secondary:{used_percent:Math.round(Math.max(40,57-(now-ts)/MIN*.03)),window_minutes:10080,resets_at:Math.round((now+3.2*1440*MIN)/1000)}});

function codexRun(name,{start,end,prompt,area,live}){
 const item=(ts,type,payload)=>({timestamp:iso(ts),type,payload});
 const lines=[item(start,'session_meta',{id:name,session_id:name,cwd:project,originator:'codex_exec',source:'exec',timestamp:iso(start)}),
  item(start,'turn_context',{model:'gpt-6.1-sol',effort:'high'}),
  item(start,'response_item',{type:'message',role:'user',content:[{type:'input_text',text:prompt}]})];
 const loop=[`sed -n 1,80p src/${area}/index.ts`,`rg ${area} src`,'apply_patch',`npm test -- ${area}`,'git status','npm run build'];
 let t=start,n=0,input=0,cached=0,out=0,last=30_000;
 for(;;){
  const cmd=loop[n%loop.length];
  t+=between(5,30)*1000;
  if(t>=end)break;
  n++;
  lines.push(item(t,'response_item',{type:'custom_tool_call',call_id:`c${n}`,name:'exec',input:cmd==='apply_patch'?'apply_patch':`text(await tools.exec_command({cmd:"${cmd}"}))`}));
  t+=(/npm/.test(cmd)?between(20,60):between(2,6))*1000;
  if(t>=end){if(!live)lines.pop();break;}
  lines.push(item(t,'response_item',{type:'custom_tool_call_output',call_id:`c${n}`,output:[JSON.stringify({exit_code:0,output:'ok'})]}));
  cached+=last;last+=between(1500,4000);input+=last;out+=between(200,900);
  lines.push(item(t,'event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:out},last_token_usage:{input_tokens:last},model_context_window:400_000},rate_limits:limits(t)}));
 }
 if(!live)lines.push(item(end,'event_msg',{type:'task_complete',last_agent_message:'Approved. Tests and build pass.'}));
 jsonl(join(home,'.codex','sessions','2026','01','01',`rollout-${name}.jsonl`),lines);
}

const session=join(home,'.claude','projects',claudeSlug(project),'demo-session');
let agents=0;
function subagent(description,agentType,options){
 const path=join(session,'subagents',`agent-${++agents}.jsonl`);
 claudeRun(path,{model:'claude-opus-5-5',...options});
 save(path.replace(/\.jsonl$/,'.meta.json'),JSON.stringify({description,agentType,finished:!options.live}));
}
const ago=minutes=>now-minutes*MIN,soon=now-15_000;

subagent('Coder T-101 cart totals','coder',{start:ago(230),end:ago(190),prompt:'Act as Coder for T-101',area:'cart'});
subagent('Coder T-102 order pages','coder',{start:ago(150),end:ago(95),prompt:'Act as Coder for T-102',area:'orders'});
subagent('Coder T-105 invoice dates','coder',{start:ago(125),end:ago(100),prompt:'Act as Coder for T-105',area:'invoices'});
subagent('Reviewer T-105 PR 43','reviewer',{start:ago(92),end:ago(80),prompt:'Act as Reviewer for PR #43 (T-105)',area:'invoices'});
subagent('Coder T-103 webhook retries','coder',{start:ago(70),end:soon,live:true,prompt:'Act as Coder for T-103',area:'webhooks',context:240_000,compactAt:ago(28)});
subagent('Coder T-105 fix round 2','coder',{start:ago(22),end:soon,live:true,prompt:'Act as Coder for T-105, fix round 2',area:'invoices',context:90_000,
 loop:[['Bash',{command:'npm test -- invoices'},40,true]]});
codexRun('review-101',{start:ago(185),end:ago(170),prompt:'act as Reviewer for PR #41 (T-101)',area:'cart'});
codexRun('code-104',{start:ago(48),end:soon,live:true,prompt:'act as Coder for T-104',area:'search'});
codexRun('review-102',{start:ago(14),end:soon,live:true,prompt:'act as Reviewer for PR #42 (T-102)',area:'orders'});
claudeRun(`${session}.jsonl`,{start:ago(235),end:soon,live:true,prompt:'Plan the next wave of order work and dispatch it',model:'claude-fable-5-2',context:120_000,
 loop:[['Read',{file_path:'tasks/T-106.md'},2],['Agent',{description:'Coder T-103 webhook retries'},between(900,1500)],['Bash',{command:'git status'},2],['Agent',{description:'Reviewer T-105 PR 43'},between(600,900)]]});
save(join(home,'.agent-monitor','claude-limits.json'),JSON.stringify({asOf:now,rate_limits:{
 five_hour:{used_percentage:46,resets_at:Math.round((now+140*MIN)/1000)},seven_day:{used_percentage:83,resets_at:Math.round((now+2.1*1440*MIN)/1000)}}}));

const port=process.argv.includes('--port')?process.argv[process.argv.indexOf('--port')+1]:'4600';
console.log(`Demo data written to ${root}`);
spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'..','server.mjs'),project,'--no-gh','--port',port],
 {stdio:'inherit',env:{...process.env,HOME:home,USERPROFILE:home}});
