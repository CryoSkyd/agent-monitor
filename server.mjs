// Usage: node server.mjs <project folder | config.json> [--port 4599] [--hours 24] [--no-gh] [--share] [--peer http://host:4599]
import {createServer} from 'node:http';
import {hostname,networkInterfaces} from 'node:os';
import {gzipSync} from 'node:zlib';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureSecret,isLoopback,makeGate,makeSecretCheck,readAccess,readPassword,readSecret} from './lib/auth.mjs';
import {Peers,SECRET_HEADER,splitPeerId} from './lib/peers.mjs';
import {Monitor} from './lib/monitor.mjs';
import {Names} from './lib/names.mjs';
import {PullRequests} from './lib/github.mjs';
import {SystemMonitor} from './lib/system.mjs';

const here=dirname(fileURLToPath(import.meta.url));
let VERSION='';
try{VERSION=JSON.parse(readFileSync(join(here,'.claude-plugin','plugin.json'),'utf8')).version??'';}catch{}
const args=process.argv.slice(2);
const flag=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
const target=args.find((arg,i)=>!arg.startsWith('--')&&!['--port','--hours','--peer'].includes(args[i-1]));
if(!target){console.error('Usage: node server.mjs <project folder | config.json> [--port 4599] [--hours 24] [--no-gh] [--share] [--peer http://host:4599]');process.exit(2);}

function loadConfig(){
 const path=resolve(target);
 const own=join(path,'.agent-monitor.json');
 const file=statSync(path).isFile()?JSON.parse(readFileSync(path,'utf8')):{...(existsSync(own)&&JSON.parse(readFileSync(own,'utf8'))),project:path};
 const project=resolve(file.project);
 const tasksDir=file.tasksDir??['docs/tasks','tasks','.tasks'].find(dir=>existsSync(join(project,dir)))??null;
 const peers=[...(file.peers??[]),...args.flatMap((arg,i)=>arg==='--peer'&&args[i+1]?[args[i+1]]:[])];
 return {name:basename(project),port:4599,hours:24,limitWarn:80,github:true,machine:hostname(),...file,project,tasksDir,peers,share:Boolean(file.share)||args.includes('--share'),
  ...(flag('--port')&&{port:Number(flag('--port'))}),...(flag('--hours')&&{hours:Number(flag('--hours'))}),...(args.includes('--no-gh')&&{github:false})};
}

const config=loadConfig();
const monitor=new Monitor(config);
const system=new SystemMonitor();
const pulls=new PullRequests(config.project,{enabled:config.github});
const clients=new Set();
let snapshotText='',dirty=true,lastBuild=0;

