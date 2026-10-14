import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { liveRuns, startAgent } from '../src/index.ts';
import { runControl } from '../src/live.ts';
import type { StartAgentOptions } from '../src/index.ts';
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

const base = (extra: Partial<StartAgentOptions> = {}): StartAgentOptions => ({
  parent,
  cwd: '/tmp',
  systemPrompt: 'sys',
  ...extra,
});

const structuredBase = (extra: Partial<StartAgentOptions> = {}) =>
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

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-start-'));

const start = async (
  session: FakeSession,
  options: StartAgentOptions = base(),
) => {
  const factory = factoryOf(async () => session);
  const handle = await startAgent(options, { factory });
  return { handle, factory };
};

test('two generations: separate usage, turns, model and messages', async () => {
  const session = new FakeSession();
  session.script = async (s, n) => {
    s.emit({ type: 'turn_start' });
    s.emit({ type: 'tool_execution_start', toolName: 'read' });
    s.messages.push(assistant(`answer ${n}`));
    if (n === 2) s.modelId = 'fake/other';
  };
  const { handle, factory } = await start(session);
  assert.equal(factory.calls.length, 1);
  assert.equal(handle.state, 'idle');
  const first = await handle.run('one');
  assert.equal(handle.state, 'idle');
  const second = await handle.run('two');
  assert.equal(first.value, 'answer 1');
  assert.equal(second.value, 'answer 2');
  assert.equal(first.usage.input, 10);
  assert.equal(second.usage.input, 10);
  assert.equal(second.usage.turns, 1);
  assert.equal(second.usage.toolCalls, 1);
  assert.equal(first.model, 'fake/model');
  assert.equal(second.model, 'fake/other');
  assert.deepEqual(first.dropped, []);
  assert.deepEqual(session.prompts, ['one', 'two']);
  assert.equal(session.disposes, 0);
  await handle.dispose();
  assert.equal(session.disposes, 1);
});

test('later generations ignore earlier messages and aborts', async () => {
  const session = new FakeSession();
  session.script = async (s, n) => {
    if (n === 1) {
      s.messages.push(assistant('', { stopReason: 'aborted' }));
      await hangUntilAbort(s);
    } else {
      s.messages.push(assistant('fine'));
    }
  };
  const { handle } = await start(session);
  const pending = handle.run('one');
  await sleep(5);
  await handle.abort();
  // abort resolves once the generation has ended
  assert.equal(handle.state, 'idle');
  assert.equal((await pending).status, 'cancelled');
  const second = await handle.run('two');
  assert.equal(second.status, 'completed');
  assert.equal(second.value, 'fine');
  assert.equal(second.usage.input, 10);
  await handle.dispose();
});

test('run rejects when busy or disposed; idle abort is a no-op', async () => {
  const session = new FakeSession();
  session.script = hangUntilAbort;
  const { handle } = await start(session);
  await handle.abort();
  assert.equal(session.aborts, 0);
  const pending = handle.run('one');
  assert.equal(handle.state, 'running');
  await assert.rejects(handle.run('two'), /running/);
  await handle.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(handle.state, 'idle');
  await handle.dispose();
  assert.equal(handle.state, 'disposed');
  await assert.rejects(handle.run('three'), /disposed/);
  assert.equal(session.prompts.length, 1);
});

test('steer and followUp: queued, idle, disposed', async () => {
  const session = new FakeSession();
  const { handle } = await start(session);
  let during: unknown[] = [];
  session.script = async (s) => {
    during = [
      await handle.steer('s1'),
      await handle.followUp('f1'),
      session.deliverQueued(),
    ];
    s.messages.push(assistant('done'));
  };
  assert.equal(await handle.steer('x'), 'idle');
  assert.equal(await handle.followUp('x'), 'idle');
  assert.deepEqual(session.steering, []);
  const result = await handle.run('go');
  assert.deepEqual(during, ['queued', 'queued', ['s1', 'f1']]);
  assert.deepEqual(result.dropped, []);
  await handle.dispose();
  assert.equal(await handle.steer('x'), 'disposed');
  assert.equal(await handle.followUp('x'), 'disposed');
});

test('steer rejection from Pi is surfaced, not swallowed', async () => {
  const session = new FakeSession();
  const { handle } = await start(session);
  session.script = async (s) => {
    session.queueError = new Error('extension command');
    await assert.rejects(handle.steer('/cmd'), /extension command/);
    await assert.rejects(handle.followUp('/cmd'), /extension command/);
    s.messages.push(assistant('ok'));
  };
  assert.equal((await handle.run('go')).status, 'completed');
});

