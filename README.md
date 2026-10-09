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
  onUpdate: ({ turn, tool, tokens }) => {},
});
// result: { status, value, usage, model?, error? }
// usage: { input, output, cacheRead, cacheWrite, cost, turns, toolCalls,
//          durationMs, waitedMs }
```

Statuses: `completed | failed | timed_out | cancelled |
structured_output_failed`. `transcriptPath` (T10) is not implemented yet and
is ignored.

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

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
```

`spikes/` holds the throwaway phase 0 spikes; it is excluded from lint and
typecheck. Load one into Pi with `pi -e spikes/child.ts`.
