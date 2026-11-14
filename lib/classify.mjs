const squash=text=>String(text??'').replace(/\s+/g,' ').trim();
export const short=(text,n=140)=>{const s=squash(text);return s.length>n?`${s.slice(0,n-1)}…`:s;};
const base=path=>String(path??'').split(/[\\/]/).slice(-2).join('/');

const TEST=/\bnode\s+(--\S+\s+)*--test\b|\bcargo\s+(test|build|check|clippy|bench|run)\b|\bnpm\s+(run\s+)?(test|build|lint)\b|\b(pytest|vitest|jest|tsc|eslint)\b|\bgo\s+(test|build)\b|\bdotnet\s+(test|build)\b|\bnode\s+scripts[\\/]\S*(test|build|bench|check)/i;
const GIT=/\bgh\s+(pr|issue|api|run)\b|\bgit\s+(push|commit|merge|rebase|pull|fetch|switch|checkout|worktree|add|stash|branch|cherry-pick)\b/i;
const EDIT=/\bapply_patch\b|\bSet-Content\b|\bOut-File\b|\bsed\s+-i\b/;
const READ=/^\s*(cat|head|tail|sed\s+-n|rg|grep|ls|find|wc|Get-Content|Get-ChildItem|Select-String|git\s+(diff|log|show|status|blame|rev-parse))\b/i;
const FILE_READ=/^\s*(cat|head|tail|sed\s+-n|Get-Content)\b/i;
/** The program a shell line runs: the first plain command word, past any cd, variable setup or loop keyword. */
function program(text){
 for(const statement of String(text).split(/[;\n]|&&|\|\|/)){
  const words=statement.trim().split(/\s+/);
  // What follows a here-string or heredoc opener is its content, not commands.
  if(/^@['"]/.test(words[0])||statement.includes('<<'))break;
  while(['do','then','else','time'].includes(words[0]))words.shift();
  const word=String(words[0]??'').split(/[\\/]/).pop().replace(/\.exe$/i,'').toLowerCase();
  if(/^[a-z][\w-]*(\.(cmd|bat|ps1|sh|py|js|mjs))?$/.test(word)&&!['cd','for','if','while','done','fi','set-location','foreach'].includes(word))return word;
 }
 return 'script';
}
const MARKS=[[/\bgh\s+pr\s+create\b/,'pr'],[/\bgh\s+pr\s+merge\b/,'merge'],[/\bgh\s+pr\s+(comment|review)\b/,'verdict'],[/\bgit\s+push\b/,'push'],[/\bgit\s+commit\b/,'commit']];
const CODEX_CMD=/cmd["']?\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)/s;

export function makeClassifier(extraTestPattern){
 const extra=extraTestPattern?new RegExp(extraTestPattern,'i'):null;
 function command(cmd){
  const text=String(cmd??'');
  const cat=TEST.test(text)||extra?.test(text)?'testing':GIT.test(text)?'git':EDIT.test(text)?'editing':READ.test(text)?'reading':'command';
  return {cat,name:`$ ${program(text)}`,label:short(text),mark:MARKS.find(([pattern])=>pattern.test(text))?.[1],fileRead:cat==='reading'&&FILE_READ.test(text)};
 }
 function claudeTool(name,input={}){
  if(name==='Bash'||name==='PowerShell')return command(input.command);
  if(['Read','Grep','Glob','WebFetch','WebSearch','ToolSearch'].includes(name))return {cat:'reading',name,label:short(`${name} ${base(input.file_path??input.path)||input.pattern||input.query||''}`),fileRead:name==='Read'};
  if(['Edit','Write','NotebookEdit'].includes(name))return {cat:'editing',name,label:`${name} ${base(input.file_path)}`};
  if(name==='Agent'||name==='SendMessage'||/start_session|send_message/.test(name))return {cat:'delegating',name:name.replace(/^mcp__/,''),label:short(`${name}: ${input.description??input.to??input.title??''}`)};
  return {cat:'command',name:name.replace(/^mcp__/,''),label:name.replace(/^mcp__/,'')};
 }
 /** Codex wraps shell calls in a JavaScript snippet: tools.exec_command({cmd:"..."}). */
 function codexCall(name,input){
  const text=typeof input==='string'?input:JSON.stringify(input??'');
  if(/apply_patch/.test(text))return {cat:'editing',name:'apply_patch',label:'apply_patch'};
  const cmd=CODEX_CMD.exec(text)?.[2];
  return cmd?command(cmd.replace(/\\(["'`\\])/g,'$1').replace(/\\[nr]/g,' ')):{cat:'command',name,label:short(`${name} ${text}`)};
 }
 return {command,claudeTool,codexCall};
}