test('abort with queued messages: dropped, next starts clean', async () => {
  const session = new FakeSession();
  const { handle } = await start(session);
  const queues: string[][] = [];
  session.script = async (s, n) => {
    queues.push([...s.steering, ...s.followUps]);
    if (n === 1) {
      await handle.steer('s1');
      await handle.followUp('f1');
      await hangUntilAbort(s);
    } else {
      s.messages.push(assistant('second'));
    }
  };
  const pending = handle.run('one');
  await sleep(5);
  await handle.abort();
  const first = await pending;
  assert.equal(first.status, 'cancelled');
  assert.deepEqual(first.dropped, ['s1', 'f1']);
  const second = await handle.run('two');
  assert.deepEqual(queues, [[], []]);
  assert.equal(second.status, 'completed');
  assert.deepEqual(second.dropped, []);
});

test('submit_result between generations refused; fresh collector', async () => {
  const session = new FakeSession();
  const seen: unknown[] = [];
  session.script = async (s, n) => {
    if (n === 1) {
      seen.push(submit(s, { n: 1 }));
    } else if (n === 2) {
      seen.push(submit(s, { n: 2 }));
    } else {
      // Generation 2 gets one correction turn of its own.
      s.messages.push(assistant('prose'));
      if (n === 4) seen.push(submit(s, { n: 3 }));
    }
    s.messages.push(assistant('done'));
  };
  const { handle } = await start(session, structuredBase());
  assert.deepEqual(submit(session, { n: 0 }), {
    accepted: false,
    error: 'no run in progress',
  });
  const first = await handle.run('one');
  assert.deepEqual(first.value, { n: 1 });
  assert.equal(submit(session, { n: 9 }).accepted, false);
  const second = await handle.run('two');
  assert.deepEqual(second.value, { n: 2 });
  assert.deepEqual(seen, [{ accepted: true }, { accepted: true }]);
  const third = await handle.run('three');
  assert.deepEqual(third.value, { n: 3 });
  assert.equal(session.prompts.length, 4);
  assert.match(session.prompts[3], /not submitted a valid result/);
  const fourthSession = await handle.run('four');
  assert.equal(fourthSession.status, 'structured_output_failed');
  assert.equal(session.prompts.length, 6);
});

test('dispose mid-generation: cancelled, one dispose, silent', async () => {
  const session = new FakeSession();
  const updates: number[] = [];
  session.script = async (s) => {
    s.emit({ type: 'turn_start' });
    await hangUntilAbort(s);
  };
  const { handle } = await start(session);
  const pending = handle.run('go', { onUpdate: (u) => updates.push(u.turn) });
  await sleep(5);
  await handle.dispose();
  await handle.dispose();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(session.aborts, 1);
  assert.equal(session.disposes, 1);
  assert.equal(handle.state, 'disposed');
  const seen = updates.length;
  session.emit({ type: 'turn_start' });
  assert.equal(updates.length, seen);
});

test('resumeFrom: existing file continued, path reported', async () => {
  const cwd = tempDir();
  const file = path.join(cwd, 'old/child.jsonl');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{}\n');
  const session = new FakeSession();
  // History from the resumed file, ending in an aborted message.
  session.messages.push(
    assistant('old'),
    assistant('', { stopReason: 'aborted' }),
  );
  session.script = async (s) => {
    s.messages.push(assistant('resumed answer'));
  };
  const { handle, factory } = await start(
    session,
    base({ cwd, resumeFrom: 'old/child.jsonl' }),
  );
  assert.equal(factory.calls[0].sessionFile, file);
  assert.equal(handle.transcriptPath, file);
  const result = await handle.run('continue');
  assert.equal(result.value, 'resumed answer');
  assert.equal(result.usage.input, 10);
  assert.equal(result.transcriptPath, file);
});

test('resumeFrom: missing file and both options are refused', async () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'a.jsonl'), '{}\n');
  const factory = factoryOf(async () => new FakeSession());
  await assert.rejects(
    startAgent(base({ cwd, resumeFrom: 'missing.jsonl' }), { factory }),
    /resume file not found/,
  );
  await assert.rejects(
    startAgent(
      base({ cwd, resumeFrom: 'a.jsonl', transcriptPath: 'b.jsonl' }),
      { factory },
    ),
    /mutually exclusive/,
  );
  assert.equal(factory.calls.length, 0);
});

