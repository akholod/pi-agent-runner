# pi-agent-runner reference

Everything the [README](../README.md) leaves out: options, statuses,
timeouts, guards, backends, the live registry and known limitations.

## Binding the host runtime

The runner never imports Pi's SDK, `@earendil-works/pi-tui` or `typebox` for
values. The extension hands them over, so the runner always uses the copy the
host loaded, not one sitting next to it in `node_modules`. Why: Pi loads an
extension's own `.ts` through a loader that maps these packages to the host
copies, but files inside `node_modules` (the compiled runner) are imported
natively and would get whatever copy is installed beside them.

Call `bindHostRuntime` from the `.ts` entry of every extension that uses the
runner, before any other runner API (`runAgent`, `startAgent`,
`createPiSessionFactory`, `mountRunsView`, `registerAgentsCommand`, MCP
helpers). Importing the runner without binding is fine; nothing reads the host
at import time.

```ts
import * as hostPi from '@earendil-works/pi-coding-agent';
import * as hostTui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from 'pi-agent-runner';

export default function extension(pi: hostPi.ExtensionAPI) {
  bindHostRuntime({ pi: hostPi, tui: hostTui, typebox: { Unsafe, Compile } });
  // existing initialization follows
}
```

### `bindHostRuntime(host: HostRuntime): void`

Validates the host, then installs it. Synchronous; throws on a bad host.

```ts
interface HostRuntime {
  pi: PiRuntime; // SDK exports the runner uses
  tui: TuiRuntime; // pi-tui exports the runner uses
  typebox: { Unsafe: typeof Unsafe; Compile: typeof Compile };
  processCommand?: readonly [string, ...string[]]; // see Process backend
}
```

- `pi` (`PiRuntime`): `VERSION`, `getAgentDir`, `getPackageDir`,
  `SettingsManager` (`create`), `DefaultPackageManager`,
  `DefaultResourceLoader`, `createEventBus`, `ModelRuntime` (`create`),
  `resolveCliModel`, `createAgentSession`, `SessionManager` (`open`,
  `inMemory`), `ProjectTrustStore`, `createMcpExtension`, `createCodemodeExtension`. Pass the whole
  `@earendil-works/pi-coding-agent` namespace; the runner copies just these
  members.
- `tui` (`TuiRuntime`): `Key` (with `escape`, `up`, `down`, `pageUp`,
  `pageDown`), `matchesKey`, `truncateToWidth`, `visibleWidth`,
  `wrapTextWithAnsi`. `pi-ai` is not passed: the host's `ModelRuntime` and
  `createAgentSession` already use the host's AI package.
- `typebox`: `Unsafe` from `typebox` and `Compile` from `typebox/compile`.
  Structured `result` schemas are compiled with them.
- `processCommand` (optional): a non-empty array of non-empty strings,
  `[command, ...args]`. Anything else throws a `TypeError`.

A missing export, a non-function where a function or static method is
expected, or no string `VERSION` throws `bindHostRuntime: host is missing
<capability> (host VERSION <version>)`.

### `getHostRuntimeInfo()`

Reports what is bound, for diagnostics. It does not need the binding.

```ts
import { getHostRuntimeInfo } from 'pi-agent-runner';

getHostRuntimeInfo();
// { bound: false }
// { bound: true, source: 'injected', hostVersion: '1.5.0',
//   testedVersions: ['1.1.0', '1.5.0'], warnings: [] }
```

`warnings` holds the compatibility warnings recorded at binding (see the
version policy).

### Errors

