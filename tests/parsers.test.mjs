import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {ensureSecret,isLoopback,makeGate,makeSecretCheck} from '../lib/auth.mjs';
import {Peers,mergeBurn,mergeLimits} from '../lib/peers.mjs';
import {promptName} from '../lib/monitor.mjs';
import {Hidden,Names} from '../lib/names.mjs';
import {makeClassifier} from '../lib/classify.mjs';
import {makePricer} from '../lib/prices.mjs';
import {parseCard} from '../lib/cards.mjs';
import {LimitHistory} from '../lib/forecast.mjs';
import {splitDiff} from '../lib/github.mjs';
import {TOOL_STALE} from '../lib/run.mjs';
import {ClaudeRun,claudeWindow,parseUsage} from '../lib/agents/claude.mjs';

test('the plan limit lines of /usage are read with their reset times',()=>{
 const text='You are currently using your subscription\n\nCurrent session: 12% used · resets Nov 20, 9pm (America/Los_Angeles)\nCurrent week (all models): 55% used · resets Nov 23, 10:59pm (America/Los_Angeles)\nCurrent week (Fable): 17% used · resets Jan 2, 11pm (UTC)\n\nLast 24h · 4762 requests';
 assert.deepEqual(parseUsage(text,Date.UTC(2026,10,20)),{
  five_hour:{used_percentage:12,resets_at:Date.UTC(2026,10,21,5)/1000},
  seven_day:{used_percentage:55,resets_at:Date.UTC(2026,10,24,6,59)/1000},
  seven_day_fable:{used_percentage:17,resets_at:Date.UTC(2027,0,2,23)/1000}});
 assert.equal(parseUsage('Not logged in'),null);
});
import {CodexRun} from '../lib/agents/codex.mjs';
import {apply,plan} from '../lib/setup.mjs';
import {CATS} from '../lib/timeline.mjs';

const shared=()=>({burn:new Map(),limits:new Map(),classify:makeClassifier(),price:makePricer({'model-a':{in:1,out:10,cached:.1}}),isProject:()=>true});
const at=second=>new Date(Date.UTC(2026,0,1,0,0,second)).toISOString();
function transcript(lines){
 const path=join(mkdtempSync(join(tmpdir(),'agent-monitor-')),'run.jsonl');
 writeFileSync(path,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
 return path;
}
const cats=run=>run.tl.segs.map(([start,end,cat])=>`${CATS[cat]}:${(end-start)/1000}`);

test('a Claude transcript becomes thinking, tool and idle segments with deduplicated usage',()=>{
 const usage={input_tokens:10,cache_creation_input_tokens:90,cache_read_input_tokens:1000,output_tokens:50};
 const run=new ClaudeRun(transcript([
  {type:'user',timestamp:at(0),message:{role:'user',content:'Act as Coder for T-12'}},
  {type:'assistant',timestamp:at(5),message:{id:'m1',model:'model-a',stop_reason:'tool_use',usage,content:[{type:'thinking',thinking:''}]}},
  {type:'assistant',timestamp:at(5),message:{id:'m1',model:'model-a',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'node --test tests/a.test.ts'}}]}},
  {type:'user',timestamp:at(35),message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'ok'}]}},
  {type:'assistant',timestamp:at(40),message:{id:'m2',model:'model-a',stop_reason:'end_turn',usage,content:[{type:'text',text:'Done.'}]}},
 ]),shared(),{id:'s'});
 run.poll();
 assert.deepEqual(cats(run),['thinking:5','testing:30','thinking:5']);
 assert.equal(run.tl.cur.c,'idle');
 assert.deepEqual(run.tokens,{in:200,cached:2000,out:100});
 assert.equal(run.prompt,'Act as Coder for T-12');
 assert.deepEqual([run.requests,run.turns],[2,1]);
 const call=run.detail(0);
 assert.deepEqual([call.name,call.input,call.output,call.e-call.s],['$ node','command: node --test tests/a.test.ts','ok',30_000]);
 // Per request: 10 input + 90 five-minute cache writes at 1.25x + 1000 cached at 0.1 + 50 output at 10, per million.
 assert.ok(Math.abs(run.cost-2*(10+90*1.25+1000*.1+50*10)/1e6)<1e-12);
});

