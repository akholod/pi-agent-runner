# pi-agent-runner

In-process child-agent runner for Pi plugins (Spiral, Opium). A child is
a second `AgentSession` created with Pi's SDK (`createAgentSession`) in the
parent's process; no `pi-subagents` needed.

Status: skeleton. Design, spike results and the task list live in
`~/pi_sandbox/spiral/docs/standalone-runner-plan.md` and
`standalone-runner-tasks.md`.

## API

```ts
import { runAgent } from 'pi-agent-runner';

// Inside a Pi extension: `pi` is the ExtensionAPI, `ctx` the current context.
const result = await runAgent({
  parent: { events: pi.events, ctx },
  cwd,
  systemPrompt, // replaces Pi's prompt
  task,
  tools: ['read', 'grep', 'find', 'ls'],
  model: 'inherit', // or 'provider/id'
  extensions: 'none', // or { packages: ['pi-mcp-adapter'] }
  timeoutMs: 600_000,
  toolTimeoutMs: 120_000,
  signal,
  onUpdate: ({ turn, tool, toolCalls, tokens, durationMs, recentOutput }) => {},
  transcriptPath: '.runs/child.jsonl', // optional
});
// result: { status, value, usage, model?, error?, transcriptPath? }
// usage: { input, output, cacheRead, cacheWrite, cost, turns, toolCalls,
//          durationMs, waitedMs }
```

### `startAgent`: a long-lived handle

`startAgent(options)` creates the session once and returns an `AgentHandle`;
`runAgent` is `startAgent` + one `run` + `dispose`. `StartAgentOptions` is
`RunAgentOptions` minus `task`, `timeoutMs`, `toolTimeoutMs` and `onUpdate`
(those belong to `run`); `signal` cancels creation only.

```ts
const agent = await startAgent({ parent, cwd, systemPrompt, tools });
const first = await agent.run('review src/', { timeoutMs: 60_000, signal });
// while a run is in flight: 'queued'; between runs: 'idle'
await agent.steer('also check the tests');
const second = await agent.run('now fix it', { onUpdate });
await agent.dispose();
```

- A `run` is one generation. Timeouts, `signal`, `onUpdate`, `usage`,
  `turns` and `toolCalls` are per generation and count only its messages.
  `run` rejects when the handle is running or disposed; otherwise it never
  rejects and reports a status.
- `abort()` ends the current generation as `cancelled` and keeps the session
  for the next `run`; it resolves once the generation has ended, so `run`
  may follow at once, and does nothing when idle. `dispose()` is idempotent
  and aborts a running generation first, so its `run` resolves `cancelled`.
- `steer(text)` and `followUp(text)` resolve `'queued'` while a generation
  runs, `'idle'` when none does (nothing is queued: put the text in the next
  `run`) and `'disposed'` after `dispose`. Pi's refusal (for example text
  starting with `/`) is a rejected promise. Acceptance is not delivery: when
  a generation ends, still-undelivered messages are cleared and returned as
  `result.dropped`.
- Structured `result`, `tools`, `model`, guards and `maxDepth` are fixed at
  start. Each generation gets a fresh `submit_result` collector and its own
  correction turn; a `submit_result` outside a generation is refused.
- `transcriptPath` works as in `runAgent`. `resumeFrom` (relative to cwd)
  continues an existing session file in place; it must exist (checked before
  any session is created) and excludes `transcriptPath`. Do not resume a
  file another live handle holds. `handle.transcriptPath` is the absolute
  file once it exists.

Statuses: `completed | failed | timed_out | cancelled |
structured_output_failed`.

Transcript: `transcriptPath` (relative to cwd, must not exist) persists the
child session as Pi's session JSONL, kept on every outcome; `pi --session
<file>` opens and continues it. Without it nothing is written.

Structured output: pass `result: { kind: 'structured', schema }` (a JSON
Schema). The child gets a `submit_result` tool (`SUBMIT_RESULT_TOOL`) whose
`value` must match the schema, and the task gets an instruction to call it;
the system prompt is never touched. On `completed`, `value` is the validated
payload, not the text. The first valid call is final; later calls are
rejected. An invalid call returns the validation errors to the child. The run
ends with `structured_output_failed` after a second invalid call, or if the
child finishes without a valid call even after one correction prompt (the
correction turn runs under the same `timeoutMs`). An invalid schema fails the
run before any session is created.

Timeouts: `timeoutMs` limits the whole run; `toolTimeoutMs` limits each
tool, counted from the moment the tool actually runs (after permission
gates). Both pause while a person is asked anything permission-related in
the parent; `usage.waitedMs` is the total time the run timer was paused
that way.

Guards: an inline extension loaded before every other one refuses a call
before any permission gate can open a dialog. It enforces the `tools`
allowlist (nested calls included), `gitGuard` (default on: blocks `git push`,
`reset --hard`, `clean -f`, `branch -D`, discarding `checkout`/`restore`,
`stash drop/clear`; a guardrail, not a sandbox) and `readRoots` (paths
outside cwd and the roots are refused). `maxDepth` (default 1) stops a child
from starting its own child; the depth is counted across package copies.

Policy: `policyExtensions` (default `['@gotgenes/pi-permission-system']`)
load into every child when installed, even with `extensions: 'none'`, so
the user's permission rules gate child tool calls too.

Caller extensions: `extensionFactories?: ExtensionFactory[]` (type from
`@earendil-works/pi-coding-agent`) loads inline extensions into every child,
right after the runner's guards (allowlist, git guard, read roots, depth),
before permission gates and before the prompt-freeze and tool-start hooks:
a call the guards refuse never reaches them, and a call they block never
opens a permission dialog. They run in the child's process like any extension; use
them for per-call policies such as loop guards (`tool_call` / `tool_result`
handlers). With `startAgent` each factory loads once per session, not per
generation.

Permission asks: `permissionAsks: 'forward'` (default) registers the child
with pi-permission-system: an `ask` opens a dialog in the parent and the
timers pause meanwhile. `'deny'` leaves the child unregistered, so it has no
UI and an `ask` is refused at once; only explicit `allow` passes. Use it for
runs nobody is watching.

Behavior the spikes settled:

- Model runtime: a fresh `ModelRuntime` plus the parent's providers.
- A model of an extension provider (for example `claude-bridge`) loads that
  extension in the child, even with `extensions: 'none'`.
- The child is registered with `pi-permission-system`, so its permission
  prompts reach the parent's dialog; the run timer pauses while a person is
  asked.
- The system prompt is frozen in `before_agent_start` by a hook loaded
  last.
- Structured output only through a `submit_result` tool call.

## Known limitations

- An orphaned permission prompt (one whose decision event never arrives)
  keeps the run and tool timers paused until the tracker drops it after its
  30-minute cap. Until then `timeoutMs` and `toolTimeoutMs` do not fire;
  `signal` and `dispose()` still cancel the run at once.
- `pi-claude-bridge` registers its provider at load only in the first module
  instance per process. Later instances register at `session_start`, after
  the runner has resolved the model. Without a bridge provider in the parent,
  only one live bridge child works at a time. A real Pi parent is fine: the
  child inherits the parent's provider.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
npm run test:live  # real models, ~1 min; see below
```

`test:live` runs a text child, a structured child, a cancelled child and a
git-guard check against every model in `RUNNER_LIVE_MODELS` (default
`openai-codex/gpt-6-luna,claude-bridge/claude-sonnet-5-5`), with the
operator's `~/.pi/agent` auth. `npm test` skips it.

`spikes/` holds the throwaway phase 0 spikes; it is excluded from lint and
typecheck. Load one into Pi with `pi -e spikes/child.ts`.
