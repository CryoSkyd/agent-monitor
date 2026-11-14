// Usage: node server.mjs <project folder | config.json> [--port 4599] [--hours 24] [--no-gh]
import {createServer} from 'node:http';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeGate,readAccess,readPassword} from './lib/auth.mjs';
import {Monitor} from './lib/monitor.mjs';
import {PullRequests} from './lib/github.mjs';
import {SystemMonitor} from './lib/system.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const target=args.find((arg,i)=>!arg.startsWith('--')&&!['--port','--hours'].includes(args[i-1]));
if(!target){console.error('Usage: node server.mjs <project folder | config.json> [--port 4599] [--hours 24] [--no-gh]');process.exit(2);}

function loadConfig(){
 const path=resolve(target);
 const own=join(path,'.agent-monitor.json');
 const file=statSync(path).isFile()?JSON.parse(readFileSync(path,'utf8')):{...(existsSync(own)&&JSON.parse(readFileSync(own,'utf8'))),project:path};
 const project=resolve(file.project);
 const tasksDir=file.tasksDir??['docs/tasks','tasks','.tasks'].find(dir=>existsSync(join(project,dir)))??null;
 return {name:basename(project),port:4599,hours:24,limitWarn:80,github:true,...file,project,tasksDir,
  ...(flag('--port')&&{port:Number(flag('--port'))}),...(flag('--hours')&&{hours:Number(flag('--hours'))}),...(args.includes('--no-gh')&&{github:false})};
}

const config=loadConfig();
const monitor=new Monitor(config);
const system=new SystemMonitor();
const pulls=new PullRequests(config.project,{enabled:config.github});
const clients=new Set();
let snapshotText='',dirty=true,lastBuild=0;

const send=(client,event,data)=>client.write(`event: ${event}\ndata: ${data}\n\n`);
function rebuild(now){
 const snapshot=monitor.snapshot(now,pulls.list);
 const text=JSON.stringify(snapshot);
 lastBuild=now;dirty=false;
 // The clock field changes every build; compare the rest so idle periods send nothing.
 if(text.replace(/^\{"now":\d+/,'')===snapshotText.replace(/^\{"now":\d+/,''))return;
 snapshotText=text;
 for(const client of clients)send(client,'snap',text);
}

const started=Date.now();
monitor.discover(started);
monitor.refreshCards();
monitor.poll();
rebuild(Date.now());
console.log(`Read ${monitor.runs.size} transcripts in ${Date.now()-started} ms`);

setInterval(()=>{if(monitor.poll())dirty=true;const now=Date.now();if(dirty||now-lastBuild>10_000)rebuild(now);},2000);
setInterval(()=>{monitor.discover(Date.now());if(monitor.refreshCards())dirty=true;},10_000);
pulls.start(()=>{dirty=true;});
system.start(sample=>{const text=JSON.stringify(sample);for(const client of clients)send(client,'sys',text);});

const password=readPassword(config.passwordFile),access=readAccess(config.accessFile);
const gate=makeGate({password,access});
const REFUSALS={closed:[403,'Remote access is off because no sign-in is set up on the computer running agent-monitor.'],denied:[403,'This address needs a Cloudflare Access sign-in that agent-monitor accepts.'],locked:[429,'Too many wrong passwords. Try again in 15 minutes.'],login:[401,'Password required.']};
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server=createServer(async (request,response)=>{
 // A password must never travel unencrypted: visitors who reach a proxy over plain HTTP are sent to HTTPS first.
 if(request.headers['x-forwarded-proto']==='http'&&request.headers.host){
  response.writeHead(308,{location:`https://${request.headers.host}${request.url}`});
  response.end();
  return;
 }
 const verdict=await gate(request.headers);
 if(verdict!=='ok'){
  const [code,text]=REFUSALS[verdict];
  response.writeHead(code,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store',...(verdict==='login'&&{'www-authenticate':'Basic realm="agent-monitor", charset="UTF-8"'})});
  response.end(text);
  return;
 }
 const url=new URL(request.url,'http://localhost');
 if(url.pathname==='/events'){
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
  clients.add(response);
  request.on('close',()=>clients.delete(response));
  send(response,'history',JSON.stringify(system.history));
  send(response,'snap',snapshotText);
  return;
 }
 if(url.pathname==='/api/card'){
  const card=monitor.card(url.searchParams.get('id')??'');
  response.writeHead(card?200:404,{'content-type':'application/json'});
  response.end(JSON.stringify(card??{error:'No card'}));
  return;
 }
 if(url.pathname==='/api/calls'||url.pathname==='/api/call'){
  const id=url.searchParams.get('run')??'';
  const found=url.pathname==='/api/calls'?monitor.calls(id):monitor.call(id,Number(url.searchParams.get('i')));
  response.writeHead(found?200:404,{'content-type':'application/json'});
  response.end(JSON.stringify(found??{error:'Not found'}));
  return;
 }
 if(url.pathname==='/api/pr'){
  const number=Number(url.searchParams.get('n'));
  const reply=(code,body)=>{response.writeHead(code,{'content-type':'application/json'});response.end(JSON.stringify(body));};
  if(!Number.isInteger(number)||number<1)reply(404,{error:'No pull request'});
  else pulls.detail(number).then(detail=>reply(200,detail),error=>reply(502,{error:String(error.message).split('\n')[0]}));
  return;
 }
 if(url.pathname==='/api/project'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({name:config.name,path:config.project}));return;}
 if(url.pathname==='/api/snapshot'){response.writeHead(200,{'content-type':'application/json'});response.end(snapshotText);return;}
 const name=['/','/agents.html'].includes(url.pathname)?'index.html':url.pathname.slice(1);
 const path=join(here,'public',name);
 if(!/^[\w.-]+$/.test(name)||!existsSync(path)){response.writeHead(404);response.end('Not found');return;}
 response.writeHead(200,{'content-type':TYPES[extname(path)]??'application/octet-stream','cache-control':'no-cache','x-robots-tag':'noindex'});
 response.end(readFileSync(path));
});
// Loopback only: the page shows prompts and command lines from local transcripts. A tunnel can relay to it, behind the password.
let port=config.port;
server.on('error',error=>{
 if(error.code!=='EADDRINUSE'||port>=config.port+20)throw error;
 server.listen(++port,'127.0.0.1');
});
server.on('listening',()=>console.log(`agent-monitor for ${config.name}: http://127.0.0.1:${port}\nRemote access through a tunnel: ${[access&&'Cloudflare Access sign-in',password&&'the password'].filter(Boolean).join(' or ')||'refused, nothing set up'}`));
server.listen(port,'127.0.0.1');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{system.stop();pulls.stop();process.exit(0);});