test('a Codex exec transcript ends at task_complete and reports the account limits',()=>{
 const state=shared();
 const run=new CodexRun(transcript([
  {timestamp:at(0),type:'session_meta',payload:{id:'a',session_id:'a',cwd:'/repo',originator:'codex_exec',source:'exec',timestamp:at(0)}},
  {timestamp:at(0),type:'turn_context',payload:{model:'model-b',effort:'high'}},
  {timestamp:at(1),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'# AGENTS.md instructions for /repo'}]}},
  {timestamp:at(1),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'act as Reviewer for PR #7'}]}},
  {timestamp:at(4),type:'response_item',payload:{type:'custom_tool_call',call_id:'c1',name:'exec',input:'text(await tools.exec_command({cmd:"git push -u origin task/x"}))'}},
  {timestamp:at(9),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'c1',output:[]}},
  {timestamp:at(10),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:500,cached_input_tokens:400,output_tokens:20},last_token_usage:{input_tokens:300},model_context_window:1000},rate_limits:{plan_type:'pro',primary:{used_percent:42,window_minutes:10080,resets_at:1}}}},
  {timestamp:at(12),type:'event_msg',payload:{type:'task_complete',last_agent_message:'Approved.'}},
 ]),state,{account:'codex'});
 run.poll();
 assert.deepEqual(cats(run),['thinking:3','git:5','thinking:3']);
 assert.equal(run.ended,Date.parse(at(12)));
 assert.deepEqual(run.marks.map(([,type])=>type),['push']);
 assert.deepEqual(run.tokens,{in:100,cached:400,out:20});
 assert.equal(run.prompt,'act as Reviewer for PR #7');
 assert.equal(run.unpriced,true);
 assert.deepEqual(state.limits.get('codex').windows.map(window=>[window.label,window.used]),[['week',42]]);
});

test('a Claude context window is 1M on current models, and on older ones only once a request has outgrown 200K',()=>{
 const table=[['claude-fable-5-2',10,1e6],['claude-opus-5-5',10,1e6],['claude-opus-4-7',10,1e6],['claude-sonnet-5',10,1e6],['claude-haiku-5-5',10,1e6],
  ['claude-opus-4-6',10,2e5],['claude-sonnet-4-6',250_000,1e6],['claude-haiku-4-5',10,2e5],['',10,2e5]];
 for(const [model,used,size] of table)assert.equal(claudeWindow(model,used),size,model);
});

test('commands are classified by what they do',()=>{
 const {command}=makeClassifier('scripts[\\\\/]whole-games');
 const table={'cargo test -p engine':'testing','node scripts/whole-games.mjs --games 10':'testing','gh pr create --base main':'git','Get-Content AGENTS.md':'reading','rm -rf dist':'command'};
 for(const [cmd,cat] of Object.entries(table))assert.equal(command(cmd).cat,cat,cmd);
});

test('a card front matter gives fields and lists',()=>{
 assert.deepEqual(parseCard('---\nid: T-1\nstatus: ready   # note\ndepends_on: [T-2, T-3]\n---\nbody'),{id:'T-1',status:'ready',depends_on:['T-2','T-3']});
 assert.equal(parseCard('no front matter'),null);
});

test('a run counts failed calls, repeat reads and compactions, and warns about a call repeated in a row',()=>{
 const call=(second,id,name,input)=>({type:'assistant',timestamp:at(second),message:{id:`m${id}`,model:'model-a',stop_reason:'tool_use',content:[{type:'tool_use',id,name,input}]}});
 const result=(second,id,failed)=>({type:'user',timestamp:at(second),message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:failed,content:''}]}});
 const read={file_path:'/repo/a.ts'};
 const run=new ClaudeRun(transcript([
  {type:'user',timestamp:at(0),message:{role:'user',content:'go'}},
  call(1,'a','Read',read),result(2,'a',false),
  call(3,'b','Edit',{file_path:'/repo/a.ts'}),result(4,'b',true),
  call(5,'c','Read',read),result(6,'c',false),
  {type:'system',subtype:'compact_boundary',timestamp:at(7)},
  call(8,'d','Read',read),result(9,'d',false),
  call(10,'e','Read',read),result(11,'e',false),
  call(12,'f','Read',read),result(13,'f',false),
 ]),shared(),{id:'s'});
 run.poll();
 // Reads after the edit and after the compaction start fresh; only the two after that repeat.
 assert.deepEqual([run.errors,run.rereads,run.compactions],[1,2,1]);
 assert.deepEqual(run.marks.map(([,type])=>type),['compact']);
 assert.deepEqual(run.warnings(),['same call 4 times in a row']);
});

