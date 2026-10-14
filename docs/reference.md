# pi-agent-runner reference

Everything the [README](../README.md) leaves out: options, statuses,
timeouts, guards, backends, the live registry and known limitations.

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
  idleTimeoutMs: 600_000, // stop a child that went silent
  wrapUpMs: 180_000, // grace to answer once timeoutMs expires
  timeoutMs: 1_800_000, // wall-clock cap
  toolTimeoutMs: 120_000,
  signal,
  onUpdate: ({ turn, tool, toolCalls, tokens, durationMs, recentOutput }) => {},
  transcriptPath: '.runs/child.jsonl', // optional
});
// result: { status, value, usage, model?, error?, transcriptPath?,
//            wrappedUp? }
// usage: { input, output, cacheRead, cacheWrite, cost, turns, toolCalls,
//          durationMs, waitedMs }
```

### `startAgent`: a long-lived handle

`startAgent(options)` creates the session once and returns an `AgentHandle`;
`runAgent` is `startAgent` + one `run` + `dispose`. `StartAgentOptions` is
`RunAgentOptions` minus `task`, `timeoutMs`, `wrapUpMs`, `idleTimeoutMs`,
`toolTimeoutMs` and `onUpdate` (those belong to `run`, as `TurnOptions`);
`signal` cancels creation only.

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
  file once it exists. Pi restores the model saved in the file; the
  runner then sets the requested model (`model`, or the parent's when
  inheriting) and thinking level on the revived session, so the model of
  the original run does not leak into the new one.

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

Timeouts:

- `timeoutMs`: wall-clock limit of the whole run, a hard cap on cost. Alone,
  it stops the run (`timed_out`, `timed out after <n>ms`) the moment it
  expires, however busy the child is.
- `wrapUpMs`: grace after `timeoutMs`. Instead of stopping, the runner steers
  the child with `WRAP_UP_MESSAGE` ("Time limit reached. Do not start new
  work. Finish or stop the current step, then reply now with your final
  answer: what you did, what is left, and anything the caller must know.";
  for a structured run, "... then call submit_result now with what you
  have.", see `wrapUpMessage(structured)`) and waits `wrapUpMs` more. A
  generation that ends in time keeps its normal outcome (`completed` with
  its answer or structured result) and the result carries `wrappedUp: true`;
  otherwise it ends `timed_out` with `timed out after <n>ms; no final answer
within the <m>ms wrap-up`. If the steer is refused the run stops at once.
  The live registry marks such a run `wrappingUp` and the runs view shows
  `wrapping up`.
- `idleTimeoutMs`: stops a child that made no progress: `timed_out` with
  `no activity for <n>ms` when no child event arrived for that long. Any
  event resets it (streamed tokens included). It does not run while a
  top-level tool executes (that is `toolTimeoutMs`'s job). An idle child
  cannot answer, so there is no wrap-up.
- `toolTimeoutMs`: limits each tool, counted from the moment the tool
  actually runs (after permission gates).

Recommended: `idleTimeoutMs: 600_000`, `wrapUpMs: 180_000` and a generous
`timeoutMs` as the cost cap: a working child is never cut off without a
chance to report, and a stuck one is found in ten minutes. All four pause
while a person is asked anything permission-related in the parent;
`usage.waitedMs` is the total time the run timer was paused that way. Both
backends behave the same.

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

Caller extension modules: `extensionPaths?: string[]` (relative paths resolve
against `cwd`) names modules whose default export is an `ExtensionFactory`.
Same position and semantics as `extensionFactories`, but by path, so they
work with both backends.

Backend: `backend?: 'in-process' | 'process'` (default `'in-process'`).
`'process'` runs the child as a `pi --mode rpc` subprocess in its own
process group. A child wedged in a tool that ignores abort is then killed:
`abort()`, `signal`, `timeoutMs`, `idleTimeoutMs` and `toolTimeoutMs` ask Pi
to abort and, if the run has not ended after 5 s, SIGKILL the whole group (tool grandchildren
included) and end the generation as `cancelled` / `timed_out`. `dispose()`
closes stdin, then SIGTERM after 2 s, then SIGKILL after another 2 s; the
group is also killed when the parent exits and when the child dies on its
own (the generation fails with `child process exited with code X / signal
Y`). Trade-offs:

- Slower start: a full Pi boot per child, extensions included, instead of an
  in-process session; more memory per child.
- `extensionFactories` cannot cross the process boundary and is refused
  (`failed` at start); use `extensionPaths`.
- Providers registered only in the parent are not available in the child;
  providers from installed packages (`providerExtensions`) load as usual.
- Dialogs of the child (permission asks) relay to `parent.ctx.ui`; pass the
  plugin's `ctx.ui` there, otherwise every dialog is cancelled at once. The
  timers pause while a relayed dialog is open. `permissionAsks: 'deny'`
  cancels at once. Child notifications are forwarded to `ctx.ui.notify`,
  prefixed with the label name.
- The guards, prompt freeze, tool-start signal and `submit_result` run in
  the child through the runner's own extensions (`dist/child-extension.js`,
  `dist/child-extension-tail.js`); `submit_result` is validated in the
  parent. Nesting depth is passed down in `PI_AGENT_RUNNER_DEPTH`.

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

## Labels and the live registry

`label: { name, context? }` on `runAgent`/`startAgent` names a run for
display (`name` defaults to `agent`; `context` is free text such as
`ralph US-002`).

Every child is listed in a process-wide registry, shared by all installed
copies of the runner (it lives on `globalThis`, so Spiral's and Opium's
children show in one list):

```ts
import { liveRuns, isPossiblyStuck } from 'pi-agent-runner';
const registry = liveRuns();
const stop = registry.subscribe(() => render(registry.list())); // every change
```

`list()` returns snapshot copies, oldest first. A `LiveRun` has `id`
(child sessionId), `parentSessionId`, `name`, `context`, `model`, `state`
(`starting | running | idle | <RunStatus>`), `waitingForUser`,
`currentTool`, `turns`, `toolCalls`, `tokens`, `cost`, `generation`,
`startedAt`, `lastActivityAt`, `lastStepAt`, `endedAt`, `error`,
`transcriptPath` (absolute path of the child's session file; it may not exist
yet). The state
is `starting` until the first generation, `running` during one, then the
generation's terminal status until the next generation (`idle` is a
`startAgent` handle that has not run yet). Counters belong to the current
generation and are settled from the runner's own usage accounting when it
ends. A run is dropped 10 minutes after its session is disposed; the list
holds at most 200 runs. `waitingForUser` is set while a forwarded
permission prompt of that child is open. `isPossiblyStuck(run, now)` is
true for a running child that is not waiting for a person and has had no
turn end or tool end for `STUCK_AFTER_MS` (2 minutes). The listener fires
on every event, streaming deltas included: throttle renders.

The runs view (`mountRunsView`, or `renderRunsView` for one render) draws one
row per run: glyph, name (`g2` after it from generation 2), context, model,
status, usage and elapsed time. Status, usage and the end of the row follow
these rules:

- A running row shows the current tool (`thinking` when none, `wrapping up`
  after `timeoutMs`). Once `lastActivityAt` is 30 s old (`QUIET_AFTER_MS`)
  it adds `· quiet m:ss`.
- A row turns `▲` (stuck, counted in the header) only when
  `isPossiblyStuck` holds and the run is also quiet. A child that streams a
  long answer or tool output is slow, not stuck.
- Usage is the cost (`$0.42`, `<$0.01`) when the provider reports one above
  zero, otherwise tokens (`3.9k tok`); subscription providers report no cost.
- A `failed`, `bad output`, `timed out` or `cancelled` row ends with a
  one-line reason from `error` when there is room. Reasons that only repeat
  the status or the clock (`aborted`, `timed out after 10:00`) are left out.
- Narrow terminals drop the model, then usage, then context.

## The /agents command

Pi widgets take no input, so inspecting and controlling a child lives behind
a command:

```ts
import { registerAgentsCommand } from 'pi-agent-runner';

