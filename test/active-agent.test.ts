import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { runAgent, startAgent } from '../src/index.ts';
import { CONFIG_ENV } from '../src/child-config.ts';
import childExtension from '../src/child-extension.ts';
import { activeAgentHook } from '../src/session.ts';
import { FakeSession, assistant, factoryOf, parent } from './fake.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

// Pi's session manager behind a fake extension API: appendEntry writes a
// real custom entry, and session_start handlers run like Pi runs them.
const host = (sm = SessionManager.inMemory('/tmp')) => {
  const handlers: Record<string, Handler[]> = {};
  const api = {
    on: (event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
    },
    appendEntry: (customType: string, data?: unknown) => {
      sm.appendCustomEntry(customType, data);
    },
    registerCommand: () => undefined,
  };
  const start = () => {
    for (const handler of handlers['session_start'] ?? []) {
      handler(
        { type: 'session_start', reason: 'startup' },
        { sessionManager: sm },
      );
    }
  };
  return { api, handlers, start, sm };
};

// getActiveAgentName from @gotgenes/pi-permission-system
// (session/active-agent.ts), which resolves a child's name from its session.
const permissionSystemName = (sm: SessionManager) => {
  const entries = sm.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== 'active_agent') {
      continue;
    }
    const name = (entry.data as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
};

const activeAgentEntries = (sm: SessionManager) =>
  sm.getEntries().filter((e) => e.type === 'custom');

test('active agent: label is written where permission-system reads it', () => {
  const { api, start, sm } = host();
  activeAgentHook({ label: 'fixer' }).factory(api as never);
  assert.equal(permissionSystemName(sm), null);
  start();
  assert.equal(permissionSystemName(sm), 'fixer');
  assert.deepEqual(
    activeAgentEntries(sm).map((e) => ({
      customType: 'customType' in e ? e.customType : undefined,
      data: 'data' in e ? e.data : undefined,
    })),
    [{ customType: 'active_agent', data: { name: 'fixer' } }],
  );
});

test('active agent: the entry stays out of the model context', () => {
  const { api, start, sm } = host();
  activeAgentHook({ label: 'fixer' }).factory(api as never);
  start();
  assert.equal(activeAgentEntries(sm).length, 1);
  assert.deepEqual(sm.buildSessionContext().messages, []);
});

test('active agent: no label, or a blank one, registers nothing', () => {
  for (const label of [undefined, '', '   ']) {
    const { api, handlers, start, sm } = host();
    activeAgentHook({ label }).factory(api as never);
    start();
    assert.deepEqual(handlers, {});
    assert.equal(activeAgentEntries(sm).length, 0);
  }
});

test('active agent: resume with the same name adds no duplicate', () => {
  const first = host();
  activeAgentHook({ label: 'fixer' }).factory(first.api as never);
  first.start();
  const again = host(first.sm);
  activeAgentHook({ label: 'fixer' }).factory(again.api as never);
  again.start();
  assert.equal(activeAgentEntries(first.sm).length, 1);
});

test('active agent: resume with another name adds an entry', () => {
  const first = host();
  activeAgentHook({ label: 'fixer' }).factory(first.api as never);
  first.start();
  const again = host(first.sm);
  activeAgentHook({ label: 'reviewer' }).factory(again.api as never);
  again.start();
  assert.equal(activeAgentEntries(first.sm).length, 2);
  assert.equal(permissionSystemName(first.sm), 'reviewer');
  // Back to the first name: the latest entry differs, so it is written again.
  const third = host(first.sm);
  activeAgentHook({ label: 'fixer' }).factory(third.api as never);
  third.start();
  assert.equal(permissionSystemName(first.sm), 'fixer');
});

test('in-process: the factory gets label.name, else none', async () => {
  const factory = factoryOf(async () => {
    const session = new FakeSession();
    session.script = async (s) => {
      s.messages.push(assistant('ok'));
    };
    return session;
  });
  const options = { parent, cwd: '/tmp', systemPrompt: 'sys', task: 'go' };
  await runAgent({ ...options, label: { name: 'fixer' } }, { factory });
  await runAgent(options, { factory });
  assert.equal(factory.calls[0]?.label, 'fixer');
  assert.equal(factory.calls[1]?.label, undefined);
});

test('in-process: startAgent passes the label to the factory', async () => {
  const factory = factoryOf(async () => new FakeSession());
  const handle = await startAgent(
    { parent, cwd: '/tmp', systemPrompt: 'sys', label: { name: 'chat' } },
    { factory },
  );
  assert.equal(factory.calls[0]?.label, 'chat');
  await handle.dispose();
});

test('process: child extension names the child from config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-agent-'));
  const file = path.join(dir, 'config.json');
  const withConfig = (config: object) => {
    fs.writeFileSync(file, JSON.stringify(config));
    process.env[CONFIG_ENV] = file;
    const h = host();
    childExtension(h.api as never);
    h.start();
    return h.sm;
  };
  const guard = { allowedTools: ['read'], git: true, cwd: '/tmp' };
  try {
    assert.equal(
      permissionSystemName(withConfig({ guard, label: 'proc' })),
      'proc',
    );
    assert.equal(permissionSystemName(withConfig({ guard })), null);
  } finally {
    delete process.env[CONFIG_ENV];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