test('a limit trend measures the rise since the latest reset and goes quiet without fresh readings',()=>{
 const history=new LimitHistory(),minute=60_000,start=Date.UTC(2026,0,1);
 for(const [at,used] of [[0,90],[10,95],[20,4],[30,8],[50,16]])history.add('codex','5h',start+at*minute,used);
 const trend=history.trend('codex','5h',start+55*minute);
 assert.equal(Math.round(trend.rate),24);
 assert.equal(trend.used,16);
 assert.equal(history.trend('codex','5h',start+90*minute),null);
 assert.equal(history.trend('codex','week',start+55*minute),null);
 assert.equal(history.rise('codex','5h',start,start+55*minute),21);
 assert.equal(history.rise('codex','5h',start+25*minute,start+55*minute),8);
 assert.equal(history.rise('codex','5h',start+60*minute,start+90*minute),null);
});

test('a diff splits into files with their hunks, and long files are cut',()=>{
 const diff=['diff --git a/src/a.ts b/src/a.ts','index 1..2 100644','--- a/src/a.ts','+++ b/src/a.ts','@@ -1,2 +1,2 @@',' keep','-old','+new',
  'diff --git a/gone.txt b/gone.txt','deleted file mode 100644','--- a/gone.txt','+++ /dev/null','@@ -1 +0,0 @@','-bye',
  'diff --git a/logo.png b/logo.png','Binary files differ',''].join('\r\n');
 assert.deepEqual(splitDiff(diff,3),[
  {path:'src/a.ts',lines:['@@ -1,2 +1,2 @@',' keep','-old'],more:1},
  {path:'gone.txt',lines:['@@ -1 +0,0 @@','-bye'],more:0},
  {path:'logo.png',lines:[],more:0},
 ]);
});

test('requests relayed by a tunnel need the password, local ones do not, and repeated wrong passwords lock the visitor out',async ()=>{
 let clock=0;
 const basic=secret=>({authorization:`Basic ${Buffer.from(`me:${secret}`).toString('base64')}`});
 const gate=makeGate({password:'right:one',now:()=>clock}),remote={'cf-connecting-ip':'203.0.113.9'};
 assert.equal(await gate({}),'ok');
 assert.equal(await makeGate()(remote),'closed');
 assert.equal(await makeGate()({'x-forwarded-for':'203.0.113.9'}),'closed');
 assert.equal(await gate(remote),'login');
 assert.equal(await gate({...remote,...basic('right:one')}),'ok');
 for(let i=0;i<5;i++)assert.equal(await gate({...remote,...basic('wrong')}),'login');
 assert.equal(await gate({...remote,...basic('right:one')}),'locked');
 assert.equal(await gate({'cf-connecting-ip':'198.51.100.2',...basic('right:one')}),'ok');
 clock=15*60_000+1;
 assert.equal(await gate({...remote,...basic('right:one')}),'ok');
});

test('a relayed request passes only with an Access token signed for this site, unexpired and from an allowed email',async ()=>{
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),stranger=generateKeyPairSync('rsa',{modulusLength:2048});
 const part=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const token=(claims,key=pair.privateKey)=>{
  const data=`${part({alg:'RS256',kid:'k1'})}.${part({iss:'https://team.cloudflareaccess.com',aud:['site'],exp:1000,email:'Me@example.com',...claims})}`;
  return `${data}.${sign('RSA-SHA256',Buffer.from(data),key).toString('base64url')}`;
 };
 const access={issuer:'https://team.cloudflareaccess.com',aud:'site',emails:['me@example.com']};
 const gate=makeGate({access,now:()=>500_000,loadKeys:async()=>[{...pair.publicKey.export({format:'jwk'}),kid:'k1'}]});
 const visit=jwt=>gate({'cf-connecting-ip':'203.0.113.9',...(jwt&&{'cf-access-jwt-assertion':jwt})});
 const table={valid:[token({}),'ok'],'no token':[null,'denied'],'another site':[token({aud:['other']}),'denied'],expired:[token({exp:499}),'denied'],
  'another team':[token({iss:'https://evil.cloudflareaccess.com'}),'denied'],'another email':[token({email:'you@example.com'}),'denied'],
  'forged signature':[token({},stranger.privateKey),'denied'],garbage:['a.b.c','denied']};
 for(const [name,[jwt,verdict]] of Object.entries(table))assert.equal(await visit(jwt),verdict,name);
});

