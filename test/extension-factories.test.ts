import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { startAgent } from '../src/index.ts';
import { buildInlineFactories } from '../src/session.ts';
import type { ChildSpec } from '../src/index.ts';
import { FakeSession, factoryOf, parent } from './fake.ts';

type Handler = (event: unknown) => unknown;

// Runs the factories against a fake API; handlers are kept per event in
// factory order, the way Pi runs them (first block wins).
const load = (spec: ChildSpec) => {
  const handlers: Record<string, Handler[]> = {};
  const api = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    registerTool: () => undefined,
  };
  const inline = buildInlineFactories(spec);
  for (const { factory } of inline) factory(api as never);
  const toolCall = (event: unknown) => {
    let blocked: { block?: boolean; reason?: string } | undefined;
    for (const handler of handlers['tool_call'] ?? []) {
      const result = handler(event) as typeof blocked;
      if (result?.block) {
        blocked = result;
        break;
      }
    }
    return blocked;
  };
  return { inline, handlers, toolCall };
};

const spec = (extra: Partial<ChildSpec> = {}): ChildSpec => ({
  cwd: '/tmp',
  systemPrompt: 'sys',
  extensions: 'none',
  noContextFiles: true,
  noSkills: true,
  providerExtensions: {},
  policyExtensions: [],
  parent,
  guard: { allowedTools: ['read'], git: true, cwd: '/tmp' },
  forwardAsks: true,
  ...extra,
});

test('caller factories sit between the guard and freeze/tool-start', () => {
  const noop: ExtensionFactory = () => undefined;
  const { inline } = load(spec({ extensionFactories: [noop, noop] }));
  assert.deepEqual(
    inline.map((e) => e.name),
    [
      'pi-agent-runner:guard',
      'pi-agent-runner:active-agent',
      'caller-extension-0',
      'caller-extension-1',
      'pi-agent-runner:freeze-prompt',
      'pi-agent-runner:tool-start',
      'pi-agent-runner:activity',
    ],
  );
});

test('caller tool_call handler sees calls and can block one', () => {
  const seen: string[] = [];
  const loopGuard: ExtensionFactory = (api) => {
    api.on('tool_call', (event) => {
      seen.push(event.toolName);
      return event.toolName === 'read' &&
        (event.input as { path?: string }).path === 'x'
        ? { block: true, reason: 'loop detected' }
        : undefined;
    });
  };
  const { toolCall } = load(spec({ extensionFactories: [loopGuard] }));
  assert.equal(
    toolCall({ toolName: 'read', toolCallId: '1', input: { path: 'y' } }),
    undefined,
  );
  assert.deepEqual(
    toolCall({ toolName: 'read', toolCallId: '2', input: { path: 'x' } }),
    { block: true, reason: 'loop detected' },
  );
  assert.deepEqual(seen, ['read', 'read']);
});

test('caller tool_result handler can modify a result', () => {
  const redact: ExtensionFactory = (api) => {
    api.on('tool_result', () => ({
      content: [{ type: 'text' as const, text: 'redacted' }],
    }));
  };
  const { handlers } = load(spec({ extensionFactories: [redact] }));
  assert.deepEqual(handlers['tool_result']?.[0]?.({}), {
    content: [{ type: 'text', text: 'redacted' }],
  });
});

test('an allowlist-refused tool never reaches the caller handler', () => {
  const seen: string[] = [];
  const spy: ExtensionFactory = (api) => {
    api.on('tool_call', (event) => {
      seen.push(event.toolName);
      return undefined;
    });
  };
  const { toolCall } = load(spec({ extensionFactories: [spy] }));
  const refused = toolCall({ toolName: 'bash', toolCallId: '1', input: {} });
  assert.equal(refused?.block, true);
  assert.deepEqual(seen, []);
  assert.equal(
    toolCall({ toolName: 'read', toolCallId: '2', input: { path: 'a' } }),
    undefined,
  );
  assert.deepEqual(seen, ['read']);
});

test('startAgent loads factories once per session', async () => {
  const factoryFn: ExtensionFactory = () => undefined;
  const session = new FakeSession();
  const factory = factoryOf(async () => session);
  const handle = await startAgent(
    {
      parent,
      cwd: '/tmp',
      systemPrompt: 'sys',
      extensionFactories: [factoryFn],
    },
    { factory },
  );
  await handle.run('one');
  await handle.run('two');
  assert.equal(factory.calls.length, 1);
  assert.deepEqual(factory.calls[0]?.extensionFactories, [factoryFn]);
  await handle.dispose();
});
