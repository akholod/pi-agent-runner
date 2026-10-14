import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WRAP_UP_MESSAGE,
  liveRuns,
  runAgent,
  startAgent,
  wrapUpMessage,
} from '../src/index.ts';
import type { RunAgentOptions, StartAgentOptions } from '../src/index.ts';
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

const structured = {
  kind: 'structured' as const,
  schema: {
    type: 'object',
    required: ['n'],
    properties: { n: { type: 'number' } },
  },
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 1000 && !check(); i++) await sleep(2);
};

// Records every steer text; the fake still queues it as usual.
const recordSteers = (session: FakeSession) => {
  const sent: string[] = [];
  const steer = session.steer.bind(session);
  session.steer = (text) => {
    sent.push(text);
    return steer(text);
  };
  return sent;
};

// The child ends once the wrap-up message reaches it.
const answerOnSteer = (text: string) => async (s: FakeSession) => {
  await until(() => s.steering.length > 0);
  s.messages.push(assistant(text));
};

test('wrap-up: steers once, the answer within the grace stands', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = answerOnSteer('wrapped');
  const result = await runAgent(base({ timeoutMs: 20, wrapUpMs: 2000 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'wrapped');
  assert.equal(result.wrappedUp, true);
  assert.deepEqual(sent, [WRAP_UP_MESSAGE]);
  assert.equal(
    WRAP_UP_MESSAGE,
    'Time limit reached. Do not start new work. Finish or stop the current ' +
      'step, then reply now with your final answer: what you did, what is ' +
      'left, and anything the caller must know.',
  );
  assert.equal(session.aborts, 0);
});

test('wrap-up: the structured variant asks for submit_result', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = async (s) => {
    await until(() => s.steering.length > 0);
    submit(s, { n: 4 });
  };
  const result = await runAgent(
    base({ timeoutMs: 20, wrapUpMs: 2000, result: structured }),
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, { n: 4 });
  assert.equal(result.wrappedUp, true);
  assert.deepEqual(sent, [wrapUpMessage(true)]);
  assert.equal(
    sent[0],
    'Time limit reached. Do not start new work. Finish or stop the current ' +
      'step, then call submit_result now with what you have.',
  );
});

test('wrap-up: no answer within the grace is timed_out', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = hangUntilAbort;
  const result = await runAgent(base({ timeoutMs: 20, wrapUpMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(
    result.error,
    'timed out after 20ms; no final answer within the 30ms wrap-up',
  );
  assert.equal(result.wrappedUp, true);
  assert.equal(sent.length, 1);
  assert.equal(session.aborts, 1);
  assert.ok(result.usage.durationMs >= 45, String(result.usage.durationMs));
});

test('wrap-up: a refused steer stops at once, as before', async () => {
  const session = new FakeSession();
  session.queueError = new Error('refused');
  session.script = hangUntilAbort;
  const result = await runAgent(base({ timeoutMs: 20, wrapUpMs: 5000 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'timed out after 20ms');
  assert.equal(result.wrappedUp, undefined);
  assert.equal(session.aborts, 1);
  assert.ok(result.usage.durationMs < 1000);
});

test('wrap-up: without wrapUpMs nothing is steered', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = hangUntilAbort;
  const result = await runAgent(base({ timeoutMs: 20 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'timed out after 20ms');
  assert.equal('wrappedUp' in result, false);
  assert.deepEqual(sent, []);
});

test('wrap-up: a run ending before the limit is not wrapped up', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = async (s) => {
    s.messages.push(assistant('quick'));
  };
  const result = await runAgent(base({ timeoutMs: 500, wrapUpMs: 500 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.equal('wrappedUp' in result, false);
  assert.deepEqual(sent, []);
});

test('wrap-up: the grace is paused while a person is asked', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s) => {
    await until(() => s.steering.length > 0);
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'w1' });
    await sleep(120);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'w1' });
    s.messages.push(assistant('late but in time'));
  };
  const result = await runAgent(
    base({ parent: p, timeoutMs: 20, wrapUpMs: 40 }),
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.wrappedUp, true);
  assert.ok(result.usage.waitedMs >= 100, String(result.usage.waitedMs));
});

test('wrap-up: per generation; the wrap-up text is not "dropped"', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = async (s, n) => {
    if (n === 1) {
      await until(() => s.steering.length > 0);
      s.messages.push(assistant('one'));
    } else {
      await hangUntilAbort(s);
    }
  };
  const factory = factoryOf(async () => session);
  const handle = await startAgent(base() as StartAgentOptions, { factory });
  const first = await handle.run('a', { timeoutMs: 20, wrapUpMs: 2000 });
  assert.equal(first.status, 'completed');
  assert.equal(first.wrappedUp, true);
  assert.deepEqual(first.dropped, []);
  const second = await handle.run('b', { timeoutMs: 20 });
  assert.equal(second.status, 'timed_out');
  assert.equal(second.error, 'timed out after 20ms');
  assert.equal('wrappedUp' in second, false);
  assert.equal(sent.length, 1);
  await handle.dispose();
});

