import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
  isPossiblyStuck,
  liveRuns,
  runAgent,
  startAgent,
  STUCK_AFTER_MS,
} from '../src/index.ts';
import type { ChildEvent, LiveRun } from '../src/index.ts';
import { EVICT_AFTER_MS, MAX_LIVE_RUNS, trackRun } from '../src/live.ts';
import { applyRequestedModel } from '../src/session.ts';
import {
  FakeSession,
  assistant,
  factoryOf,
  fakeBus,
  fakeParent,
} from './fake.ts';

type LiveModule = typeof import('../src/live.ts');

let counter = 0;
const sessionId = () => `live-${++counter}`;

const find = (id: string) =>
  liveRuns()
    .list()
    .find((r) => r.id === id);

const sessionWith = (id: string, script?: FakeSession['script']) => {
  const session = new FakeSession();
  session.sessionId = id;
  if (script) session.script = script;
  return session;
};

const run = (id: string, over: Partial<LiveRun> = {}): LiveRun => ({
  id,
  name: 'agent',
  state: 'running',
  waitingForUser: false,
  turns: 0,
  toolCalls: 0,
  tokens: { input: 0, output: 0 },
  cost: 0,
  generation: 1,
  startedAt: 1000,
  lastActivityAt: 1000,
  ...over,
});

const emitActivity = (session: FakeSession, event: ChildEvent) =>
  session.spec?.onActivity?.(event);

test('two module instances share one registry', async () => {
  // A query string makes Node load a second instance of the module.
  const url = '../src/live.ts?copy=other';
  const copy = (await import(url)) as LiveModule;
  assert.notEqual(copy.trackRun, trackRun);
  const id = sessionId();
  const seen: number[] = [];
  const unsubscribe = copy.liveRuns().subscribe(() => seen.push(1));
  const tracked = trackRun({ id, events: fakeBus() });
  assert.equal(
    copy
      .liveRuns()
      .list()
      .some((r) => r.id === id),
    true,
  );
  assert.ok(seen.length > 0);
  unsubscribe();
  tracked.dispose();
});