| Code                            | When                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_AGENT_RUNNER_HOST_UNBOUND:` | The runtime is used before `bindHostRuntime`. Message: `Call bindHostRuntime() from the Pi extension entry before using the runtime.`         |
| `HOST_CONFLICT:`                | A different host runtime is already bound. The message names both `VERSION`s and the differing members (for example `pi.createAgentSession`). |

Where each one surfaces when nothing is bound:

- `createPiSessionFactory()` throws.
- `startAgent` rejects and `runAgent` returns `status: 'failed'` with the
  message in `error`. Both check first, so no transcript directory, timer or
  live-run entry is created.
- A structured `result` fails the same way, because the schema is compiled by
  the host's `typebox`.
- An injected `ChildSessionFactory` (your own, or a test fake) keeps working
  unbound for runs without a structured `result`.
- Pure helpers and `liveRuns()` need no host.

### Version policy

Tested hosts: Pi `1.1.0` and `1.5.0`.

| Host `VERSION`                       | Result                                                  |
| ------------------------------------ | ------------------------------------------------------- |
| Below `1.1.0`                        | `bindHostRuntime` throws                                |
| Missing or not a string              | throws (`pi.VERSION (string)` missing)                  |
| Not parseable as `major.minor.patch` | binds; warning; the capability checks still apply       |
| Parseable, not `1.1.0` or `1.5.0`    | binds; warning that it is not among the tested versions |
| `1.1.0` or `1.5.0`                   | binds without a warning                                 |

Capability checks run on every host regardless of version, so a host that
lacks an export fails at bind time rather than in the middle of a run.

### Rebinding, conflicts and reload

- The first valid binding installs the runtime. Binding the same references
  again is a no-op, also through a different wrapper object around the same
  module.
- References of the used functions, classes and `processCommand` are
  compared, not namespace objects and not `VERSION`. The same `VERSION` with
  different implementations is a `HOST_CONFLICT`. A conflict means a different
  runtime in a live process: restart Pi.
- There is no unbind. `session_shutdown` leaves the binding in place and
  `/reload` binds again with the same references, which is a no-op.
- The binding lives in one slot on `globalThis`
  (`Symbol.for('pi-agent-runner:host-runtime:v1')`), so several physical
  copies of the runner in one process (for example the ones bundled with
  Opium and Spiral) share it, along with the session-loading queue, the live
  registry and the other process-wide stores. Each copy must be 0.11 or newer
  and be bound; an older copy does not start using the host because another
  one was bound.
- Session creation is serialized across copies: concurrent children never
  interleave extension loading. The lock covers loading only, not the child's
  lifetime.

### Packages

`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui` and `typebox` are optional peer dependencies. The
runner does not import them for values, so installing them next to it is not
needed, and a stale copy that happens to be there is not used. They stay peers
so types resolve when you build against them. The runner's own development
baseline is Pi 1.5.

### Standalone SDK use

Outside a Pi extension (your own application or script using the SDK), bind in
your application's entry, before the first runner call, with the same imports:

```ts
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from 'pi-agent-runner';