const send=(client,event,data)=>client.write(`event: ${event}\ndata: ${data}\n\n`);
// A sharing machine makes its own secret on first use; the file, never the secret, is what gets printed.
const sharing=config.share?ensureSecret(config.secretFile):null;
const secret=sharing?.secret??readSecret(config.secretFile);
if(sharing?.created)console.log(`Created the shared secret in ${sharing.file}. Copy that file to the same place on the other machines.`);
const peers=new Peers(config.peers,{secret});
const machinesText=withHistory=>JSON.stringify({local:config.machine,peers:peers.machines(withHistory)});
let version=0,lastSample=null;
const names=new Names(config.namesFile);
function rebuild(now){
 const snapshot=monitor.snapshot(now,pulls.list,peers.size?{machine:config.machine,...peers.remote()}:null);
 snapshot.version=VERSION;
 names.apply(snapshot.runs);
 const text=JSON.stringify(snapshot);
 lastBuild=now;dirty=false;
 // The clock field changes every build; compare the rest so idle periods send nothing.
 if(text.replace(/^\{"now":\d+/,'')===snapshotText.replace(/^\{"now":\d+/,''))return;
 snapshotText=text;version++;
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
system.start(sample=>{lastSample=sample;const text=JSON.stringify(sample);for(const client of clients)send(client,'sys',text);});
if(peers.size)setInterval(async()=>{
 if(await peers.poll())dirty=true;
 const text=machinesText();
 for(const client of clients)send(client,'machines',text);
},2000);

const password=readPassword(config.passwordFile),access=readAccess(config.accessFile);
const gate=makeGate({password,access});
const hasSecret=makeSecretCheck(secret);
// The only requests another machine may make, and only with the shared secret.
const PEER_PATHS=new Set(['/api/peer','/api/calls','/api/call']);
const json=(response,code,body)=>{response.writeHead(code,{'content-type':'application/json'});response.end(typeof body==='string'?body:JSON.stringify(body));};
const REFUSALS={closed:[403,'Remote access is off because no sign-in is set up on the computer running agent-monitor.'],denied:[403,'This address needs a Cloudflare Access sign-in that agent-monitor accepts.'],locked:[429,'Too many wrong passwords. Try again in 15 minutes.'],login:[401,'Password required.']};
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const server=createServer(async (request,response)=>{
 // A password must never travel unencrypted: visitors who reach a proxy over plain HTTP are sent to HTTPS first.
 if(request.headers['x-forwarded-proto']==='http'&&request.headers.host){
  response.writeHead(308,{location:`https://${request.headers.host}${request.url}`});
  response.end();
  return;
 }
 const url=new URL(request.url,'http://localhost');
 if(!isLoopback(request.socket.remoteAddress)){
  if(!PEER_PATHS.has(url.pathname)||!hasSecret(request.headers[SECRET_HEADER])){response.writeHead(403,{'content-type':'text/plain'});response.end('Refused.');return;}
 }else{
 const verdict=await gate(request.headers);
 if(verdict!=='ok'){
  const [code,text]=REFUSALS[verdict];
  response.writeHead(code,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store',...(verdict==='login'&&{'www-authenticate':'Basic realm="agent-monitor", charset="UTF-8"'})});
  response.end(text);
  return;
 }
 }
 if(url.pathname==='/events'){
  response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
  clients.add(response);
  request.on('close',()=>clients.delete(response));
  send(response,'history',JSON.stringify(system.history));
  send(response,'snap',snapshotText);
  if(peers.size)send(response,'machines',machinesText(true));
  return;
 }
 if(url.pathname==='/api/name'){
  // A JSON body from the page itself: another site cannot send one to this address without the browser asking first.
  const origin=request.headers.origin;
  if(request.method!=='POST'||!/^application\/json\b/.test(request.headers['content-type']??'')||(origin&&new URL(origin).host!==request.headers.host)){json(response,400,{error:'Not accepted'});return;}
  let body='';
  for await(const chunk of request){body+=chunk;if(body.length>2000)break;}
  let given;
  try{given=JSON.parse(body);}catch{}
  if(typeof given?.run!=='string'||!given.run||given.run.length>300||typeof given.name!=='string'){json(response,400,{error:'Not accepted'});return;}
  const name=names.set(given.run,given.name);
  rebuild(Date.now());
  json(response,200,{name});
  return;
 }
 if(url.pathname==='/api/peer'){
  const have=`${started}-${version}`,body={machine:config.machine,version:VERSION,have,sys:lastSample};
  if(url.searchParams.get('have')!==have)Object.assign(body,monitor.own);
  const text=JSON.stringify(body);
  if(/\bgzip\b/.test(request.headers['accept-encoding']??'')){response.writeHead(200,{'content-type':'application/json','content-encoding':'gzip'});response.end(gzipSync(text));}
  else json(response,200,text);
  return;
 }
 if(url.pathname==='/api/card'){
  const card=monitor.card(url.searchParams.get('id')??'');
  response.writeHead(card?200:404,{'content-type':'application/json'});
  response.end(JSON.stringify(card??{error:'No card'}));
  return;
 }
 if(url.pathname==='/api/calls'||url.pathname==='/api/call'){
  const id=url.searchParams.get('run')??'',index=Number(url.searchParams.get('i'));
  const found=splitPeerId(id)?await peers.detail(url.pathname,id,url.pathname==='/api/call'?`&i=${index}`:''):url.pathname==='/api/calls'?monitor.calls(id):monitor.call(id,index);
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
 if(url.pathname==='/api/project'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({name:config.name,path:config.project,version:VERSION,machine:config.machine,share:config.share,peers:config.peers.length}));return;}
 if(url.pathname==='/api/snapshot'){response.writeHead(200,{'content-type':'application/json'});response.end(snapshotText);return;}
 const name=['/','/agents.html'].includes(url.pathname)?'index.html':url.pathname.slice(1);
 const path=join(here,'public',name);
 if(!/^[\w.-]+$/.test(name)||!existsSync(path)){response.writeHead(404);response.end('Not found');return;}
 response.writeHead(200,{'content-type':TYPES[extname(path)]??'application/octet-stream','cache-control':'no-cache','x-robots-tag':'noindex'});
 response.end(readFileSync(path));
});
// Loopback only: the page shows prompts and command lines from local transcripts. A tunnel can relay to it, behind the password.
let port=config.port;
// Sharing opens the port to the local network for other machines' monitors, which must send the secret.
const host=config.share?'0.0.0.0':'127.0.0.1';
if(config.peers.length&&!secret)console.error('Other machines will refuse this one: copy ~/.agent-monitor/peer-secret here from a machine started with --share.');
server.on('error',error=>{
 if(error.code!=='EADDRINUSE'||port>=config.port+20)throw error;
 server.listen(++port,host);
});
const lanAddresses=()=>Object.values(networkInterfaces()).flat().filter(address=>address.family==='IPv4'&&!address.internal).map(address=>address.address);
server.on('listening',()=>console.log(`agent-monitor ${VERSION} for ${config.name}: http://127.0.0.1:${port}${host==='0.0.0.0'?`\nShared with other machines on this network as "${config.machine}": ${lanAddresses().map(address=>`http://${address}:${port}`).join(', ')||`port ${port}`}`:''}${config.peers.length?`\nAlso showing: ${config.peers.map(peer=>peer.url??peer).join(', ')}`:''}\nRemote access through a tunnel: ${[access&&'Cloudflare Access sign-in',password&&'the password'].filter(Boolean).join(' or ')||'refused, nothing set up'}`));
server.listen(port,host);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{system.stop();pulls.stop();process.exit(0);});
