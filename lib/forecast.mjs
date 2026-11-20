const MINUTE=60_000,LOOKBACK=60*MINUTE,MIN_SPAN=10*MINUTE,FRESH=20*MINUTE;

/** Usage-limit readings per account and window, kept to estimate how fast the limit is filling. */
export class LimitHistory{
 #series=new Map();
 add(account,label,ts,used){
  const key=`${account}|${label}`,series=this.#series.get(key)??new Map();
  const minute=Math.floor(ts/MINUTE)*MINUTE;
  series.set(minute,Math.max(series.get(minute)??0,used));
  this.#series.set(key,series);
 }
 prune(before){
  for(const series of this.#series.values())for(const ts of series.keys())if(ts<before)series.delete(ts);
 }
 /** Percent of the limit used up between two times, counting on through resets; null without a reading in that span. */
 rise(account,label,from,to){
  const points=[...this.#series.get(`${account}|${label}`)??[]].filter(([ts])=>ts>=from&&ts<=to).sort((a,b)=>a[0]-b[0]);
  if(!points.length)return null;
  let rise=0;
  for(let i=1;i<points.length;i++)rise+=points[i][1]<points[i-1][1]?points[i][1]:points[i][1]-points[i-1][1];
  return rise;
 }
 /** Percent per hour over the last hour, counted from the latest reset; null when the account has been quiet. */
 trend(account,label,now){
  const series=this.#series.get(`${account}|${label}`);
  if(!series)return null;
  const points=[...series].filter(([ts])=>ts>=now-LOOKBACK&&ts<=now).sort((a,b)=>a[0]-b[0]);
  let from=0;
  for(let i=1;i<points.length;i++)if(points[i][1]<points[i-1][1])from=i;
  const first=points[from],last=points.at(-1);
  // Readings come in whole percent, so a rise of one step says too little about the rate to forecast from.
  if(!last||now-last[0]>FRESH||last[0]-first[0]<MIN_SPAN||last[1]-first[1]<2)return null;
  return {rate:(last[1]-first[1])/((last[0]-first[0])/3600_000),at:last[0],used:last[1]};
 }
}