test('runAgent: starting, running, terminal status, label', async () => {
  const id = sessionId();
  const states: Array<string | undefined> = [];
  const factory = factoryOf(async () =>
    sessionWith(id, async (session) => {
      states.push(find(id)?.state);
      session.messages.push(assistant('done'));
    }),
  );
  const result = await runAgent(
    {
      parent: fakeParent(),
      cwd: '/tmp',
      systemPrompt: 's',
      task: 't',
      label: { name: 'fixer', context: 'ralph US-002' },
    },
    { factory },
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(states, ['running']);
  const entry = find(id);
  assert.equal(entry?.name, 'fixer');
  assert.equal(entry?.context, 'ralph US-002');
  assert.equal(entry?.state, 'completed');
  assert.equal(entry?.model, 'fake/model');
  assert.equal(entry?.generation, 1);
  assert.deepEqual(entry?.tokens, { input: 10, output: 5 });
  assert.equal(entry?.cost, 0.5);
  assert.ok(entry?.endedAt);
});

test('default label name is agent', async () => {
  const id = sessionId();
  const factory = factoryOf(async () =>
    sessionWith(id, async (s) => {
      s.messages.push(assistant('x'));
    }),
  );
  await runAgent(
    { parent: fakeParent(), cwd: '/tmp', systemPrompt: 's', task: 't' },
    { factory },
  );
  assert.equal(find(id)?.name, 'agent');
  assert.equal(find(id)?.context, undefined);
});

test('startAgent: idle, status kept, next generation resets', async () => {
  const id = sessionId();
  const session = sessionWith(id, async (s, n) => {
    emitActivity(s, { type: 'turn_start' });
    s.messages.push(assistant(`r${n}`));
  });
  const handle = await startAgent(
    {
      parent: fakeParent(),
      cwd: '/tmp',
      systemPrompt: 's',
      label: { name: 'chat' },
    },
    { factory: factoryOf(async () => session) },
  );
  assert.equal(find(id)?.state, 'idle');
  await handle.run('one');
  assert.equal(find(id)?.state, 'completed');
  assert.equal(find(id)?.generation, 1);
  assert.equal(find(id)?.turns, 1);
  emitActivity(session, { type: 'turn_start' });
  assert.equal(find(id)?.turns, 1, 'events between generations are ignored');
  const during: Array<LiveRun | undefined> = [];
  session.script = async (s) => {
    emitActivity(s, { type: 'turn_start' });
    during.push(find(id));
    s.messages.push(assistant('two'));
  };
  await handle.run('two');
  assert.equal(during[0]?.state, 'running');
  assert.equal(during[0]?.generation, 2);
  assert.equal(during[0]?.turns, 1);
  assert.equal(during[0]?.endedAt, undefined);
  assert.equal(find(id)?.state, 'completed');
  await handle.dispose();
});

test('failed generation records the error', async () => {
  const id = sessionId();
  const session = sessionWith(id);
  session.promptError = new Error('boom');
  const result = await runAgent(
    { parent: fakeParent(), cwd: '/tmp', systemPrompt: 's', task: 't' },
    { factory: factoryOf(async () => session) },
  );
  assert.equal(result.status, 'failed');
  assert.equal(find(id)?.state, 'failed');
  assert.equal(find(id)?.error, 'boom');
});

test('activity: tools, turns, steps, usage', async () => {
  const id = sessionId();
  const snaps: Array<LiveRun | undefined> = [];
  const factory = factoryOf(async () =>
    sessionWith(id, async (s) => {
      const snap = () => snaps.push(find(id));
      emitActivity(s, { type: 'turn_start' });
      emitActivity(s, {
        type: 'tool_execution_start',
        toolCallId: 'a',
        toolName: 'bash',
      });
      snap();
      emitActivity(s, {
        type: 'tool_execution_start',
        toolCallId: 'a/1',
        toolName: 'nested',
        parentToolCallId: 'a',
      });
      snap();
      emitActivity(s, { type: 'tool_execution_end', toolCallId: 'a/1' });
      emitActivity(s, { type: 'tool_execution_end', toolCallId: 'a' });
      snap();
      emitActivity(s, {
        type: 'message_update',
        message: { role: 'assistant', usage: { input: 7, output: 2 } },
      });
      snap();
      emitActivity(s, {
        type: 'message_end',
        message: assistant('hi'),
      });
      snap();
      emitActivity(s, { type: 'turn_end' });
      snap();
      s.messages.push(assistant('hi'));
    }),
  );
  await runAgent(
    { parent: fakeParent(), cwd: '/tmp', systemPrompt: 's', task: 't' },
    { factory },
  );
  const [start, nested, ended, streaming, settled, turnEnd] = snaps;
  assert.equal(start?.currentTool, 'bash');
  assert.equal(start?.toolCalls, 1);
  assert.equal(nested?.toolCalls, 1, 'nested calls are not counted');
  assert.equal(nested?.currentTool, 'bash');
  assert.equal(ended?.currentTool, undefined);
  assert.ok(ended?.lastStepAt);
  assert.deepEqual(streaming?.tokens, { input: 7, output: 2 });
  assert.equal(streaming?.lastStepAt, ended?.lastStepAt);
  assert.deepEqual(settled?.tokens, { input: 10, output: 5 });
  assert.equal(settled?.cost, 0.5);
  assert.equal(turnEnd?.turns, 1);
  assert.ok((turnEnd?.lastStepAt ?? 0) >= (ended?.lastStepAt ?? 0));
});

test('streaming alone is activity but not a step', async () => {
  const id = sessionId();
  const snaps: LiveRun[] = [];
  mock.timers.enable({ apis: ['Date'], now: 5000 });
  try {
    const factory = factoryOf(async () =>
      sessionWith(id, async (s) => {
        mock.timers.setTime(9000);
        emitActivity(s, { type: 'provider_stream_event' });
        snaps.push(find(id) as LiveRun);
        s.messages.push(assistant('x'));
      }),
    );
    await runAgent(
      { parent: fakeParent(), cwd: '/tmp', systemPrompt: 's', task: 't' },
      { factory },
    );
  } finally {
    mock.timers.reset();
  }
  assert.equal(snaps[0]?.lastActivityAt, 9000);
  assert.equal(snaps[0]?.lastStepAt, undefined);
});

test('waitingForUser per requester, cleared by decision', async () => {
  const bus = fakeBus();
  const [a, b] = [sessionId(), sessionId()];
  const ta = trackRun({ id: a, events: bus });
  const tb = trackRun({ id: b, events: bus });
  const prompt = (requestId: string, requesterSessionId: string | null) =>
    bus.emit('permissions:ui_prompt', {
      requestId,
      forwarding: { requesterSessionId, requesterAgentName: 'x' },
    });
  prompt('r1', a);
  assert.equal(find(a)?.waitingForUser, true);
  assert.equal(find(b)?.waitingForUser, false);
  bus.emit('permissions:ui_prompt', { requestId: 'r2', forwarding: null });
  prompt('r3', null);
  assert.equal(find(b)?.waitingForUser, false);
  prompt('r4', a);
  bus.emit('permissions:decision', { requestId: 'r1' });
  assert.equal(find(a)?.waitingForUser, true, 'another prompt is still open');
  bus.emit('permissions:decision', { requestId: 'r4' });
  assert.equal(find(a)?.waitingForUser, false);
  ta.dispose();
  tb.dispose();
});

test('waitingForUser clears on the 30 minute cap', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const bus = fakeBus();
    const id = sessionId();
    const tracked = trackRun({ id, events: bus });
    bus.emit('permissions:ui_prompt', {
      requestId: 'cap',
      forwarding: { requesterSessionId: id, requesterAgentName: 'x' },
    });
    assert.equal(find(id)?.waitingForUser, true);
    mock.timers.tick(30 * 60_000);
    assert.equal(find(id)?.waitingForUser, false);
    tracked.dispose();
  } finally {
    mock.timers.reset();
  }
});

