---
name: setup-monitor
description: Make the current project ready for the agent-monitor dashboard - adds the task card and dispatch naming conventions to the project's agent instructions (AGENTS.md for Codex and others, CLAUDE.md for Claude Code), adds a task card template, and reports what the dashboard will find. Use when the user runs /setup-monitor, asks to set a project up for the agent dashboard, or the dashboard shows runs under Sessions instead of tasks.
---

# Set a project up for agent-monitor

The dashboard reads transcripts that Claude Code and Codex already write, so recording needs no setup. What setup adds is the naming that ties each run to a task. The work is done by `tools/setup.mjs` at the plugin root, two folders above this skill's base directory. It needs Node 22 or newer.

## Steps

1. Preview. This writes nothing:

   ```
   node <plugin root>/tools/setup.mjs <project folder>
   ```

2. Tell the user which files it would write, then run it again with `--write`. Running `/setup-monitor` is the user's yes for these files; ask first only if the project folder is not the one they are working in.
3. Relay the "What the dashboard will find" lines, and for each "no" give the fix from the table below.
4. If the project already has its own task format or dispatch process, read `../monitor/references/contract.md` and reconcile: adjust the written section to the project's card folder and id style instead of leaving two competing rules.
5. Offer to start the dashboard (the `monitor` skill).

## What it writes

| File | Change |
|---|---|
| `AGENTS.md` | A marked "Agent dashboard conventions" section, added at the end. Created if missing. |
| `CLAUDE.md` | Created with `@AGENTS.md` if missing. If it exists and does not import AGENTS.md, it gets the same section. |
| `<tasks folder>/TEMPLATE.md` | A task card template, in the existing `docs/tasks`, `tasks` or `.tasks` folder, or a new `tasks`. |

The section sits between `agent-monitor:start` and `agent-monitor:end` comments. Running setup again replaces it in place and leaves the rest of the file alone. Nothing is committed; leave that to the user.

## Fixes for the report

| Line | Fix |
|---|---|
| Task cards: 0 | Normal for a new project. Cards are copied from the template as work is planned. |
| Claude Code transcripts: 0 | Normal until Claude Code has run in this folder. |
| Codex accounts: none | Normal if Codex is not used. |
| GitHub pull requests: no | Install `gh` and run `gh auth login`. Phases then come from cards and transcripts alone. |
| Claude usage limits: no | See "Claude usage limits" in the `monitor` skill. It changes the user's own settings file, so propose it and wait for a yes. |
| Project settings file: none | Fine. Write `.agent-monitor.json` only when a default is wrong, most often `testPattern`. |
