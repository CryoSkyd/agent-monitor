const STALE=15_000,TIMEOUT=4000,HISTORY=300;
export const SECRET_HEADER='x-agent-monitor-secret';

/** A run on another machine is addressed as @machine/id, so its details can be fetched from that machine. */
export const peerId=(machine,id)=>`@${machine}/${id}`;
export function splitPeerId(id){
 const match=/^@([^/]+)\/(.*)$/s.exec(id);
 return match&&{machine:match[1],id:match[2]};
}

/** Machines signed in to the same accounts each report those limits; the newest reading of an account wins. */
export function mergeLimits(lists){
 const byAccount=new Map();
 for(const limit of lists.flat())if(!(byAccount.get(limit.account)?.asOf>=limit.asOf))byAccount.set(limit.account,limit);
 return [...byAccount.values()].sort((a,b)=>a.account.localeCompare(b.account));
}

export function mergeBurn(lists){
 const byTime=new Map();
 for(const [time,tokens] of lists.flat())byTime.set(time,(byTime.get(time)??0)+tokens);
 return [...byTime].sort((a,b)=>a[0]-b[0]);
}

/** Pulls the live summary of agent-monitor servers on other machines, to be merged into this one's page. */
export class Peers{
 #peers;
 #secret;
 #fetch;
 #now;
 constructor(list=[],{secret='',fetcher=fetch,now=Date.now}={}){
  this.#peers=list.map(entry=>typeof entry==='string'?{url:entry}:entry).map(({name,url})=>{
   const base=String(url).replace(/\/+$/,'');
   return {url:base,fixedName:name??null,name:name??new URL(base).hostname,at:0,error:'not reached yet',have:'',data:null,sys:null,shown:false,history:[]};
  });
  this.#secret=secret;this.#fetch=fetcher;this.#now=now;
 }
 get size(){return this.#peers.length;}
 #ask(peer,path){return this.#fetch(`${peer.url}${path}`,{headers:{[SECRET_HEADER]:this.#secret},signal:AbortSignal.timeout(TIMEOUT)});}
 #fresh(peer){return Boolean(peer.data)&&this.#now()-peer.at<STALE;}

 /** Returns true when any machine sent new runs, came into view or dropped out. */
 async poll(){
  const changed=await Promise.all(this.#peers.map(async peer=>{
   let sentRuns=false;
   try{
    const response=await this.#ask(peer,`/api/peer?have=${encodeURIComponent(peer.have)}`);
    if(!response.ok)throw new Error(response.status===403?'refused: check the shared secret and that sharing is on':`answered ${response.status}`);
    const body=await response.json();
    Object.assign(peer,{name:peer.fixedName??body.machine??peer.name,at:this.#now(),error:'',have:body.have??'',sys:body.sys??null,version:body.version??''});
    if(body.sys?.cpu!=null){peer.history.push([this.#now(),body.sys.cpu]);if(peer.history.length>HISTORY)peer.history.shift();}
    // An unchanged machine sends only its load figures.
    if(body.runs)peer.data={runs:body.runs,limits:body.limits??[],burn:body.burn??[]};
    sentRuns=Boolean(body.runs);
   }catch(error){
    peer.error=error.name==='TimeoutError'?'no answer':String(error.cause?.code??error.message);
   }
   const fresh=this.#fresh(peer),flipped=fresh!==peer.shown;
   peer.shown=fresh;
   return sentRuns||flipped;
  }));
  return changed.some(Boolean);
 }

 /** What the reachable machines contribute to the page. */
 remote(){
  const fresh=this.#peers.filter(peer=>this.#fresh(peer));
  return {
   views:fresh.flatMap(({name,data})=>data.runs.map(run=>({...run,id:peerId(name,run.id),parent:run.parent&&peerId(name,run.parent),machine:name}))),
   limits:fresh.map(peer=>peer.data.limits),
   burn:fresh.map(peer=>peer.data.burn),
  };
 }
 /** Each machine's reachability and load; `withHistory` adds its recent CPU readings for a page that has just opened. */
 machines(withHistory=false){
  return this.#peers.map(peer=>({name:peer.name,version:peer.version??'',ok:this.#fresh(peer),error:peer.error,...(this.#fresh(peer)&&peer.sys),...(withHistory&&{history:peer.history})}));
 }
 /** Fetches one run's tool calls, or one call, from the machine that holds its transcript. */
 async detail(path,runId,query=''){
  const target=splitPeerId(runId),peer=target&&this.#peers.find(peer=>peer.name===target.machine);
  if(!peer)return null;
  try{
   const response=await this.#ask(peer,`${path}?run=${encodeURIComponent(target.id)}${query}`);
   return response.ok?await response.json():null;
  }catch{return null;}
 }
}
