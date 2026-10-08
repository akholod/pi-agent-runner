import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/index.ts';
import type { RunAgentOptions, RunUpdate } from '../src/index.ts';
import { FakeSession, assistant, factoryOf, parent, sleep } from './fake.ts';

const base = (extra: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  parent,
  cwd: '/tmp',
  systemPrompt: 'sys',
  task: 'do it',
  ...extra,
});

// Prompt that hangs until the fake is aborted.
const hangUntilAbort = (session: FakeSession) =>
  new Promise<void>((resolve) => {
    session.onAbort = resolve;
  });

test('completed: text, usage, counters, model, one dispose', async () => {
  const session = new FakeSession();
  const updates: RunUpdate[] = [];
  session.script = async (s) => {
    s.emit({ type: 'turn_start' });
    s.emit({ type: 'tool_execution_start', toolName: 'read' });
    s.messages.push(assistant('thinking'));
    s.emit({ type: 'message_end', message: assistant('thinking') });
    s.emit({ type: 'turn_start' });
    s.messages.push(assistant('  final answer \n'));
    s.emit({ type: 'message_end', message: assistant('final') });
  };
  const factory = factoryOf(async () => session);
  const result = await runAgent(base({ onUpdate: (u) => updates.push(u) }), {
    factory,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'final answer');
  assert.equal(result.model, 'fake/model');
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.output, 10);
  assert.equal(result.usage.cacheRead, 4);
  assert.equal(result.usage.cacheWrite, 2);
  assert.equal(result.usage.cost, 1);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.toolCalls, 1);
  assert.equal(session.disposes, 1);
  assert.equal(updates.length, 5);
  assert.deepEqual(updates[1], { turn: 1, tool: 'read', tokens: 0 });
  assert.equal(updates.at(-1)?.tokens, 36);
  assert.equal(factory.calls[0].model, undefined);
  assert.equal(factory.calls[0].noSkills, true);
  assert.equal(factory.calls[0].noContextFiles, true);
});

test('model and thinking: inherit becomes undefined', async () => {
  const session = new FakeSession();
  session.messages.push(assistant('ok'));
  const factory = factoryOf(async () => session);
  await runAgent(base({ model: 'inherit', thinking: 'inherit' }), { factory });
  await runAgent(base({ model: 'a/b', thinking: 'high' }), { factory });
  assert.equal(factory.calls[0].model, undefined);
  assert.equal(factory.calls[0].thinking, undefined);
  assert.equal(factory.calls[1].model, 'a/b');
  assert.equal(factory.calls[1].thinking, 'high');
});

test('failed: last assistant message with error stopReason', async () => {
  const session = new FakeSession();
  session.messages.push(
    assistant('', { stopReason: 'error', errorMessage: 'boom' }),
  );
  const factory = factoryOf(async () => session);
  const result = await runAgent(base(), { factory });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'boom');
  assert.equal(session.disposes, 1);
});

test('failed: no assistant message', async () => {
  const session = new FakeSession();
  const factory = factoryOf(async () => session);
  const result = await runAgent(base(), { factory });
  assert.equal(result.status, 'failed');
  assert.ok(result.error);
});

test('failed: prompt throws', async () => {
  const session = new FakeSession();
  session.promptError = new Error('prompt broke');
  const factory = factoryOf(async () => session);
  const result = await runAgent(base(), { factory });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'prompt broke');
  assert.equal(session.disposes, 1);
});

test('failed: create rejects, nothing to dispose', async () => {
  const factory = factoryOf(async () => {
    throw new Error('no model');
  });
  const result = await runAgent(base(), { factory });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'no model');
});

test('failed: structured result is rejected without a session', async () => {
  const factory = factoryOf(async () => new FakeSession());
  const result = await runAgent(
    base({ result: { kind: 'structured', schema: {} } }),
    { factory },
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /T08/);
  assert.equal(factory.calls.length, 0);
});

test('timed_out: prompt hangs until abort', async () => {
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const result = await runAgent(base({ timeoutMs: 20 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
});

test('timed_out during creation disposes the late session', async () => {
  const session = new FakeSession();
  const factory = factoryOf(async () => {
    await sleep(60);
    return session;
  });
  const result = await runAgent(base({ timeoutMs: 10 }), { factory });
  assert.equal(result.status, 'timed_out');
  assert.equal(session.disposes, 1);
});

test('cancelled: signal aborted before start', async () => {
  const factory = factoryOf(async () => new FakeSession());
  const result = await runAgent(base({ signal: AbortSignal.abort() }), {
    factory,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, 'aborted before start');
  assert.equal(factory.calls.length, 0);
});

test('cancelled: abort during prompt', async () => {
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const result = await runAgent(base({ signal: controller.signal }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
});

test('cancelled: abort during creation', async () => {
  const session = new FakeSession();
  const controller = new AbortController();
  const factory = factoryOf(async () => {
    controller.abort();
    await sleep(10);
    return session;
  });
  const result = await runAgent(base({ signal: controller.signal }), {
    factory,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(session.disposes, 1);
});

test('first terminal reason wins', async () => {
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  const result = await runAgent(
    base({ signal: controller.signal, timeoutMs: 30 }),
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'cancelled');
});

test('no onUpdate after settle; throwing onUpdate is harmless', async () => {
  const session = new FakeSession();
  session.messages.push(assistant('done'));
  let calls = 0;
  session.script = async (s) => {
    s.emit({ type: 'turn_start' });
  };
  const result = await runAgent(
    base({
      onUpdate: () => {
        calls++;
        throw new Error('listener bug');
      },
    }),
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  session.emit({ type: 'turn_start' });
  assert.equal(calls, 1);
});

test('dispose rejecting does not change a completed result', async () => {
  const session = new FakeSession();
  session.messages.push(assistant('fine'));
  session.disposeError = new Error('dispose failed');
  const factory = factoryOf(async () => session);
  const result = await runAgent(base(), { factory });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'fine');
});
