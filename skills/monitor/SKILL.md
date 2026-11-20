---
name: monitor
description: Start, open or set up the agent-monitor dashboard for the current project - a live local page showing which agents are running, on which task, what each is doing, tokens, usage limits and machine load. Use when the user asks for the agent dashboard or monitor, wants to watch running agents or tasks, asks why a task shows no agent or the wrong phase there, or wants a project made ready for it.
---

# agent-monitor

A read-only local dashboard. The server lives at the plugin root, two folders above this skill's base directory: `<base>/../../server.mjs`. It needs Node 22 or newer and no install step.

## Start it

1. Check whether one is already running for this project: request `http://127.0.0.1:4599/api/project` (then 4600, 4601 if the first answers for another project). It returns the project `name` and `path`, plus `share` (true when it is shared with other machines) and `peers` (how many other machines it shows). If the path matches and it already does what the user asked for, give the user that URL and stop. If the user asked for `--share` or `--peer` and the running one lacks it, see "Several machines" below.
2. Otherwise start the server in the background, so it outlives the turn, with the project folder as the argument:

   ```
   node <plugin root>/server.mjs <project folder>
   ```

   It prints its URL. If the port is taken it moves to the next free one, so read the printed line instead of assuming 4599.
3. Give the user the URL. Do not open a browser unless asked.

The server stops when the session that started it ends. For an all-day monitor, tell the user to run the same command in their own terminal.

Flags: `--port N`, `--hours N` (how far back to load, default 24), `--no-gh` (skip pull requests), `--share` and `--peer URL` (next section). Words the user adds after the command, as in `/monitor --share`, are flags to pass on.

## Several machines

When agents for one project run on more than one computer, each runs its own monitor and one of them shows them all. "Several machines" in the README at the plugin root has the full description.

**`--share`** (on each machine that is not the one being looked at) lets other machines on the local network read this one's summary.

1. If a monitor is already running for the project without `share`, it has to be restarted to turn sharing on. Stop it only if this session started it; otherwise tell the user to stop it where they started it, and wait.
2. Start the server with `--share` and read what it prints:
   - `Created the shared secret in <file>` appears the first time. Relay the file's path and tell the user to copy that file to the same place on every other machine. Never print, read out or paste the secret itself: this transcript is shown on the dashboard.
   - `Shared with other machines on this network as "<name>": http://<address>:<port>` gives the address the viewing machine needs. Relay it.
3. Tell the user the operating system's firewall may ask to allow Node, and that someone has to approve it on that machine.
4. Say plainly that a monitor started from this session stops when the session ends, and give the terminal command for an always-on one: `node <plugin root>/server.mjs <project folder> --share`.

**`--peer <address>`** (on the machine being looked at, once per other machine) adds that machine's agents to this page. The secret file must already be here: if the server prints that other machines will refuse it, the file is missing. A machine that cannot be reached shows as unreachable on the page with the reason; the usual causes are the firewall, a wrong address, a different secret, or the other monitor not running with `--share`.

## Project settings

Optional. A `.agent-monitor.json` in the project folder is read automatically; a config file anywhere can be passed in place of the folder. Keys: `name`, `tasksDir`, `hours`, `limitWarn`, `claudeUsagePoll`, `testPattern`, `github`, `port`. Write one only when a default is wrong for the project, most often `testPattern`: a regular expression for the project's own test and build commands, so they show as testing instead of a plain command.

## Making a project ready

The dashboard works from what agents already write to disk. It is most useful when the project follows the contract in `references/contract.md`. To set a project up, use the `setup-monitor` skill. Read the contract when runs show under Sessions instead of a task, or when writing or changing a dispatch or architect process for a project.

## Claude usage limits

Codex limits come from its transcripts. Claude limits reach only a status line command, so they need `tools/claude-statusline.mjs` (plugin root) set as the status line in the user's `~/.claude/settings.json`:

```json
"statusLine": {"type": "command", "command": "node <plugin root>/tools/claude-statusline.mjs"}
```

That file is the user's own configuration: propose the change and make it only with their yes. If they already have a status line, do not replace it; tell them the helper can be called from theirs.

## When something looks wrong

- **A run is under Sessions, not its task**: its prompt or description names no known card id. See the contract.
- **Claimed, no agent**: the card says claimed and no live transcript names it. The agent ended, or runs somewhere with no local transcript.
- **Stopped responding**: no transcript output for 10 minutes while thinking, or 2 hours inside one tool call. An unattended Codex run inside a command is marked after about two minutes, since its commands always hand back within their stated wait.
- **No pull request data**: `gh` is missing or signed out; phases then come from cards and transcripts alone.
