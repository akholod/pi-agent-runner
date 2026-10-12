import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent, startAgent } from '../src/index.ts';
import type { RunAgentOptions, StartAgentOptions } from '../src/index.ts';
import {
  PERMISSION_PROMPT_CHANNEL,
  humanWaitTracker,
} from '../src/human-wait.ts';
import type { Submission } from '../src/structured.ts';
import {
  FakeSession,
  assistant,
  factoryOf,
  fakeBus,
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

const structured = (extra: Partial<RunAgentOptions> = {}) =>
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

const startBase = (
  extra: Partial<StartAgentOptions> = {},
): StartAgentOptions => ({
  parent,
  cwd: '/tmp',
  systemPrompt: 'sys',
  ...extra,
});

test('structured: submit then abort is cancelled, disposed once', async () => {
  const session = new FakeSession();
  const controller = new AbortController();
  let submitted: Submission | undefined;
  session.script = async (s) => {
    submitted = submit(s, { n: 1 });
    // The abort lands before the prompt resolves.
    controller.abort();
    await sleep(5);
  };
  const factory = factoryOf(async () => session);
  const result = await runAgent(structured({ signal: controller.signal }), {
    factory,
  });
  assert.deepEqual(submitted, { accepted: true });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.value, undefined);
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
});

test('structured: abort then submit is refused as ended', async () => {
  const session = new FakeSession();
  const controller = new AbortController();
  let submitted: Submission | undefined;
  session.script = async (s) => {
    controller.abort();
    submitted = submit(s, { n: 1 });
    await sleep(5);
  };
  const factory = factoryOf(async () => session);
  const result = await runAgent(structured({ signal: controller.signal }), {
    factory,
  });
  assert.equal(submitted?.accepted, false);
  assert.match(
    submitted && !submitted.accepted ? submitted.error : '',
    /the run has ended/,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(session.disposes, 1);
});

for (const mode of ['error stop reason', 'prompt throws'] as const) {
  test(`startAgent: provider failure (${mode}), handle reusable`, async () => {
    const session = new FakeSession();
    session.script = async (s, n) => {
      if (n === 1) {
        s.emit({ type: 'turn_start' });
        s.emit({ type: 'tool_execution_start', toolName: 'read' });
        if (mode === 'error stop reason') {
          s.messages.push(
            assistant('', {
              stopReason: 'error',
              errorMessage: 'provider down',
            }),
          );
        } else {
          s.messages.push(assistant('partial'));
          throw new Error('provider down');
        }
      } else {
        s.emit({ type: 'turn_start' });
        s.messages.push(assistant('recovered'));
      }
    };
    const factory = factoryOf(async () => session);
    const handle = await startAgent(startBase(), { factory });
    const first = await handle.run('one');
    assert.equal(first.status, 'failed');
    assert.match(first.error ?? '', /provider down/);
    assert.equal(first.usage.toolCalls, 1);
    assert.equal(handle.state, 'idle');
    const second = await handle.run('two');
    assert.equal(second.status, 'completed');
    assert.equal(second.value, 'recovered');
    assert.equal(second.usage.input, 10);
    assert.equal(second.usage.output, 5);
    assert.equal(second.usage.turns, 1);
    assert.equal(second.usage.toolCalls, 0);
    await handle.dispose();
    assert.equal(session.disposes, 1);
  });
}

test('dispose during an open permission prompt: no late timers', async () => {
  const events = fakeBus();
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const factory = factoryOf(async () => session);
  const handle = await startAgent(startBase({ parent: fakeParent(events) }), {
    factory,
  });
  const pending = handle.run('go', { timeoutMs: 30, toolTimeoutMs: 30 });
  session.onToolCall?.({ toolCallId: 't1', toolName: 'bash' });
  events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'orphan-1' });
  await sleep(60);
  assert.equal(handle.state, 'running');
  await handle.dispose();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, 'aborted');
  // Neither timer may fire afterwards: no second abort, no second dispose.
  await sleep(80);
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
  await handle.dispose();
  assert.equal(session.disposes, 1);
});

test('orphaned permission prompt pauses timers until the cap', async () => {
  const events = fakeBus();
  // The tracker is created once per bus; this sets its cap for the test.
  humanWaitTracker(events, 150);
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const factory = factoryOf(async () => session);
  let settled = false;
  const pending = runAgent(
    base({ parent: fakeParent(events), timeoutMs: 40 }),
    { factory },
  ).then((result) => {
    settled = true;
    return result;
  });
  await sleep(5);
  events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'orphan-2' });
  // Well past timeoutMs, still inside the cap: nobody decided, still held.
  await sleep(100);
  assert.equal(settled, false);
  const result = await pending;
  assert.equal(result.status, 'timed_out');
  assert.ok(result.usage.waitedMs >= 120, `waitedMs ${result.usage.waitedMs}`);
  assert.ok(result.usage.durationMs >= 150);
  assert.equal(session.disposes, 1);
});

test('abort as session creation finishes: no prompt, one dispose', async () => {
  const controller = new AbortController();
  const session = new FakeSession();
  const factory = factoryOf(async () => {
    controller.abort();
    return session;
  });
  const result = await runAgent(base({ signal: controller.signal }), {
    factory,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(session.prompts.length, 0);
  assert.equal(session.disposes, 1);
});

test('abort in a microtask after creation: cancelled, no prompt', async () => {
  const controller = new AbortController();
  const session = new FakeSession();
  const factory = factoryOf(() => {
    queueMicrotask(() => controller.abort());
    return Promise.resolve(session);
  });
  const result = await runAgent(base({ signal: controller.signal }), {
    factory,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(session.prompts.length, 0);
  assert.equal(session.disposes, 1);
});
