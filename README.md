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
  signal,
  onUpdate: ({ turn, tool, tokens }) => {},
});
// result: { status, value, usage, model?, error? }
```

Statuses: `completed | failed | timed_out | cancelled |
structured_output_failed`. Implemented now: `completed`, `failed`,
`timed_out`, `cancelled`. Later: structured output (`result: { kind:
'structured' }`, T08), per-tool timeout and the permission-prompt pause of
the run timer (T07), `transcriptPath` (T10). Until then structured results
fail fast and `toolTimeoutMs` / `transcriptPath` are ignored.

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
