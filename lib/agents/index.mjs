import claude from './claude.mjs';
import codex from './codex.mjs';

/**
 * One adapter per kind of coding agent. To support another agent, add a file here and list it below.
 *
 * An adapter is `{name, Run, transcripts, limits?}`:
 * - `transcripts({project, cutoff, home})` yields `{path, ...options}` for each transcript file changed since `cutoff`.
 * - `Run` extends the class in `../run.mjs`. It is built as `new Run(path, shared, options)` and reads its file one line at a time in `line(text)`,
 *   calling the base methods (`thinking`, `callStarted`, `callEnded`, `idle`, `usage`, `said`) as things happen.
 * - `limits(config)` is optional: usage limits kept outside the transcripts, as `[{account, plan, asOf, windows}]`.
 */
export const AGENTS=[claude,codex];