test('setup adds its section once, keeps what a project already wrote, and has nothing left to do on a second run',()=>{
 const project=mkdtempSync(join(tmpdir(),'monitor-setup-')),mine='# Mine\n\nKeep this.\n';
 writeFileSync(join(project,'CLAUDE.md'),mine);
 apply(plan(project).writes);
 assert.ok(readFileSync(join(project,'CLAUDE.md'),'utf8').startsWith(mine));
 for(const name of ['CLAUDE.md','AGENTS.md'])assert.equal(readFileSync(join(project,name),'utf8').split('agent-monitor:start').length,2,name);
 assert.ok(parseCard(readFileSync(join(project,'tasks','TEMPLATE.md'),'utf8')));
 assert.deepEqual(plan(project).writes,[]);
});

test('another machine is let in only with the shared secret, and never when no secret is set',()=>{
 const check=makeSecretCheck('a-long-shared-secret');
 assert.deepEqual([check('a-long-shared-secret'),check('a-long-shared-secreT'),check(''),check(undefined),makeSecretCheck('')('')],[true,false,false,false,false]);
 assert.deepEqual(['127.0.0.1','::1','::ffff:127.0.0.1','192.168.1.20','::ffff:192.168.1.20'].map(isLoopback),[true,true,true,false,false]);
 const file=join(mkdtempSync(join(tmpdir(),'monitor-secret-')),'nested','peer-secret');
 const first=ensureSecret(file),second=ensureSecret(file);
 assert.deepEqual([first.created,second.created,second.secret===first.secret,first.secret.length>=32],[true,false,true,true]);
});

test('runs from another machine are tagged and addressed by machine, kept while it sends nothing new, and dropped once it stops answering',async ()=>{
 let clock=0,reply={machine:'den',have:'1-1',sys:{cpu:12},runs:[{id:'a',parent:null},{id:'b',parent:'a'}],limits:[],burn:[[5,10]]};
 const asked=[];
 const fetcher=async(url,options)=>{
  asked.push([url,options.headers['x-agent-monitor-secret']]);
  if(!reply)throw new Error('offline');
  return {ok:true,status:200,json:async()=>reply};
 };
 const peers=new Peers(['http://10.0.0.2:4599/'],{secret:'s',fetcher,now:()=>clock});
 assert.deepEqual(peers.machines().map(machine=>[machine.name,machine.ok]),[['10.0.0.2',false]]);
 assert.equal(await peers.poll(),true);
 assert.deepEqual(asked[0],['http://10.0.0.2:4599/api/peer?have=','s']);
 assert.deepEqual(peers.remote().views,[{id:'@den/a',parent:null,machine:'den'},{id:'@den/b',parent:'@den/a',machine:'den'}]);
 assert.deepEqual(peers.machines(),[{name:'den',version:'',ok:true,error:'',cpu:12}]);
 reply={machine:'den',have:'1-1',sys:{cpu:40}};
 assert.equal(await peers.poll(),false);
 assert.equal(asked[1][0],'http://10.0.0.2:4599/api/peer?have=1-1');
 assert.deepEqual([peers.remote().views.length,peers.machines()[0].cpu],[2,40]);
 reply=null;clock=20_000;
 assert.equal(await peers.poll(),true);
 assert.deepEqual([peers.remote().views,peers.machines()],[[],[{name:'den',version:'',ok:false,error:'offline'}]]);
});

test('machines on the same accounts merge to the newest limit reading, and their token use adds up',()=>{
 const limits=mergeLimits([[{account:'claude',asOf:5,windows:['old']},{account:'codex',asOf:9,windows:['mine']}],[{account:'claude',asOf:8,windows:['new']}]]);
 assert.deepEqual(limits.map(limit=>[limit.account,limit.windows[0]]),[['claude','new'],['codex','mine']]);
 assert.deepEqual(mergeBurn([[[10,5],[20,1]],[[20,2],[15,7]]]),[[10,5],[15,7],[20,3]]);
});

