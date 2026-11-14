import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const START='<!-- agent-monitor:start -->',END='<!-- agent-monitor:end -->';
const TASK_DIRS=['docs/tasks','tasks','.tasks'];

export const conventions=tasksDir=>`${START}
## Agent dashboard conventions

The agent-monitor dashboard reads the transcripts agents already write. Agents never report to it. These rules let it tie each run to a task.

- **Task cards**: one Markdown file per task in \`${tasksDir}/\`, copied from \`${tasksDir}/TEMPLATE.md\`. Keep \`status\`, \`agent\`, \`branch\` and \`pr\` in the front matter current. Statuses: \`proposed\`, \`ready\`, \`claimed\`, \`in-review\`, \`changes-requested\`, \`needs-human\`, \`done\`.
- **Starting an agent on a card**: the first line of its prompt names the role and the card id, such as \`Act as Coder for T-123\` or \`Act as Reviewer for PR #45 (T-123)\`. A subagent description does the same: \`Coder T-123 short topic\`.
- **One card per run.** A run that names several cards is filed under the first.
- **Branches**: one branch per card with the id in its name, such as \`task/T-123-short-slug\`, and one pull request per branch.
${END}`;

export const TEMPLATE=`---
id: T-000
title: Short imperative title
status: proposed
agent:
branch:
pr:
depends_on: []
---

## Goal

## Done when

## Result
`;

/** Puts the block into a document, replacing an earlier copy so that setup can be run again. */
export function withBlock(text,block){
 const from=text.indexOf(START),to=text.indexOf(END);
 if(from>=0&&to>from)return text.slice(0,from)+block+text.slice(to+END.length);
 return `${text.replace(/\s*$/,'')}${text.trim()?'\n\n':''}${block}\n`;
}

/** The files setup would write for a project, as {path, text, note}; files already up to date are left out. */
export function plan(project){
 const read=name=>{try{return readFileSync(join(project,name),'utf8');}catch{return null;}};
 const tasksDir=TASK_DIRS.find(dir=>existsSync(join(project,dir)))??'tasks';
 const block=conventions(tasksDir),agents=read('AGENTS.md'),claude=read('CLAUDE.md'),writes=[];
 const add=(name,text,note)=>{if(read(name)!==text)writes.push({path:join(project,name),name,text,note});};
 add('AGENTS.md',withBlock(agents??'',block),agents==null?'new file, read by Codex and other agents':'conventions section added or refreshed');
 // Claude Code reads CLAUDE.md only, so it either imports AGENTS.md or carries the section itself.
 if(claude==null)add('CLAUDE.md','@AGENTS.md\n','new file that imports AGENTS.md for Claude Code');
 else if(!/@AGENTS\.md/.test(claude))add('CLAUDE.md',withBlock(claude,block),'conventions section added or refreshed');
 if(read(`${tasksDir}/TEMPLATE.md`)==null)add(`${tasksDir}/TEMPLATE.md`,TEMPLATE,'task card template');
 return {tasksDir,writes};
}

export function apply(writes){
 for(const {path,text} of writes){mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);}
}
