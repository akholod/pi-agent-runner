import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/index.ts';
import type { RunAgentOptions, RunUpdate } from '../src/index.ts';
import {
  PERMISSION_DECISION_CHANNEL,
  PERMISSION_PROMPT_CHANNEL,
} from '../src/human-wait.ts';
import {
  FakeSession,
  assistant,
  factoryOf,
  fakeParent,
  hangUntilAbort,
  parent,
  sleep,
  submit,
} from './fake.ts';

const base = (extra: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  parent,
  cwd: '/tmp',
  systemPrompt: 'sys',
  task: 'do it',
  ...extra,
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

const startTool = (s: FakeSession, id = 't1', name = 'read') => {
  s.emit({ type: 'tool_execution_start', toolCallId: id, toolName: name });
  return () => s.onToolCall?.({ toolCallId: id, toolName: name });
};
const endTool = (s: FakeSession, id = 't1') =>
  s.emit({ type: 'tool_execution_end', toolCallId: id });

test('permission wait does not count against run or tool timers', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s) => {
    const begin = startTool(s);
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'r1' });
    await sleep(120);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'r1' });
    begin();
    endTool(s);
    s.messages.push(assistant('done'));
  };
  const result = await runAgent(
    base({ parent: p, timeoutMs: 60, toolTimeoutMs: 60 }),
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'completed');
  assert.ok(result.usage.waitedMs >= 100, String(result.usage.waitedMs));
  assert.equal(session.aborts, 0);
});

test('tool timeout: a hung tool times out and names the tool', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    startTool(s, 't1', 'bash')();
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ toolTimeoutMs: 20 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.match(result.error ?? '', /tool 'bash' exceeded its timeout of 20ms/);
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
});

test('tool timer is cleared by tool_execution_end', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    startTool(s)();
    endTool(s);
    await sleep(80);
    s.messages.push(assistant('ok'));
  };
  const result = await runAgent(base({ toolTimeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
});

test('run timer resumes after the decision and still fires', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s) => {
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'r1' });
    await sleep(80);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'r1' });
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ parent: p, timeoutMs: 40 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'timed out after 40ms');
  assert.ok(result.usage.waitedMs >= 60);
});

test('a prompt open before the run starts keeps the run paused', async () => {
  const p = fakeParent();
  // The tracker is created by an earlier run on this bus.
  const first = new FakeSession();
  first.messages.push(assistant('x'));
  await runAgent(base({ parent: p }), {
    factory: factoryOf(async () => first),
  });
  p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'early' });
  const session = new FakeSession();
  session.script = async (s) => {
    await sleep(100);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'early' });
    s.messages.push(assistant('late'));
  };
  const result = await runAgent(base({ parent: p, timeoutMs: 40 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.usage.waitedMs >= 80);
});

test('cancelled during startup, tool, and final answer', async () => {
  const cases: Array<(s: FakeSession, c: AbortController) => void> = [
    () => {},
    (s) => startTool(s)(),
    (s) => {
      startTool(s)();
      endTool(s);
    },
  ];
  for (const [index, step] of cases.entries()) {
    const controller = new AbortController();
    const session = new FakeSession();
    const updates: RunUpdate[] = [];
    session.script = async (s) => {
      step(s, controller);
      setTimeout(() => controller.abort(), 10);
      await hangUntilAbort(s);
    };
    const factory = factoryOf(async () => {
      if (index === 0) {
        setTimeout(() => controller.abort(), 5);
        await sleep(20);
      }
      return session;
    });
    const result = await runAgent(
      base({
        signal: controller.signal,
        timeoutMs: 30_000,
        toolTimeoutMs: 30_000,
        onUpdate: (u) => updates.push(u),
      }),
      { factory },
    );
    assert.equal(result.status, 'cancelled', `case ${index}`);
    assert.equal(session.disposes, 1, `case ${index}`);
    const seen = updates.length;
    session.emit({ type: 'turn_start' });
    session.onToolCall?.({ toolCallId: 'late', toolName: 'read' });
    assert.equal(updates.length, seen);
  }
});

const structuredOpts = (extra: Partial<RunAgentOptions> = {}) =>
  base({
    result: {
      kind: 'structured',
      schema: {
        type: 'object',
        required: ['n'],
        properties: { n: { type: 'number' } },
      },
    },
    ...extra,
  });