export default function (pi: ExtensionAPI) {
  registerAgentsCommand(pi, { shortcut: 'ctrl+shift+a' }); // shortcut optional
}
```

`registerAgentsCommand(pi, options?)` registers `/agents` and, with
`options.shortcut` (a Pi key id, none by default), the same picker on that
key. Call it once at extension load.

`/agents` lists the runs in the live registry, active first and then the
most recent. In the TUI you pick one and then an action; with no UI
(print/RPC mode) it notifies the list instead. With no runs it says so.

- **Recent activity**: an overlay with the last 50 events of the run (tool
  calls with their command or path, tool errors, the child's text, generation
  start and end). It updates live; `↑` `↓` `PgUp` `PgDn` scroll, `Esc` or
  `q` closes.
- **Cancel run** (running runs only): asks for confirmation, then aborts the
  current generation, as `abort()` does. A `startAgent` handle keeps its
  session and can `run` again.
- **Take over** (finished runs whose transcript file exists): notifies the
  command `pi --fork <transcript>`. Pi writes a new session file and leaves
  the original alone, so a live handle may keep using it. The fork restores
  the conversation only: not the child's extensions, tools or frozen system
  prompt.

One registration across copies: Pi does not dedupe commands, so two
extensions registering `agents` would end up as `agents:1` and `agents:2`,
neither answering `/agents`. Copies of this package therefore claim the
command (and the shortcut) on `globalThis` and only the first registers.
The owner releases its claim on `session_shutdown`, so `/reload` leaves one
`/agents`, not none.

Runs tracked by an older copy of the package (before this command) keep no
activity buffer or control handle: the picker still lists them, but their
actions show as unavailable.

`AgentsCommandOptions`, `ActivityEntry` (`at`, `kind`: `tool | error | text |
generation`, `text`) and `RunControl` (`cancel()`) are exported as types.

## Known limitations

- Live activity of `claude-bridge` children is sparse early on. The bridge
  runs tools in Pi (no tool runs inside the Claude process) and emits normal
  Pi events, but nothing reaches Pi until Claude Code has produced its first
  streamed block, and `message_end` (usage) arrives only when a message
  ends. The registry therefore also uses streamed usage on `message_update`
  and any provider event as activity; `tokens` are authoritative at the end
  of the generation.

- An orphaned permission prompt (one whose decision event never arrives)
  keeps the run and tool timers paused until the tracker drops it after its
  30-minute cap. Until then `timeoutMs`, `wrapUpMs`, `idleTimeoutMs` and
  `toolTimeoutMs` do not fire;
  `signal` and `dispose()` still cancel the run at once.
- `pi-claude-bridge` registers its provider at load only in the first module
  instance per process. Later instances register at `session_start`, after
  the runner has resolved the model. Without a bridge provider in the parent,
  only one live bridge child works at a time. A real Pi parent is fine: the
  child inherits the parent's provider.
