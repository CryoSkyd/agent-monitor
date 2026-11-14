// A Claude Code status line command: saves the plan limits it is handed so agent-monitor can show them.
import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

let input='';
for await(const chunk of process.stdin)input+=chunk;
let data={};
try{data=JSON.parse(input);}catch{}
const limits=data.rate_limits;
if(limits){
 const dir=join(homedir(),'.agent-monitor'),file=join(dir,'claude-limits.json');
 try{
  mkdirSync(dir,{recursive:true});
  writeFileSync(`${file}.tmp`,JSON.stringify({asOf:Date.now(),rate_limits:limits}));
  renameSync(`${file}.tmp`,file);
 }catch{}
}
const percent=window=>typeof window?.used_percentage==='number'?`${Math.round(window.used_percentage)}%`:'–';
console.log([data.model?.display_name,limits&&`5h ${percent(limits.five_hour)} · week ${percent(limits.seven_day)}`].filter(Boolean).join(' · '));
