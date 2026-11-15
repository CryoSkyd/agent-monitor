import {Tail,readRange} from './tail.mjs';
import {Timeline} from './timeline.mjs';


const BURN_BUCKET=300_000;
const LOOP=3,RECENT=10,REREADS=5;
// shortcut: transcripts do not name the context window; assume 500K, or 1M once a request exceeds that.
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
export function show(value){
 if(value==null)return '';
 if(typeof value==='string')return value;
 if(Array.isArray(value))return value.map(part=>typeof part==='string'?part:part?.text??JSON.stringify(part)).join('\n');
 return Object.entries(value).map(([key,item])=>`${key}: ${typeof item==='string'?item:JSON.stringify(item,null,1)}`).join('\n\n');
}

export class Run{
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
 /** Calls that only waited on a background command: how many, and for how long in all. */
 waited={n:0,ms:0};
 waitOpen=new Map();
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