bindHostRuntime({ pi, tui, typebox: { Unsafe, Compile } });
```

Here the "host" is whatever installation your application imports. The
process backend and the pane viewer find the CLI and the TUI module from that
installation (below); if `pi.getPackageDir()` does not point at a normal
package directory, give a `processCommand`.

### Process backend and the host

The process backend starts the CLI of the host installation, never `pi` from
`PATH`. Command precedence:

1. the `command` option of `createProcessSessionFactory`;
2. the bound `processCommand`;
3. `[process.execPath, <bin.pi>]`, derived from the bound
   `pi.getPackageDir()`. That directory's `package.json` must be named
   `@earendil-works/pi-coding-agent`, have exactly the bound `VERSION`, and
   its `bin.pi` must be a file inside the directory.

There is no fallback to `PATH`. If none of the three works (a compiled-binary
host, an unreadable or mismatching manifest), `runAgent` returns `failed` and
`startAgent` rejects with `cannot determine the host Pi CLI: <reason>; pass an
explicit command: ...`, before any directory, timer or live-run entry exists.

The child needs the binding too, and it runs in another process. In the run's
temporary directory (outside `node_modules`, so the child's loader treats them
as extension source) the runner generates small entry points, one each for the
guard, the MCP extension (only with `mcpServers`) and the tail hooks. Each one
imports the child host's SDK, TUI and typebox, throws if the child's Pi
`VERSION` differs from the parent's, calls `bindHostRuntime`, then hands over
to the compiled child extension. Load order is unchanged: guard, caller
extensions, installed extensions, MCP, tail. The parent checks the child's
marker commands (guard, tail, and MCP when used); if a wrapper failed, the
child is stopped before its first prompt with `the runner's child extension
did not load (<marker>)`.

Startup deadline: `startTimeoutMs` (default 30 s) is one deadline over the
whole handshake: the first state request, the marker check and the first
message list. A child that answers some requests and withholds the rest still
fails with `child process did not start in <n>ms`, and the child is stopped.

### Pane viewer

The viewer (`mountPanes`) is a separate `node` process that has no binding.
The runner resolves the host's pi-tui entry from the host installation (the
`node_modules` of the `getPackageDir()` directory and then of each ancestor,
using the package's `import`/`default` export) and passes it to the viewer as
a `file:` URL in the last argument; the viewer imports it for wrapping and
truncation. The `tuiModule` option overrides the URL.

If no filesystem entry can be found (or nothing is bound), panes are disabled
with one warning through `ctx.ui.notify`; the widget and `/agents` keep
working. The viewer never falls back to a pi-tui copy next to the runner, and
it exits with an error if it was not given a usable module.

## Codemode in child agents

Opt in per agent by listing `codemode` in `tools`. A child without it behaves
as before: pi's SDK sessions do not load codemode on their own, and the
process backend's `--no-extensions` also drops the CLI's built-in copy.

- In-process: the runner adds the host's `createCodemodeExtension()` (from
  the bound `pi`) to the child's inline extensions. `codemode` is active
  because it is in the child's `tools`.
- Process backend: the runner passes `-e builtin:codemode` next to
  `--tools ...,codemode`.
- Only the exact name `codemode` counts; a pattern such as `*` does not
  enable it.
- The guard applies to nested calls. Pi sends calls made by a script through
  argument validation and the `tool_call` handlers, so `tools`, `readRoots`
  and `gitGuard` refuse them like model-issued calls. A script also reaches
  only the child's active tools: a tool outside `tools` does not exist for it.
- The worker pool is process-wide, shared by every session in the Pi process:
  at most 2 workers by default (`PI_CODEMODE_MAX_WORKERS` raises it). A script
  waits up to 60 s for a free worker and then fails without running, so many
  parallel children using codemode queue behind each other.
- `codemode.mode` (`on` or `only`) comes from the user's Pi settings, not
  from the runner. With `only` the child's other tools are described inside
  the `codemode` tool instead of being declared.
- `createCodemodeExtension` is a required capability of the bound `pi`; it
  exists in the tested hosts (1.1.0 and 1.5.0).
- MCP stays as described above: servers are forced to `direct` exposure and
  do not depend on codemode.

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
allowlist (nested calls included; an entry with `*` is a pattern, so
`mcp__codegraph__*` admits every tool of that server), `gitGuard` (default on: blocks `git push`,
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

MCP servers: `mcpServers?: string[]` names servers of the user's built-in MCP
(Pi 1.1 `builtin:mcp`, added with `pi mcp add`, stored in
`~/.pi/agent/mcp.json`) that the child may use. `extensions: { packages:
['pi-mcp-adapter'] }` remains the way to hand a child an MCP adapter; do not
combine the two.

- What loads: Pi's MCP extension with a config of its own, so the child
  connects **only the named servers**, never every enabled one. The
  in-process backend adds it as an inline extension, replaceable like Pi's
  (`pi-agent-runner:mcp`); the process backend loads it with `-e`
  through a generated entry point (see Binding the host runtime). `-e builtin:mcp` is not used: it would connect every enabled server
  and cannot be restricted.
- What the child sees: each tool as a direct tool `mcp__<server>__<tool>`
  (every character other than a letter, digit or `_` becomes `_`, so
  `my-srv` gives `mcp__my_srv__*`). The runner forces `exposure: "direct"`
  for those servers, so neither `codemode` nor `tool_search` is needed or
  loaded. Tools or servers the user marked `hidden` stay hidden; `enabled:
false` servers are skipped. Resource tools (`list_mcp_resources`, ...) are
  not offered.
- Allowlist: with `tools` set, `mcp__<server>__*` is added for every server
  (to Pi and to the guard); without `tools` nothing is restricted.
- Cost: a server is connected per child. A stdio server is a new process per
  child (stopped with the session, in its own process group); an HTTP server
  is a new connection. The first prompt waits up to 10 s for the connections.
  There is no sharing with the parent: Pi keeps its MCP state per session.
- OAuth tokens are shared through `~/.pi/agent/mcp-auth.json`; a server that
  needs a sign-in is unavailable to the child (it cannot ask).
- The user may have turned the built-in off (`"extensions":
["-builtin:mcp"]`, usually because pi-mcp-adapter replaces it). Then
  `mcpServers` is ignored and the child gets no MCP tools. Check first with
  the exported helpers and pick the adapter instead:
  `builtinMcpDisabled(cwd?)` and `builtinMcpServers(cwd?)` (each returns
  `{ name, enabled }[]`). Both read `~/.pi/agent` (`PI_CODING_AGENT_DIR`);
  with `cwd` they also consider `<cwd>/.pi/mcp.json` and
  `<cwd>/.pi/settings.json`, but only when Pi's trust store trusts that
  project (the child itself applies the same rule).

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
  the child through the runner's own extensions (compiled
  `child-extension.js` and `child-extension-tail.js`, each loaded through a
  generated entry point that binds the host runtime); `submit_result` is validated in the
  parent. Nesting depth is passed down in `PI_AGENT_RUNNER_DEPTH`.

Permission asks: `permissionAsks: 'forward'` (default) registers the child
with pi-permission-system: an `ask` opens a dialog in the parent and the
timers pause meanwhile. `'deny'` leaves the child unregistered, so it has no
UI and an `ask` is refused at once; only explicit `allow` passes. Use it for
runs nobody is watching.

When `label.name` is set, the runner announces it to pi-permission-system as
the child's active agent (an `active_agent` entry in the child's session).
Forwarded prompts show it as the requester, and it selects the per-agent
`permission:` frontmatter from `~/.pi/agent/agents/<name>.md` or
`<cwd>/.pi/agents/<name>.md`, if present. The entry is also kept in the
transcript, so a `pi --fork` take-over inherits the name. Without a label
the requester stays `unknown`.

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
`ralph US-002`). A set `name` is also the child's agent name for
pi-permission-system (see Permission asks above).

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

## Live panes in herdr and tmux

```ts
import { mountPanes } from 'pi-agent-runner';

