/**
 * Codex starts a long command, lets it go on in the background, and then polls it or sleeps until it ends.
 * This ties each of those waits to the command it waits for, so the time counts as that command's activity.
 */
const SESSION=/session_id[^0-9]{1,6}([0-9]+)|session ([0-9]+)|SESSION_ID=([0-9]+)/gi;
const POLL=/write_stdin/,STARTS=/exec_command|apply_patch/,EMPTY=/chars["']?:[ ]*(""|'')/;
const ONLY_SLEEP=/cmd["']?:[ ]*["'](Start-Sleep|sleep|timeout)[^;|&"']*["']/i;
const ids=text=>[...String(text??'').matchAll(SESSION)].map(match=>match[1]??match[2]??match[3]);

export class Waits{
 #origin=new Map();
 #open=new Set();
 #calls=new Map();
 /** The activity to file a call under: its own, or for a call that only waits, the one it waits for. */
 started(callId,name,text,info){
  const sleep=name==='sleep'||(ONLY_SLEEP.test(text)&&!POLL.test(text));
  const poll=!sleep&&POLL.test(text)&&EMPTY.test(text)&&!STARTS.test(text);
  if(!sleep&&!poll){this.#calls.set(callId,{info});return info;}
  const asked=poll?ids(text):[];
  for(const id of asked)this.#open.add(id);
  this.#calls.set(callId,{asked});
  const known=id=>this.#origin.has(id);
  const target=asked.find(known)??(sleep?[...this.#open].reverse().find(known):undefined);
  const origin=this.#origin.get(target);
  if(origin)return {cat:origin.cat,name:`wait: ${origin.name}`,label:`waiting for: ${origin.label}`,wait:true};
  const running=asked.length||this.#open.size;
  return {cat:'waiting',name:sleep?'sleep':'poll',label:running?'waiting for a background command':'sleep, with no background command known',wait:true};
 }
 ended(callId,output){
  const call=this.#calls.get(callId);
  if(!call)return;
  this.#calls.delete(callId);
  const seen=ids(typeof output==='string'?output:JSON.stringify(output??''));
  // A poll's answer names the commands still running; one it no longer names has ended.
  if(call.asked){for(const id of call.asked)if(!seen.includes(id))this.#open.delete(id);return;}
  for(const id of seen)if(!this.#origin.has(id)){this.#origin.set(id,call.info);this.#open.add(id);}
 }
}