test('a run with no name is named after the first line it was asked, without markup',()=>{
 const table=[['Check the build\nthen report','Check the build'],['<command-name>/review</command-name>\n\n  Review PR 12  ','/review'],['<tag></tag>\r\n\r\nSecond line','Second line'],['',''],[undefined,'']];
 for(const [prompt,name] of table)assert.equal(promptName(prompt),name);
 assert.equal(promptName('x'.repeat(200)).length,70);
});

test('a name given on the page replaces the automatic one, survives a restart, and an empty name brings the automatic one back',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'monitor-names-')),'nested','names.json');
 const names=new Names(file);
 assert.equal(names.set('a','  Night   shift '+String.fromCharCode(10)+'lead  '),'Night shift lead');
 assert.equal(names.set('b','x'.repeat(200)).length,80);
 const runs=()=>[{id:'a',title:'auto a'},{id:'c',title:'auto c'}];
 const shown=list=>{list.apply(list.runs=runs());return list.runs.map(run=>[run.title,run.auto]);};
 assert.deepEqual(shown(new Names(file)),[['Night shift lead','auto a'],['auto c',undefined]]);
 assert.equal(names.set('a','   '),'');
 assert.deepEqual(shown(new Names(file)),[['auto a',undefined],['auto c',undefined]]);
});

test('an unattended Codex run may stay silent inside a command only as long as that command can wait; other runs keep the long allowance',()=>{
 const codex=(originator,input)=>{
  const run=new CodexRun(transcript([
   {timestamp:at(0),type:'session_meta',payload:{id:'a',session_id:'a',cwd:'/repo',originator,source:'exec',timestamp:at(0)}},
   {timestamp:at(1),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'act as Coder for T-1'}]}},
   {timestamp:at(2),type:'response_item',payload:{type:'custom_tool_call',call_id:'c1',name:'exec',input}},
  ]),shared(),{account:'codex'});
  run.poll();
  return run.toolAllowance();
 };
 const table=[
  ['codex_exec','text(await tools.exec_command({cmd:"rg x"}))',120_000],
  ['codex_exec','// @exec: {"yield_time_ms": 60000} text(await tools.write_stdin({session_id:1,yield_time_ms:50000}))',120_000],
  ['codex_exec','text(await tools.exec_command({cmd:"npm test",yield_time_ms:300000}))',360_000],
  ['codex_exec','{"duration_ms":50000}',120_000],
  ['codex_exec','text(await tools.exec_command({cmd:"x",timeout_ms:99999999}))',TOOL_STALE],
  ['codex_cli','text(await tools.exec_command({cmd:"rg x"}))',TOOL_STALE],
 ];
 for(const [originator,input,allowance] of table)assert.equal(codex(originator,input),allowance,`${originator} ${input}`);
 const claude=new ClaudeRun(transcript([
  {type:'user',timestamp:at(0),message:{role:'user',content:'go'}},
  {type:'assistant',timestamp:at(5),message:{id:'m1',model:'model-a',stop_reason:'tool_use',content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'npm test',timeout:60000}}]}},
 ]),shared(),{id:'s'});
 claude.poll();
 assert.equal(claude.toolAllowance(),TOOL_STALE);
});

