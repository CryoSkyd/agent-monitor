# What a project provides

Nothing here is required to start the dashboard. Each item makes one part of it accurate.

## Task cards

One Markdown file per task under `docs/tasks/`, `tasks/` or `.tasks/` (or `tasksDir`), subfolders included. Files named README or TEMPLATE are skipped. Front matter:

```
---
id: T-123
title: Short imperative title
status: ready
agent: coder-name
branch: task/T-123-short-slug
pr:
depends_on: [T-100, T-101]
dispatch: manual
---
```

| Field | Used for |
|---|---|
| `id` | Ties runs and pull requests to the task. Letters, a dash, digits. |
| `title` | Row title |
| `status` | Phase. One of `proposed`, `ready`, `claimed`, `in-review`, `changes-requested`, `needs-human`, `done` |
| `branch` | Finds the task's pull request |
| `pr` | The pull request number, when known |
| `depends_on` | Blocked and "unblocks" |
| `dispatch` | `manual` puts a ready card under Needs you |
| `agent`, `risk`, `feature` | Shown as facts; optional |

Without cards, tasks are still grouped by any `ABC-123` style id found in prompts, with no queue, blocked or needs-you lists.

## Dispatch prompts

The dashboard ties a run to a task from the first lines an agent is given. For every agent that works on a card:

- **Name the role and the card id first.** Subagent description: `Coder T-123 short topic`, `Reviewer T-123 PR 45`, `Coder T-123 fix round 2`. Prompt: open with `Act as Coder for T-123` or `Act as Reviewer for PR #45 (T-123)`.
- **Reviewers name both the pull request and the card.** With only the PR number the task is found through GitHub, which fails when `gh` is unavailable.
- **One card per run.** A run that names several cards is filed under the first.
- **Use the subagent type for the role** where the tool has one (`coder`, `reviewer`); the role shown comes from it. For Codex, the role comes from `act as <role>` in the prompt.

Orchestrating sessions (an architect or dispatcher) need nothing: they appear under Sessions, and show "waiting on agents" while their subagents run.

## Branches and pull requests

- One branch per card with the id in its name, such as `task/T-123-short-slug`, and one pull request per branch.
- Label a pull request `needs-human` to put its task under Needs you.
- The phase "awaiting review" means an open pull request with no reviewer running; "in review" means a reviewer run is live.

## What agents should not need to do

Agents do not report to the dashboard and nothing is added to their prompts beyond the naming above. Activity, tokens, timing and commands are read from the transcripts the tools already write.
