// US dollars per million tokens at API list prices, as of 2026-11. Keys match as substrings of the model id, longest first.
const DEFAULTS={
 'claude-fable-5-2':{in:8,out:40,cached:.2},
 'claude-fable-5':{in:10,out:50,cached:1},
 'claude-opus-5-5':{in:4,out:20,cached:.2},
 'claude-opus':{in:5,out:25,cached:.5},
 'claude-sonnet-5-5':{in:2,out:10,cached:.1},
 'claude-sonnet-5':{in:2,out:10,cached:.2},
 'claude-sonnet-4':{in:3,out:15,cached:.3},
 'claude-haiku-5-5':{in:.1,out:.5,cached:.01},
 'claude-haiku-4':{in:1,out:5,cached:.1},
 // shortcut: OpenAI's rates for requests up to 272K input tokens; use the long-context rates if Codex windows grow past that.
 'gpt-6-astra':{in:10,out:50,cached:1},
 'gpt-6.1-sol':{in:2,out:10,cached:.1},
 'gpt-6.1-terra':{in:1,out:5,cached:.05},
 'gpt-6-sol':{in:2,out:10,cached:.2},
 'gpt-6-luna':{in:.1,out:.5,cached:.01},
 'gpt-5.3-codex':{in:1.75,out:14,cached:.175},
};

/** Returns cost(model, tokens) in dollars, or null when no price is known for the model. */
export function makePricer(overrides={}){
 const table=Object.entries({...DEFAULTS,...overrides}).sort((a,b)=>b[0].length-a[0].length);
 return (model,{fresh=0,cached=0,out=0,write5m=0,write1h=0})=>{
  const price=table.find(([key])=>String(model).includes(key))?.[1];
  if(!price)return null;
  const cachedRate=price.cached??price.in*.1;
  // Cache writes cost more than plain input: 1.25x for the 5-minute cache, 2x for the 1-hour cache.
  return (fresh*price.in+write5m*(price.write5m??price.in*1.25)+write1h*(price.write1h??price.in*2)+cached*cachedRate+out*price.out)/1e6;
 };
}