test('transcriptPath: reported once the file exists', async () => {
  const cwd = tempDir();
  const session = new FakeSession();
  session.script = async (s) => {
    fs.writeFileSync(s.spec?.sessionFile ?? '', '{}\n');
    s.messages.push(assistant('ok'));
  };
  const { handle } = await start(
    session,
    base({ cwd, transcriptPath: 'x/t.jsonl' }),
  );
  assert.equal(handle.transcriptPath, undefined);
  await handle.run('go');
  assert.equal(handle.transcriptPath, path.join(cwd, 'x/t.jsonl'));
});

test('startAgent rejects on creation failure, abort and depth', async () => {
  await assert.rejects(
    startAgent(base(), {
      factory: factoryOf(async () => {
        throw new Error('no model');
      }),
    }),
    /no model/,
  );
  const late = new FakeSession();
  const controller = new AbortController();
  await assert.rejects(
    startAgent(base({ signal: controller.signal }), {
      factory: factoryOf(async () => {
        controller.abort();
        await sleep(10);
        return late;
      }),
    }),
  );
  assert.equal(late.disposes, 1);
  await assert.rejects(
    startAgent(base({ maxDepth: 0 }), {
      factory: factoryOf(async () => new FakeSession()),
    }),
    /nesting limit reached: depth 0 >= maxDepth 0/,
  );
});

test('timers and human-wait pausing apply per generation', async () => {
  const p = fakeParent();
  const session = new FakeSession();
  session.script = async (s, n) => {
    if (n === 1) {
      s.messages.push(assistant('first'));
      return;
    }
    s.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'read',
    });
    p.events.emit(PERMISSION_PROMPT_CHANNEL, { requestId: 'r1' });
    await sleep(120);
    p.events.emit(PERMISSION_DECISION_CHANNEL, { requestId: 'r1' });
    s.onToolCall?.({ toolCallId: 't1', toolName: 'read' });
    s.emit({ type: 'tool_execution_end', toolCallId: 't1' });
    s.messages.push(assistant('second'));
  };
  const { handle } = await start(session, base({ parent: p }));
  await handle.run('one', { timeoutMs: 60, toolTimeoutMs: 60 });
  const second = await handle.run('two', { timeoutMs: 60, toolTimeoutMs: 60 });
  assert.equal(second.status, 'completed');
  assert.ok(second.usage.waitedMs >= 100, String(second.usage.waitedMs));
  assert.equal(session.aborts, 0);
});

test('per-generation timeout and signal; session stays usable', async () => {
  const session = new FakeSession();
  session.script = async (s, n) => {
    if (n <= 2) await hangUntilAbort(s);
    else s.messages.push(assistant('ok'));
  };
  const { handle } = await start(session);
  const timed = await handle.run('one', { timeoutMs: 20 });
  assert.equal(timed.status, 'timed_out');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const cancelled = await handle.run('two', { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
  const done = await handle.run('three', { signal: AbortSignal.abort() });
  assert.equal(done.status, 'cancelled');
  assert.equal(session.prompts.length, 2);
  assert.equal((await handle.run('four')).status, 'completed');
  assert.equal(session.disposes, 0);
});

test('the registry control aborts a generation, session kept', async () => {
  const session = new FakeSession();
  session.sessionId = 'ctl-1';
  session.script = (s, n) => {
    if (n === 1) return hangUntilAbort(s);
    s.messages.push(assistant('again'));
    return Promise.resolve();
  };
  const { handle } = await start(session);
  const control = runControl('ctl-1');
  assert.ok(control);
  const first = handle.run('one');
  await sleep(5);
  await control.cancel();
  assert.equal((await first).status, 'cancelled');
  assert.equal(handle.state, 'idle');
  assert.equal(session.disposes, 0);
  // nothing running: a late cancel is harmless
  await control.cancel();
  assert.equal((await handle.run('two')).status, 'completed');
  await handle.dispose();
  assert.equal(runControl('ctl-1'), undefined);
});

test('the registry records the transcript path of the handle', async () => {
  const dir = tempDir();
  const transcriptPath = path.join(dir, 'child.jsonl');
  const session = new FakeSession();
  session.sessionId = 'ctl-2';
  const { handle } = await start(session, base({ transcriptPath }));
  const run = liveRuns()
    .list()
    .find((r) => r.id === 'ctl-2');
  assert.equal(run?.transcriptPath, transcriptPath);
  await handle.dispose();
});
