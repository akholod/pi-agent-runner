// Codemode in child agents, on the real local SDK (bound by bind-host) and a
// faux model, so nothing touches the network. The point: scripts run by the
// `codemode` tool call other tools through Pi's nested-call path, and the
// runner's guard must refuse those calls like any model-issued one.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import * as pi from '@earendil-works/pi-coding-agent';
import { runAgent } from '../src/index.ts';
import type { ParentContext, RunAgentOptions } from '../src/index.ts';
import './bind-host.ts';

const scratch = (prefix: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// An empty agent dir: no user settings, no installed policy extensions.
process.env.PI_CODING_AGENT_DIR = scratch('codemode-agent-');

const faux = fauxProvider();

// A parent that only offers the faux provider (inherited by the child).
const parentContext = (cwd: string): ParentContext => ({
  events: pi.createEventBus(),
  ctx: {
    cwd,
    model: undefined,
    thinkingLevel: undefined,
    modelRegistry: {
      getRegisteredProviderIds: () => ['faux'],
      getRegisteredNativeProvider: () => faux.provider,
      getRegisteredProviderConfig: () => undefined,
    },
    sessionManager: pi.SessionManager.inMemory(cwd),
  } as unknown as ParentContext['ctx'],
});

// The text of the newest tool result in the transcript.
const lastToolResult = (context: {
  messages: { role: string; content: unknown }[];
}) => {
  const result = [...context.messages]
    .reverse()
    .find((m) => m.role === 'toolResult');
  const blocks = (result?.content ?? []) as { type: string; text?: string }[];
  return blocks.map((b) => b.text ?? '').join('\n');
};

const run = (cwd: string, extra: Partial<RunAgentOptions>) =>
  runAgent({
    parent: parentContext(cwd),
    cwd,
    model: 'faux/faux-1',
    systemPrompt: 'You are a test agent.',
    task: 'go',
    extensions: 'none',
    timeoutMs: 60_000,
    ...extra,
  });

test('codemode: the guard refuses nested calls of a script', async () => {
  const cwd = scratch('codemode-cwd-');
  const outside = scratch('codemode-outside-');
  fs.writeFileSync(path.join(cwd, 'ok.txt'), 'allowed-content');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'forbidden-content');
  const sentinel = path.join(cwd, 'bash-ran');
  const script = `
const paths = ${JSON.stringify({
    ok: path.join(cwd, 'ok.txt'),
    secret: path.join(outside, 'secret.txt'),
    command: `touch ${sentinel}`,
  })};
const attempt = async (label, call) => {
  try {
    const value = await call();
    text(label + ' OK ' + JSON.stringify(value));
  } catch (error) {
    text(label + ' ERROR ' + (error && error.message));
  }
};
await attempt('allowed', () => tools.read({ path: paths.ok }));
await attempt('forbidden', () => tools.read({ path: paths.secret }));
await attempt('bash', () => tools.bash({ command: paths.command }));
`;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: script }), {
      stopReason: 'toolUse',
    }),
    (context) => fauxAssistantMessage(fauxText(lastToolResult(context))),
  ]);

  const result = await run(cwd, {
    tools: ['read', 'codemode'],
    readRoots: [],
    gitGuard: false,
  });
  assert.equal(result.status, 'completed', result.error);
  const report = String(result.value);
  assert.match(report, /allowed OK .*allowed-content/s);
  assert.match(report, /forbidden ERROR .*outside this agent's read roots/);
  assert.doesNotMatch(report, /forbidden-content/);
  // Not even reachable: scripts only see the child's active tools.
  assert.match(report, /bash ERROR tools\.bash does not exist/);
  assert.equal(fs.existsSync(sentinel), false, 'bash must not have run');
});

test('codemode: not listed in the tools, it is not available', async () => {
  const cwd = scratch('codemode-off-');
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: 'text("hi")' }), {
      stopReason: 'toolUse',
    }),
    (context) => fauxAssistantMessage(fauxText(lastToolResult(context))),
  ]);
  const result = await run(cwd, { tools: ['read'], gitGuard: false });
  assert.equal(result.status, 'completed', result.error);
  assert.doesNotMatch(String(result.value), /Script completed/);
  assert.match(String(result.value), /Tool codemode not found/);
});
