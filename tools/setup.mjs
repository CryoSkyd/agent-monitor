// Usage: node tools/setup.mjs <project folder> [--write]
import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {CardStore} from '../lib/cards.mjs';
import {claudeTranscripts} from '../lib/agents/claude.mjs';
import {codexHomes} from '../lib/agents/codex.mjs';
import {apply,plan} from '../lib/setup.mjs';

const args=process.argv.slice(2),target=args.find(arg=>!arg.startsWith('--'));
if(!target||!existsSync(target)){console.error('Usage: node tools/setup.mjs <project folder> [--write]');process.exit(2);}
const project=resolve(target),write=args.includes('--write');
const {tasksDir,writes}=plan(project);

console.log(write?'Written:':'Would write (run again with --write):');
for(const {name,note} of writes)console.log(`  ${name}: ${note}`);
if(!writes.length)console.log('  nothing, the project is already set up');
if(write)apply(writes);

const cards=new CardStore(join(project,tasksDir));
cards.refresh();
const count=[...claudeTranscripts(project,0)].length,codex=codexHomes().map(home=>home.account);
const gh=spawnSync('gh',['auth','status'],{cwd:project}).status===0;
const settings=existsSync(join(project,'.agent-monitor.json'));
const limits=existsSync(join(homedir(),'.agent-monitor','claude-limits.json'));
console.log(`
What the dashboard will find:
  Task cards in ${tasksDir}/: ${cards.cards().size}
  Claude Code transcripts for this folder: ${count}
  Codex accounts on this computer: ${codex.length?codex.join(', '):'none'}
  GitHub pull requests: ${gh?'yes':'no, gh is missing or signed out'}
  Claude usage limits: ${limits?'yes':'no, the status line helper is not installed'}
  Project settings file: ${settings?'yes':'none, defaults are used'}`);