test('isPossiblyStuck boundaries', () => {
  const base = run('s', { startedAt: 1000 });
  assert.equal(isPossiblyStuck(base, 1000 + STUCK_AFTER_MS - 1), false);
  assert.equal(isPossiblyStuck(base, 1000 + STUCK_AFTER_MS), true);
  const stepped = run('s', { startedAt: 1000, lastStepAt: 50_000 });
  assert.equal(isPossiblyStuck(stepped, 50_000 + STUCK_AFTER_MS - 1), false);
  assert.equal(isPossiblyStuck(stepped, 50_000 + STUCK_AFTER_MS), true);
  const waiting = run('s', { waitingForUser: true });
  assert.equal(isPossiblyStuck(waiting, 1000 + 10 * STUCK_AFTER_MS), false);
  const done = run('s', { state: 'completed' });
  assert.equal(isPossiblyStuck(done, 1000 + 10 * STUCK_AFTER_MS), false);
});

test('a disposed run is evicted after ten minutes', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const id = sessionId();
    const tracked = trackRun({ id, events: fakeBus() });
    tracked.dispose();
    mock.timers.tick(EVICT_AFTER_MS - 1);
    assert.ok(find(id));
    mock.timers.tick(1);
    assert.equal(find(id), undefined);
  } finally {
    mock.timers.reset();
  }
});

test('the registry is bounded, disposed runs go first', () => {
  const bus = fakeBus();
  const first = sessionId();
  const keep = trackRun({ id: first, events: bus });
  const gone = sessionId();
  const disposed = trackRun({ id: gone, events: bus });
  disposed.dispose();
  const extra: string[] = [];
  for (let i = 0; i < MAX_LIVE_RUNS + 5; i++) {
    const id = sessionId();
    extra.push(id);
    trackRun({ id, events: bus });
  }
  const list = liveRuns().list();
  assert.ok(list.length <= MAX_LIVE_RUNS);
  assert.equal(find(gone), undefined);
  assert.equal(find(extra.at(-1) as string)?.state, 'starting');
  keep.dispose();
});

test('list returns copies', () => {
  const id = sessionId();
  const tracked = trackRun({ id, events: fakeBus() });
  const entry = find(id) as LiveRun;
  entry.name = 'mutated';
  entry.tokens.input = 99;
  assert.equal(find(id)?.name, 'agent');
  assert.equal(find(id)?.tokens.input, 0);
  tracked.dispose();
});

test('revive applies the requested model and thinking level', async () => {
  const calls: unknown[] = [];
  const session = {
    model: { provider: 'old', id: 'm' },
    setModel: async (model: unknown) => {
      calls.push(['model', model]);
    },
    setThinkingLevel: (level: unknown) => {
      calls.push(['thinking', level]);
    },
  };
  const wanted = { provider: 'new', id: 'n' };
  await applyRequestedModel(session as never, wanted as never, 'high');
  assert.deepEqual(calls, [
    ['model', wanted],
    ['thinking', 'high'],
  ]);
});

test('revive leaves a matching model alone', async () => {
  const calls: unknown[] = [];
  const session = {
    model: { provider: 'p', id: 'm' },
    setModel: async () => {
      calls.push('model');
    },
    setThinkingLevel: () => {
      calls.push('thinking');
    },
  };
  await applyRequestedModel(
    session as never,
    { provider: 'p', id: 'm' } as never,
    undefined,
  );
  assert.deepEqual(calls, []);
});