test('wrap-up: the live run shows wrappingUp until the end', async () => {
  const session = new FakeSession();
  session.sessionId = 'limits-live-1';
  const seen: Array<boolean | undefined> = [];
  const find = () =>
    liveRuns()
      .list()
      .find((r) => r.id === 'limits-live-1');
  session.script = async (s) => {
    seen.push(find()?.wrappingUp);
    await until(() => s.steering.length > 0);
    seen.push(find()?.wrappingUp);
    s.messages.push(assistant('done'));
  };
  const result = await runAgent(base({ timeoutMs: 30, wrapUpMs: 2000 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(seen, [undefined, true]);
  assert.equal(find()?.wrappingUp, undefined);
});

test('idle: a streaming child stays alive past the limit', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    for (let i = 0; i < 12; i++) {
      s.emit({ type: 'message_update' });
      await sleep(15);
    }
    s.messages.push(assistant('streamed'));
  };
  const result = await runAgent(base({ idleTimeoutMs: 60 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'streamed');
  assert.ok(result.usage.durationMs >= 150, String(result.usage.durationMs));
});

test('idle: silence stops the run at once with the idle error', async () => {
  const session = new FakeSession();
  const sent = recordSteers(session);
  session.script = hangUntilAbort;
  const result = await runAgent(base({ idleTimeoutMs: 30, wrapUpMs: 5000 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 30ms');
  assert.equal(session.aborts, 1);
  assert.deepEqual(sent, []);
  assert.equal('wrappedUp' in result, false);
});

test('idle: counts from the last event, not from the start', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    await sleep(25);
    s.emit({ type: 'turn_start' });
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ idleTimeoutMs: 40 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 40ms');
  assert.ok(result.usage.durationMs >= 60, String(result.usage.durationMs));
});

test('idle: a long top-level tool does not trip it', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    s.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
    });
    await sleep(150);
    s.emit({ type: 'tool_execution_end', toolCallId: 't1' });
    s.messages.push(assistant('after the tool'));
  };
  const result = await runAgent(base({ idleTimeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'after the tool');
});

test('idle: counts again once the tool ended', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    s.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
    });
    await sleep(80);
    s.emit({ type: 'tool_execution_end', toolCallId: 't1' });
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ idleTimeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 30ms');
  assert.ok(result.usage.durationMs >= 105, String(result.usage.durationMs));
});

test('idle: a nested tool does not pause it', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    s.emit({
      type: 'tool_execution_start',
      toolCallId: 'inner',
      parentToolCallId: 'outer',
      toolName: 'read',
    });
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ idleTimeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 30ms');
});

test('idle: a hung tool is still governed by toolTimeoutMs', async () => {
  const session = new FakeSession();
  session.script = async (s) => {
    s.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
    });
    s.onToolCall?.({ toolCallId: 't1', toolName: 'bash' });
    await hangUntilAbort(s);
  };
  const result = await runAgent(
    base({ idleTimeoutMs: 20, toolTimeoutMs: 60 }),
    {
      factory: factoryOf(async () => session),
    },
  );
  assert.equal(result.status, 'timed_out');
  assert.match(result.error ?? '', /tool 'bash' exceeded its timeout of 60ms/);
});

test('idle: waiting for a person pauses it', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s) => {
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'i1' });
    await sleep(120);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'i1' });
    s.messages.push(assistant('answered'));
  };
  const result = await runAgent(base({ parent: p, idleTimeoutMs: 40 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.usage.waitedMs >= 100, String(result.usage.waitedMs));
});

test('idle: the silence after the wait still counts', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s) => {
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'i2' });
    await sleep(60);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'i2' });
    await hangUntilAbort(s);
  };
  const result = await runAgent(base({ parent: p, idleTimeoutMs: 30 }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 30ms');
});

test('idle: startAgent takes it per generation', async () => {
  const session = new FakeSession();
  session.script = async (s, n) => {
    if (n === 1) {
      await hangUntilAbort(s);
    } else {
      await sleep(80);
      s.messages.push(assistant('slow but fine'));
    }
  };
  const factory = factoryOf(async () => session);
  const handle = await startAgent(base() as StartAgentOptions, { factory });
  const first = await handle.run('a', { idleTimeoutMs: 20 });
  assert.equal(first.status, 'timed_out');
  assert.equal(first.error, 'no activity for 20ms');
  const second = await handle.run('b');
  assert.equal(second.status, 'completed');
  assert.equal(session.disposes, 0);
  await handle.dispose();
});

test('idle: an earlier generation does not leak into the next', async () => {
  const session = new FakeSession();
  session.script = async (s, n) => {
    if (n === 1) {
      s.emit({ type: 'turn_start' });
      s.messages.push(assistant('one'));
    } else {
      await hangUntilAbort(s);
    }
  };
  const factory = factoryOf(async () => session);
  const handle = await startAgent(base() as StartAgentOptions, { factory });
  assert.equal(
    (await handle.run('a', { idleTimeoutMs: 40 })).status,
    'completed',
  );
  const second = await handle.run('b', { idleTimeoutMs: 40 });
  assert.equal(second.status, 'timed_out');
  assert.equal(second.error, 'no activity for 40ms');
  await handle.dispose();
});