test('an ETA line the agent prints is kept as its estimate, the latest one wins, and a new request clears it',()=>{
 const lines=[
  {timestamp:at(0),type:'session_meta',payload:{id:'a',session_id:'a',cwd:'/repo',originator:'codex_exec',source:'exec',timestamp:at(0)}},
  {timestamp:at(1),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'act as Coder for T-1. Print one line ETA: <minutes> min'}]}},
  {timestamp:at(2),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'ETA: 30 min'}]}},
 ];
 const read=extra=>{const run=new CodexRun(transcript([...lines,...extra]),shared(),{account:'codex'});run.poll();return run.eta;};
 assert.deepEqual(read([]),{min:30,at:Date.parse(at(2))});
 assert.equal(read([{timestamp:at(3),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Tests are slow. **ETA:** ~1.5 hours'}]}}]).min,30);
 assert.equal(read([{timestamp:at(3),type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Tests are slow.'},{type:'output_text',text:'**ETA:** ~1.5 hours'}]}}]).min,90);
 assert.equal(read([{timestamp:at(4),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'also fix the lint'}]}}]),null);
});

test('a Codex sleep or check on a background command counts as that command, and a sleep with nothing running counts as waiting',()=>{
 const call=(second,id,name,input)=>({timestamp:at(second),type:'response_item',payload:{type:'custom_tool_call',call_id:id,name,input}});
 const done=(second,id,output)=>({timestamp:at(second),type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output}});
 const run=new CodexRun(transcript([
  {timestamp:at(0),type:'session_meta',payload:{id:'a',session_id:'a',cwd:'/repo',originator:'codex_exec',source:'exec',timestamp:at(0)}},
  {timestamp:at(1),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'act as Coder for T-1'}]}},
  call(2,'c1','exec','const r=await tools.exec_command({cmd:"cargo test",yield_time_ms:1000}); text(JSON.stringify(r));'),
  done(4,'c1','{"session_id":4242,"output":""}'),
  call(5,'c2','sleep','{"duration_ms":20000}'),
  done(25,'c2',''),
  call(26,'c3','exec','text(JSON.stringify(await tools.write_stdin({session_id:4242,chars:"",yield_time_ms:1000})));'),
  done(31,'c3','{"exit_code":0,"output":"ok"}'),
  call(32,'c4','sleep','{"duration_ms":10000}'),
  done(42,'c4',''),
 ]),shared(),{account:'codex'});
 run.poll();
 assert.deepEqual(run.calls.map(item=>item.cat),['testing','testing','testing','waiting']);
 assert.match(run.calls[1].label,/^waiting for: cargo test/);
 assert.deepEqual(run.waited,{n:3,ms:35000});
});

test('a Claude turn that ends while its background test is running counts as testing until the notice that it ended',()=>{
 const usage={input_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:5};
 const lines=background=>[
  {type:'user',timestamp:at(0),message:{role:'user',content:'Act as Coder for T-12'}},
  {type:'assistant',timestamp:at(5),message:{id:'m1',model:'model-a',stop_reason:'tool_use',usage,content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:background,run_in_background:true}}]}},
  {type:'user',timestamp:at(6),message:{role:'user',content:[{type:'tool_result',tool_use_id:'t1',content:'Command running in background with ID: b123. Output is being written to a file.'}]}},
  {type:'assistant',timestamp:at(10),message:{id:'m2',model:'model-a',stop_reason:'end_turn',usage,content:[{type:'text',text:'Waiting for it.'}]}},
  {type:'user',timestamp:at(70),message:{role:'user',content:['<task-notification>','<task-id>b123</task-id>','<status>completed</status>','</task-notification>'].join(String.fromCharCode(10))}},
  {type:'assistant',timestamp:at(75),message:{id:'m3',model:'model-a',stop_reason:'end_turn',usage,content:[{type:'text',text:'Done.'}]}},
 ];
 const read=command=>{const run=new ClaudeRun(transcript(lines(command)),shared(),{id:'s'});run.poll();return run;};
 const tests=read('node --test tests/a.test.ts');
 assert.deepEqual(cats(tests),['thinking:5','testing:1','thinking:4','testing:60','thinking:5']);
 assert.deepEqual(tests.waited,{n:1,ms:60000});
 assert.equal(tests.tl.cur.c,'idle');
 // A command that ends while the agent is busy is reported as a queued notice, and later turn ends are not waits for it.
 const early=lines('node --test tests/a.test.ts');
 early.splice(3,0,{type:'attachment',timestamp:at(8),attachment:{type:'queued_command',prompt:'<task-notification><task-id>b123</task-id><status>completed</status></task-notification>'}});
 const busy=new ClaudeRun(transcript(early),shared(),{id:'s'});
 busy.poll();
 assert.equal(busy.waited.n,0);
 assert.ok(cats(busy).includes('idle:60'));
 // A background server never ends, so only builds and tests are waited for.
 const server=read('node server.mjs');
 assert.equal(server.waited.n,0);
 assert.deepEqual(cats(server).slice(-2),['idle:60','thinking:5']);
});

test('a hidden session stays hidden after a restart until it is shown again',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'monitor-hidden-')),'nested','hidden.json');
 const marked=()=>{const runs=[{id:'a'},{id:'b'}];new Hidden(file).apply(runs);return runs.map(run=>Boolean(run.hidden));};
 assert.equal(new Hidden(file).set('a',true),true);
 assert.deepEqual(marked(),[true,false]);
 assert.equal(new Hidden(file).set('a',false),false);
 assert.deepEqual(marked(),[false,false]);
});
