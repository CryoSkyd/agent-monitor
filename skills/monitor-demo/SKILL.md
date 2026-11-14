---
name: monitor-demo
description: Run the agent-monitor dashboard on invented, continuously generated demo data, optionally themed around a subject the user names (for example "/monitor-demo pokemon" makes every task about Pokemon). Use when the user runs /monitor-demo, asks for a demo or sample of the agent dashboard, or wants to see it without their own data.
---

# Demo dashboard

`tools/demo.mjs` at the plugin root (two folders above this skill's base directory) writes an invented project to a temporary folder, keeps its agents working for as long as it runs, and serves the dashboard on it. It reads none of the user's transcripts. Node 22 or newer.

## Steps

1. **No subject given**: skip to step 3 without `--theme`. The built-in project is an online shop.
2. **Subject given**: write a theme file to your scratch or temporary folder, never into the user's project:

   ```json
   {"name": "pokedex-app", "tasks": [
     {"title": "Add evolution chains to Pokedex entries", "area": "evolution"},
     {"title": "Fix type matchup chart for dual types", "area": "types"}
   ]}
   ```

   - `name`: a plausible software project about the subject, lowercase words joined by dashes.
   - `tasks`: 12 to 16 of them. Each `title` is a short imperative engineering task that clearly belongs to the subject, under 50 characters. Each `area` is one lowercase word, used in invented file paths and branch names; make them all different.
   - Optional `"roles": {"worker": "pilot", "checker": "mission-reviewer"}` renames the two agent roles when the subject is not software, such as missions or a kitchen. The checker's name must contain "review". Titles then describe that world's jobs, not engineering tasks.
   - Mix features, fixes and chores. No real people, no private information, nothing from the user's own projects.
3. Start it in the background so it outlives the turn:

   ```
   node <plugin root>/tools/demo.mjs [--theme <theme file>] [--port 4600]
   ```

4. Read the URL it prints and give it to the user. If the port is taken the server moves to the next free one. Do not open a browser unless asked.

## What the user will see

- About three hours of invented history at once, then live activity: agents start, call tools, finish, hand over to reviewers, and new tasks keep arriving.
- Some agents are made to get stuck on a failing test, so the warnings have something to show.
- Usage limits rise and reset on a loop. CPU and memory are the real machine's.
- Tool calls stay software-like (tests, builds, edits) whatever the subject.
- No pull request data: the demo has no GitHub repository, so PR numbers do not open.

It stops when the session that started it ends. Each start replaces the previous demo's data.