const panes = mountPanes(ctx, { max: 3, lingerMs: 5000 }); // ctx: extension context
// on session_shutdown:
panes.dispose();
```

`mountPanes(ctx, options?)` opens a read-only pane for each child that starts
running and closes it after the run ends. The pane shows a header (name,
context, model), then one line per event: tool calls with their command or
path, thinking lines, the child's text, tool errors and generation start and
end. A footer line keeps the state, turn, tool count, cost or tokens and the
clock. At the end it prints the final status (and the failure reason), waits
`lingerMs` and exits. The pane never reads the keyboard and never writes to
the session.

It does nothing unless `ctx.hasUI && ctx.mode === 'tui'` and a multiplexer is
found. It returns `{ dispose() }`; call `dispose` on `session_shutdown`.

Options:

- `multiplexer`: `'auto'` (default), `'herdr'` or `'tmux'`. `auto` picks herdr
  when `HERDR_ENV=1` and `herdr` is on the PATH, else tmux when `TMUX` is set
  and `tmux` is on the PATH. A named one needs its own environment.
- `max`: most panes at once, lingering ones included (default 3). A run that
  starts while all are taken gets no pane and is not queued; it stays in the
  widget and `/agents`.
- `lingerMs`: how long a finished pane stays open (default 5000). The runner
  closes a pane that has not exited a second after that.
- `filter(run)`: which runs get a pane (default: every run). It is asked once
  per run generation, when the run starts.
- Test seams: `registry`, `now`, `setTimer`, `clearTimer`, `exec`, `execSync`,
  `env`, `hasBinary`, `activity`, `feedDir`, `viewer`, `node`, `tuiModule`.
- The viewer is a separate process without the binding. It imports the
  host's own pi-tui module, named by a `file:` URL in its last argument
  (resolved from the host installation's package directory; `tuiModule`
  overrides it). If no filesystem entry is found, panes are disabled with a
  warning; a copy of pi-tui next to the runner is never used. Details:
  Binding the host runtime, Pane viewer.

Layout. The first pane splits the pane you are in to the right; later ones
split the newest viewer pane down, so the viewers stack in one column and your
pane does not get narrower each time. Focus stays on your pane, and the
working directory is `ctx.cwd` (`process.cwd()` without it). The commands:

- herdr: `herdr pane split --current|--pane <viewer> --direction right|down
--cwd <dir> --no-focus` (JSON `.result.pane.pane_id`), then `herdr pane run
<id> "exec node <dist>/pane-viewer.js <feed> <lingerMs> <tui url>"` (`exec`, so the
  pane closes with the viewer), and `herdr pane close <id>`.
- tmux: `tmux split-window -d -h|-v -P -F '#{pane_id}' -c <dir> -t <pane>
'<node> <dist>/pane-viewer.js <feed> <lingerMs> <tui url>'` (the pane closes when the
  command exits), and `tmux kill-pane -t <id>`.

The feed. The child runs inside your Pi process, so the pane cannot read its
memory. While a pane is attached the runner appends JSON lines (start, activity
entries, state, end) to `<tmpdir>/pi-agent-runner-<uid>/feeds/<id>-g<n>.jsonl`
(directory 0700, file 0600; a directory that is a link or someone else's is
refused). The file is deleted when the pane closes, when you call `dispose`
and at process exit. The viewer also leaves if the Pi process dies.

One owner per process, like `mountRunsView`: when Opium and Spiral both mount,
only the first opens panes; when it disposes, its panes close and the most
recent remaining mount takes over. If a multiplexer command fails, you get one
warning through `ctx.ui.notify` and no more panes open for that mount (open
panes close as usual). A `startAgent` handle that runs again gets a new pane
for the new generation.

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