test('structured: valid submit completes with the payload', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    assert.deepEqual(submit(s, { n: 1 }), { accepted: true });
    s.messages.push(assistant('prose, ignored'));
  };
  const factory = factoryOf(async () => session);
  const result = await runAgent(structuredOpts({ tools: ['read'] }), {
    factory,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, { n: 1 });
  assert.equal(session.prompts.length, 1);
  assert.match(
    session.prompts[0],
    /^do it\n\nWhen you are done, call the `submit_result` tool/,
  );
  assert.deepEqual(factory.calls[0].tools, ['read']);
  assert.equal(factory.calls[0].systemPrompt, 'sys');
  assert.equal(session.disposes, 1);
});

test('structured: invalid then fixed completes with 2nd value', async () => {
  const session = new FakeSession();
  let first: unknown;
  session.script = async (s) => {
    first = submit(s, { n: 'x' });
    submit(s, { n: 2 });
    s.messages.push(assistant('done'));
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, { n: 2 });
  const rejected = first as { accepted: false; error: string };
  assert.equal(rejected.accepted, false);
  assert.match(rejected.error, /\/n: /);
});

test('structured: two invalid submits fail and abort', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    submit(s, { n: 'x' });
    submit(s, { n: 'y' });
    s.messages.push(assistant('oops'));
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'structured_output_failed');
  assert.equal(result.value, undefined);
  assert.match(result.error ?? '', /^invalid result: \/n: /);
  assert.equal(session.aborts, 1);
  assert.equal(session.prompts.length, 1);
});

test('structured: no call, one correction, then valid', async () => {
  const session = new FakeSession();
  session.script = async (s, turn) => {
    s.messages.push(assistant('prose'));
    if (turn === 2) submit(s, { n: 3 });
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, { n: 3 });
  assert.equal(session.prompts.length, 2);
  assert.equal(
    session.prompts[1],
    'You have not submitted a valid result. Call `submit_result` now ' +
      'with `value` matching the schema.',
  );
});

test('structured: still nothing after the correction fails', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    s.messages.push(assistant('prose'));
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'structured_output_failed');
  assert.equal(result.error, 'no valid submit_result call');
  assert.equal(session.prompts.length, 2);
});

test('structured: one invalid, then nothing after correction', async () => {
  const session = new FakeSession();
  session.script = async (s, turn) => {
    if (turn === 1) submit(s, { n: 'x' });
    s.messages.push(assistant('prose'));
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'structured_output_failed');
  assert.match(result.error ?? '', /^no valid submit_result call: \/n: /);
  assert.equal(session.prompts.length, 2);
  assert.match(session.prompts[1], /\nLast error: \/n: /);
});

test('structured: second valid submit is rejected, first kept', async () => {
  const session = new FakeSession();
  let second: unknown;
  session.script = async (s) => {
    submit(s, { n: 1 });
    second = submit(s, { n: 2 });
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.deepEqual(result.value, { n: 1 });
  assert.deepEqual(second, {
    accepted: false,
    error: 'result already submitted; the first one is final',
  });
});

test('structured: error message after a valid submit is ignored', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    submit(s, { n: 1 });
    s.messages.push(assistant('', { stopReason: 'error', errorMessage: 'x' }));
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
});

test('structured: prompt error fails', async () => {
  const session = new FakeSession();
  session.promptError = new Error('boom');
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'boom');
  assert.equal(session.prompts.length, 1);
});

test('structured: invalid schema fails without a session', async () => {
  const factory = factoryOf(async () => new FakeSession());
  const result = await runAgent(
    base({
      result: {
        kind: 'structured',
        schema: { type: 'string', pattern: '(' },
      },
    }),
    { factory },
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /^invalid result schema: /);
  assert.equal(factory.calls.length, 0);
});

test('structured: timeout during the correction turn wins', async () => {
  const session = new FakeSession();
  session.script = (s, turn) => {
    s.messages.push(assistant('prose'));
    return turn === 2 ? hangUntilAbort(s) : Promise.resolve();
  };
  const result = await runAgent(structuredOpts({ timeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(session.prompts.length, 2);
});

test('structured: cancel during the correction turn wins', async () => {
  const session = new FakeSession();
  const controller = new AbortController();
  session.script = (s, turn) => {
    s.messages.push(assistant('prose'));
    if (turn !== 2) return Promise.resolve();
    setTimeout(() => controller.abort(), 10);
    return hangUntilAbort(s);
  };
  const result = await runAgent(structuredOpts({ signal: controller.signal }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'cancelled');
});

test('structured: submit after the run finished is rejected', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    submit(s, { n: 1 });
  };
  const result = await runAgent(structuredOpts(), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(submit(session, { n: 2 }), {
    accepted: false,
    error: 'the run has ended',
  });
  assert.deepEqual(result.value, { n: 1 });
});
