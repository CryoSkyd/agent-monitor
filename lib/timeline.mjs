export const CATS=['thinking','editing','reading','testing','git','delegating','command','idle','waiting'];
const INDEX=Object.fromEntries(CATS.map((cat,i)=>[cat,i]));

/** A run's activity as back-to-back segments; the last one stays open while the run is live. */
export class Timeline{
 segs=[];
 cur=null;
 #totals=CATS.map(()=>0);
 set(ts,cat,label=''){
  if(this.cur?.c===cat){if(label)this.cur.label=label;return;}
  this.end(ts);
  this.cur={s:ts,c:cat,label};
 }
 end(ts){
  if(!this.cur)return;
  const {s,c}=this.cur,e=Math.max(ts,s),last=this.segs.at(-1);
  this.#totals[INDEX[c]]+=e-s;
  if(last&&last[2]===INDEX[c]&&s-last[1]<1000)last[1]=e;
  else if(e>s)this.segs.push([s,e,INDEX[c]]);
  this.cur=null;
 }
 /** Whole-run seconds per activity, in CATS order; the open segment counts only up to closeAt. */
 totals(closeAt){
  const out=this.#totals.map(ms=>Math.round(ms/1000));
  if(this.cur&&closeAt>this.cur.s)out[INDEX[this.cur.c]]+=Math.round((closeAt-this.cur.s)/1000);
  return out;
 }
 /** Segments ending after `from`, in whole seconds; an open segment ends at 0 unless closeAt is given. */
 view(from,closeAt){
  const out=[];
  for(const [s,e,c] of this.segs)if(e>=from)out.push([Math.round(s/1000),Math.round(e/1000),c]);
  if(this.cur){
   const s=Math.round(this.cur.s/1000);
   if(closeAt==null)out.push([s,0,INDEX[this.cur.c]]);
   else if(closeAt>this.cur.s)out.push([s,Math.round(closeAt/1000),INDEX[this.cur.c]]);
  }
  return out;
 }
}
