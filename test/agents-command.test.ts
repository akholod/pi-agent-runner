import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { liveRuns, runAgent, startAgent } from '../src/index.ts';
import type { ActivityEntry, LiveRun, RunAgentOptions } from '../src/index.ts';
import {
  COMMAND_NAME,
  REFRESH_MS,
  describeRun,
  orderRuns,
  pickAgent,
  registerAgentsCommand,
  renderActivity,
  takeoverOf,
} from '../src/agents-command.ts';
import { liveStore, runActivity, runControl } from '../src/live.ts';
import {
  FakeSession,
  factoryOf,
  hangUntilAbort,
  parent,
  sleep,
} from './fake.ts';

type CommandModule = typeof import('../src/agents-command.ts');
type Pi = Parameters<typeof registerAgentsCommand>[0];
type Ctx = Parameters<typeof pickAgent>[0];
type Panel = {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
};
type PanelFactory = (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
  done: () => void,
) => Panel | Promise<Panel>;

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const reset = () => {
  const store = liveStore();
  store.runs.clear();
  store.disposed.clear();
  store.activity.clear();
  store.controls.clear();
};

const until = async (check: () => unknown) => {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5);
  assert.ok(check(), 'condition not reached in time');
};

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-agents-'));

interface FakePi {
  pi: Pi;
  commands: Map<string, Parameters<Pi['registerCommand']>[1]>;
  shortcuts: Map<string, unknown>;
  shutdown(): void;
}

const fakePi = (): FakePi => {
  const commands: FakePi['commands'] = new Map();
  const shortcuts = new Map<string, unknown>();
  const onShutdown: (() => void)[] = [];
  const pi = {
    registerCommand: (name: string, options: never) => {
      commands.set(name, options);
    },
    registerShortcut: (key: string, options: unknown) => {
      shortcuts.set(key, options);
    },
    on: (event: string, handler: () => void) => {
      if (event === 'session_shutdown') onShutdown.push(handler);
    },
  } as unknown as Pi;
  return {
    pi,
    commands,
    shortcuts,
    shutdown: () => onShutdown.forEach((h) => h()),
  };
};

interface Dialogs {
  selects: { title: string; options: string[] }[];
  notes: { message: string; type?: string }[];
  confirms: string[];
  customs: number;
}

// `choose` answers every select; it sees the options, so a test picks by text
const fakeCtx = (
  choose: (title: string, options: string[]) => string | undefined,
  extra: { mode?: string; hasUI?: boolean; confirm?: boolean } = {},
) => {
  const dialogs: Dialogs = { selects: [], notes: [], confirms: [], customs: 0 };
  const ctx = {
    mode: extra.mode ?? 'tui',
    hasUI: extra.hasUI ?? true,
    ui: {
      select: async (title: string, options: string[]) => {
        dialogs.selects.push({ title, options });
        return choose(title, options);
      },
      confirm: async (title: string) => {
        dialogs.confirms.push(title);
        return extra.confirm ?? true;
      },
      notify: (message: string, type?: string) => {
        dialogs.notes.push({ message, type });
      },
      custom: async () => {
        dialogs.customs++;
      },
    },
  } as unknown as Ctx;
  return { ctx, dialogs };
};

const picking = (name: string, action?: string) => {
  let step = 0;
  return (_title: string, options: string[]) => {
    step++;
    if (step === 1) return options.find((o) => o.includes(name));
    return action ? options.find((o) => o.startsWith(action)) : undefined;
  };
};

const runOptions = (over: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  parent,
  cwd: '/tmp',
  systemPrompt: 'sys',
  task: 'work',
  ...over,
});

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

test('two copies register one /agents, also after reload', async () => {
  const url = '../src/agents-command.ts?copy=';
  const a = (await import(`${url}a`)) as CommandModule;
  const b = (await import(`${url}b`)) as CommandModule;
  assert.notEqual(a.registerAgentsCommand, b.registerAgentsCommand);

  // first load: Opium's copy gets there first
  const first = [fakePi(), fakePi()];
  a.registerAgentsCommand(first[0].pi);
  b.registerAgentsCommand(first[1].pi);
  assert.ok(first[0].commands.has(COMMAND_NAME));
  assert.equal(first[1].commands.size, 0);

  // reload: Pi shuts the old extensions down, then loads them anew, now in
  // the other order
  for (const old of first) old.shutdown();
  const second = [fakePi(), fakePi()];
  b.registerAgentsCommand(second[1].pi);
  a.registerAgentsCommand(second[0].pi);
  assert.equal(second[0].commands.size, 0);
  assert.ok(second[1].commands.has(COMMAND_NAME));

  // the owner's extension is gone for good: the other copy takes over
  second[1].shutdown();
  const third = fakePi();
  a.registerAgentsCommand(third.pi);
  assert.ok(third.commands.has(COMMAND_NAME));
  third.shutdown();
});

test('shortcut is claimed once, independently of the command', () => {
  const one = fakePi();
  const two = fakePi();
  registerAgentsCommand(one.pi);
  registerAgentsCommand(two.pi, { shortcut: 'ctrl+shift+a' });
  assert.equal(one.shortcuts.size, 0);
  assert.equal(two.commands.size, 0);
  assert.ok(two.shortcuts.has('ctrl+shift+a'));
  const three = fakePi();
  registerAgentsCommand(three.pi, { shortcut: 'ctrl+shift+a' });
  assert.equal(three.shortcuts.size, 0);
  for (const pi of [one, two, three]) pi.shutdown();
});

test('a failed registration does not keep the claim', () => {
  const broken = fakePi();
  broken.pi.registerCommand = () => {
    throw new Error('stale');
  };
  assert.throws(() => registerAgentsCommand(broken.pi), /stale/);
  const next = fakePi();
  registerAgentsCommand(next.pi);
  assert.ok(next.commands.has(COMMAND_NAME));
  next.shutdown();
});

test('the registered handler opens the picker', async () => {
  reset();
  const host = fakePi();
  registerAgentsCommand(host.pi);
  const { ctx, dialogs } = fakeCtx(() => undefined);
  await host.commands.get(COMMAND_NAME)?.handler('', ctx as never);
  assert.deepEqual(dialogs.notes, [
    { message: 'No child agents', type: 'info' },
  ]);
  host.shutdown();
});

test('empty registry says so', async () => {
  reset();
  const { ctx, dialogs } = fakeCtx(() => undefined);
  await pickAgent(ctx);
  assert.deepEqual(dialogs.notes, [
    { message: 'No child agents', type: 'info' },
  ]);
  assert.equal(dialogs.selects.length, 0);
});

test('outside the TUI the summary is plain text', async () => {
  reset();
  const store = liveStore();
  store.runs.set('p1', run('p1', { name: 'worker', context: 'ralph US-1' }));
  for (const extra of [{ mode: 'print' }, { hasUI: false }]) {
    const { ctx, dialogs } = fakeCtx(() => undefined, extra);
    await pickAgent(ctx);
    assert.equal(dialogs.selects.length, 0);
    assert.equal(dialogs.notes.length, 1);
    assert.match(dialogs.notes[0].message, /^1 child agent:\n/);
    assert.match(dialogs.notes[0].message, /worker · ralph US-1 · running/);
  }
});

test('runs are listed active first, newest first', () => {
  const runs = [
    run('old-done', { state: 'completed', endedAt: 5000 }),
    run('new-done', { state: 'failed', endedAt: 9000 }),
    run('old-live', { startedAt: 2000 }),
    run('new-live', { startedAt: 8000 }),
  ];
  assert.deepEqual(
    orderRuns(runs).map((r) => r.id),
    ['new-live', 'old-live', 'new-done', 'old-done'],
  );
});

test('picker lines: name, context, state, elapsed', () => {
  const now = 100_000;
  const line = (over: Partial<LiveRun>) => describeRun(run('x', over), now);
  assert.equal(
    line({
      name: 'worker',
      context: 'ralph US-002',
      currentTool: 'bash',
      lastActivityAt: now,
    }),
    '⠋ worker · ralph US-002 · running: bash · 1:39',
  );
  assert.equal(
    line({ currentTool: 'read', lastActivityAt: now - 45_000, generation: 2 }),
    '⠋ agent g2 · running: read · quiet 0:45 · 1:39',
  );
  assert.equal(
    line({ lastActivityAt: now }),
    '⠋ agent · running: thinking · 1:39',
  );
  assert.equal(
    line({ waitingForUser: true, lastActivityAt: now }),
    '⏸ agent · waiting for you · 1:39',
  );
  assert.equal(
    line({ state: 'completed', endedAt: 31_000 }),
    '✓ agent · done · 0:30',
  );
  assert.match(
    line({ state: 'failed', endedAt: 31_000, error: 'boom' }),
    /^✗ agent · failed: boom · 0:30$/,
  );
});

test('activity buffer: content, formats and the cap', async () => {
  reset();
  const session = sessionWith('buf-1', async (s) => {
    s.spec?.onActivity?.({
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'bash',
      args: { command: 'npm   test\n--  --grep x' },
    });
    s.spec?.onActivity?.({
      type: 'tool_execution_end',
      toolCallId: 'a',
      isError: false,
    });
    s.spec?.onActivity?.({
      type: 'tool_execution_start',
      toolCallId: 'b',
      toolName: 'read',
      args: { path: 'src/a.ts' },
    });
    s.spec?.onActivity?.({
      type: 'tool_execution_start',
      toolCallId: 'c',
      toolName: 'grep',
      args: { pattern: 'x'.repeat(200) },
    });
    s.spec?.onActivity?.({
      type: 'tool_execution_end',
      toolCallId: 'c',
      isError: true,
      result: { content: [{ type: 'text', text: 'no such\ndirectory' }] },
    });
    // nested calls of a sub-tool are not the child's own
    s.spec?.onActivity?.({
      type: 'tool_execution_start',
      toolCallId: 'n',
      parentToolCallId: 'c',
      toolName: 'inner',
    });
    s.spec?.onActivity?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${'y'.repeat(300)}\nthe end` }],
      },
    });
    s.spec?.onActivity?.({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    });
    s.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    });
  });
  await runAgent(runOptions(), { factory: factoryOf(async () => session) });
  const entries = runActivity('buf-1') ?? [];
  const texts = entries.map((e) => `${e.kind}|${e.text}`);
  assert.equal(texts[0], 'generation|generation 1 started');
  assert.equal(texts[1], 'tool|bash npm test -- --grep x');
  assert.equal(texts[2], 'tool|read src/a.ts');
  assert.match(texts[3], /^tool\|grep \{"pattern":"x{60,}…$/);
  assert.ok(texts[3].length <= 'tool|grep '.length + 80);
  assert.equal(texts[4], 'error|grep: no such directory');
  assert.match(texts[5], /^text\|…y+ the end$/);
  assert.ok(texts[5].length <= 'text|'.length + 201);
  assert.equal(texts[6], 'generation|generation 1 completed');
  assert.equal(texts.length, 7);
  assert.ok(entries.every((e, i) => i === 0 || e.at >= entries[i - 1].at));
});

test('activity buffer keeps the newest 50 entries', async () => {
  reset();
  const session = sessionWith('buf-2', async (s) => {
    for (let i = 0; i < 60; i++) {
      s.spec?.onActivity?.({
        type: 'tool_execution_start',
        toolCallId: `t${i}`,
        toolName: 'bash',
        args: { command: `step ${i}` },
      });
    }
    s.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    });
  });
  const handle = await startAgent(runOptions(), {
    factory: factoryOf(async () => session),
  });
  await handle.run('go');
  const entries = runActivity('buf-2') ?? [];
  assert.equal(entries.length, 50);
  assert.equal(entries.at(-1)?.text, 'generation 1 completed');
  assert.equal(entries.at(-2)?.text, 'bash step 59');
  assert.equal(entries[0].text, 'bash step 11');
  // a copy is returned
  entries.pop();
  assert.equal(runActivity('buf-2')?.length, 50);
  await handle.dispose();
});

test('buffer and control leave with the run', () => {
  reset();
  const store = liveStore();
  store.runs.set('gone', run('gone'));
  store.activity.set('gone', []);
  store.controls.set('gone', { cancel: async () => {} });
  assert.ok(runActivity('gone'));
  assert.ok(runControl('gone'));
  store.runs.delete('gone');
  assert.equal(runActivity('gone'), undefined);
  assert.equal(runControl('gone'), undefined);
});

test('a run from an older copy shows its actions as unavailable', async () => {
  reset();
  // an older copy writes the run and nothing else
  liveStore().runs.set('old-1', run('old-1', { name: 'legacy' }));
  const { ctx, dialogs } = fakeCtx(picking('legacy', 'Cancel run'));
  await pickAgent(ctx);
  assert.deepEqual(
    dialogs.selects[1].options.map((o) => o.split(' (')[0]),
    ['Recent activity', 'Cancel run'],
  );
  assert.ok(dialogs.selects[1].options.every((o) => o.includes('unavailable')));
  assert.equal(dialogs.confirms.length, 0);
  assert.equal(dialogs.customs, 0);
  assert.equal(dialogs.notes.length, 1);
  assert.equal(dialogs.notes[0].type, 'warning');
  assert.match(dialogs.notes[0].message, /older pi-agent-runner/);

  const activity = fakeCtx(picking('legacy', 'Recent activity'));
  await pickAgent(activity.ctx);
  assert.equal(activity.dialogs.customs, 0);
  assert.match(activity.dialogs.notes[0].message, /older pi-agent-runner/);
});

test('cancel ends a runAgent run as cancelled', async () => {
  reset();
  const session = sessionWith('cancel-1', hangUntilAbort);
  const result = runAgent(
    runOptions({ label: { name: 'canceller', context: 'ctx 1' } }),
    { factory: factoryOf(async () => session) },
  );
  await until(() => liveRuns().list()[0]?.state === 'running');

  // declined: nothing happens
  const declined = fakeCtx(picking('canceller', 'Cancel run'), {
    confirm: false,
  });
  await pickAgent(declined.ctx);
  assert.equal(declined.dialogs.confirms.length, 1);
  assert.equal(session.aborts, 0);
  assert.deepEqual(declined.dialogs.selects[1].options, [
    'Recent activity',
    'Cancel run',
  ]);

  const { ctx, dialogs } = fakeCtx(picking('canceller', 'Cancel run'));
  await pickAgent(ctx);
  assert.deepEqual(dialogs.notes, [
    { message: 'Cancelled canceller · ctx 1', type: 'info' },
  ]);
  const outcome = await result;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.error, 'aborted');
  assert.equal(session.aborts, 1);
  assert.equal(liveRuns().list()[0].state, 'cancelled');
  // the control is dropped with the session
  assert.equal(runControl('cancel-1'), undefined);
});

test('cancel aborts a startAgent generation, the session stays', async () => {
  reset();
  const session = sessionWith('cancel-2', (s, n) => {
    if (n === 1) return hangUntilAbort(s);
    s.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'again' }],
    });
    return Promise.resolve();
  });
  const handle = await startAgent(runOptions({ label: { name: 'keeper' } }), {
    factory: factoryOf(async () => session),
  });
  assert.ok(runControl('cancel-2'));
  // idle: nothing to cancel, nothing offered
  const idle = fakeCtx(picking('keeper'));
  await pickAgent(idle.ctx);
  assert.deepEqual(idle.dialogs.selects[1].options, ['Recent activity']);

  const first = handle.run('one');
  await until(() => handle.state === 'running');
  const { ctx, dialogs } = fakeCtx(picking('keeper', 'Cancel run'));
  await pickAgent(ctx);
  assert.equal(dialogs.confirms.length, 1);
  const outcome = await first;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(handle.state, 'idle');
  assert.equal(session.disposes, 0);
  const second = await handle.run('two');
  assert.equal(second.status, 'completed');
  await handle.dispose();
  assert.equal(runControl('cancel-2'), undefined);
});

test('cancel notes a run that finished while the dialog was open', async () => {
  reset();
  const session = sessionWith('cancel-3', hangUntilAbort);
  const result = runAgent(runOptions({ label: { name: 'racer' } }), {
    factory: factoryOf(async () => session),
  });
  await until(() => liveRuns().list()[0]?.state === 'running');
  const { ctx, dialogs } = fakeCtx(picking('racer', 'Cancel run'));
  ctx.ui.confirm = async () => {
    session.onAbort?.();
    await result;
    return true;
  };
  await pickAgent(ctx);
  assert.deepEqual(dialogs.notes, [
    { message: 'racer has already finished', type: 'info' },
  ]);
});

test('take over: fork command for a finished run, file untouched', async () => {
  reset();
  const dir = tempDir();
  const transcript = path.join(dir, 'child.jsonl');
  const session = sessionWith('take-1', async (s) => {
    fs.writeFileSync(transcript, '{"type":"session"}\n');
    s.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    });
  });
  const handle = await startAgent(
    runOptions({ transcriptPath: transcript, label: { name: 'taker' } }),
    { factory: factoryOf(async () => session) },
  );
  const [live] = liveRuns().list();
  assert.equal(live.transcriptPath, transcript);
  // idle without a file: nothing to take over
  assert.deepEqual(takeoverOf(live), {
    ok: false,
    reason: 'the agent has no transcript file yet',
  });

  const pending = handle.run('go');
  await until(() => liveRuns().list()[0]?.state !== 'idle');
  await pending;
  const { ctx, dialogs } = fakeCtx(picking('taker', 'Take over'));
  await pickAgent(ctx);
  assert.deepEqual(dialogs.selects[1].options, [
    'Recent activity',
    'Take over in a new Pi session',
  ]);
  assert.equal(dialogs.notes.length, 1);
  const lines = dialogs.notes[0].message.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], `  pi --fork ${transcript}`);
  assert.match(
    lines[2],
    /^Not restored: .*extensions, tools and frozen system prompt\.$/,
  );
  assert.deepEqual(fs.readdirSync(dir), ['child.jsonl']);
  assert.equal(fs.readFileSync(transcript, 'utf8'), '{"type":"session"}\n');
  await handle.dispose();
});

test('take over is refused while running or without a transcript', async () => {
  reset();
  const dir = tempDir();
  const file = path.join(dir, 'my transcript.jsonl');
  fs.writeFileSync(file, '{}\n');
  const finished = run('t-done', { state: 'completed', transcriptPath: file });
  assert.deepEqual(takeoverOf(finished), {
    ok: true,
    command: `pi --fork '${file}'`,
  });
  for (const state of ['starting', 'running'] as const) {
    const live = run('t-live', { state, transcriptPath: file });
    assert.deepEqual(takeoverOf(live), {
      ok: false,
      reason: 'the agent is still running',
    });
  }
  const missing = run('t-miss', {
    state: 'failed',
    transcriptPath: path.join(dir, 'no.jsonl'),
  });
  assert.equal(takeoverOf(missing).ok, false);
  assert.equal(takeoverOf(run('t-none', { state: 'failed' })).ok, false);

  // not offered either
  liveStore().runs.set('t-miss', missing);
  liveStore().activity.set('t-miss', []);
  const { ctx, dialogs } = fakeCtx(picking('agent'));
  await pickAgent(ctx);
  assert.deepEqual(dialogs.selects[1].options, ['Recent activity']);
  // an apostrophe in the path is quoted
  const odd = path.join(dir, `it's.jsonl`);
  fs.writeFileSync(odd, '{}\n');
  assert.deepEqual(
    takeoverOf(run('t-odd', { state: 'completed', transcriptPath: odd })),
    {
      ok: true,
      command: `pi --fork '${dir}/it'\\''s.jsonl'`,
    },
  );
});

test('runAgent records the transcript path for take over', async () => {
  reset();
  const dir = tempDir();
  const transcript = path.join(dir, 'run.jsonl');
  const session = sessionWith('take-2');
  await runAgent(runOptions({ transcriptPath: transcript }), {
    factory: factoryOf(async () => session),
  });
  assert.equal(liveRuns().list()[0].transcriptPath, transcript);
});

test('activity view: newest at the bottom, scrolling, hints', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  const entries: ActivityEntry[] = Array.from({ length: 12 }, (_, i) => ({
    at: at + i * 1000,
    kind: 'tool',
    text: `bash step ${i}`,
  }));
  entries.push({ at: at + 13_000, kind: 'error', text: 'bash: failed hard' });
  const live = run('v1', {
    name: 'worker',
    context: 'ctx',
    currentTool: 'bash',
    startedAt: at + 14_000,
    lastActivityAt: at + 14_000,
  });
  const spec = {
    run: live,
    entries,
    now: at + 14_000,
    width: 60,
    rows: 5,
    offset: 0,
    paint: plain,
  };

  const bottom = renderActivity(spec);
  assert.equal(bottom.lines.length, 5 + 4);
  assert.equal(bottom.lines[0], '⠋ worker · ctx · running: bash · 0:00');
  assert.equal(bottom.lines[2], '03:04:13 ▸ bash step 8');
  assert.equal(bottom.lines[6], '03:04:18 ✗ bash: failed hard');
  assert.match(
    bottom.lines[8],
    /^8 earlier · ↑↓\/PgUp\/PgDn scroll · Esc\/q close$/,
  );
  assert.equal(bottom.max, 8);

  const up = renderActivity({ ...spec, offset: 3 });
  assert.equal(up.lines[6], '03:04:14 ▸ bash step 9');
  assert.match(up.lines[8], /^5 earlier · 3 newer · ↑↓/);
  // clamped at the top, and a scrolled view stays put when lines arrive
  assert.equal(renderActivity({ ...spec, offset: 99 }).offset, 8);
  const grown = renderActivity({
    ...spec,
    entries: [...entries, { at: at + 15_000, kind: 'text', text: 'late' }],
    offset: 3,
    previousTotal: entries.length,
  });
  assert.equal(grown.offset, 4);
  assert.equal(grown.lines[6], up.lines[6]);

  const narrow = renderActivity({
    ...spec,
    width: 24,
    entries: [
      { at, kind: 'text', text: 'a long answer that wraps over lines' },
    ],
  });
  assert.ok(narrow.lines.every((line) => visibleWidth(line) <= 24));
  assert.ok(narrow.lines.length > 4 + 1);

  assert.match(
    renderActivity({ ...spec, entries: [] }).lines[2],
    /No activity yet/,
  );
  assert.match(
    renderActivity({ ...spec, entries: undefined }).lines[2],
    /older pi-agent-runner/,
  );
  assert.equal(
    renderActivity({ ...spec, run: undefined }).lines[0],
    'agent no longer listed',
  );
});

test('activity overlay: keys, live refresh, cleanup', async () => {
  reset();
  const session = sessionWith('ov-1', hangUntilAbort);
  const result = runAgent(runOptions({ label: { name: 'viewer' } }), {
    factory: factoryOf(async () => session),
  });
  await until(() => liveRuns().list()[0]?.state === 'running');
  for (let i = 0; i < 30; i++) {
    session.spec?.onActivity?.({
      type: 'tool_execution_start',
      toolCallId: `t${i}`,
      toolName: 'bash',
      args: { command: `step ${i}` },
    });
  }

  let renders = 0;
  const tui = { terminal: { rows: 20 }, requestRender: () => renders++ };
  let closed = 0;
  let component: Panel | undefined;
  const before = liveStore().listeners.size;
  const { ctx } = fakeCtx(picking('viewer', 'Recent activity'));
  ctx.ui.custom = (async (factory: PanelFactory, options: unknown) => {
    assert.equal((options as { overlay: boolean }).overlay, true);
    component = await factory(tui, plain, {}, () => closed++);
  }) as never;
  await pickAgent(ctx);
  assert.ok(component);
  assert.equal(liveStore().listeners.size, before + 1);

  const shown = () => component?.render(80) ?? [];
  assert.match(shown()[0], /^⠋ viewer · running: bash/);
  assert.match(shown().at(-3) ?? '', /bash step 29$/);
  component.handleInput?.('\x1b[A');
  assert.match(shown().at(-1) ?? '', / · 1 newer/);
  component.handleInput?.('\x1b[5~');
  assert.match(shown().at(-1) ?? '', /^\d+ earlier · \d+ newer/);
  component.handleInput?.('\x1b[6~');
  component.handleInput?.('\x1b[B');
  assert.doesNotMatch(shown().at(-1) ?? '', /newer/);

  // live: a burst of changes becomes one redraw
  renders = 0;
  for (let i = 0; i < 5; i++) {
    session.spec?.onActivity?.({ type: 'turn_start' });
  }
  assert.equal(renders, 0);
  await sleep(REFRESH_MS + 100);
  assert.equal(renders, 1);

  component.handleInput?.('q');
  assert.equal(closed, 1);
  assert.equal(liveStore().listeners.size, before);
  await sleep(REFRESH_MS + 50);
  const settled = renders;
  session.spec?.onActivity?.({ type: 'turn_start' });
  await sleep(REFRESH_MS + 50);
  assert.equal(renders, settled);

  session.onAbort?.();
  await result;
});

test('Esc closes the overlay too', async () => {
  reset();
  liveStore().runs.set('esc-1', run('esc-1', { name: 'escaper' }));
  liveStore().activity.set('esc-1', []);
  let closed = 0;
  const { ctx } = fakeCtx(picking('escaper', 'Recent activity'));
  ctx.ui.custom = (async (factory: PanelFactory) => {
    const component = await factory(
      { terminal: { rows: 20 }, requestRender() {} },
      plain,
      {},
      () => closed++,
    );
    component.handleInput?.('\x1b');
  }) as never;
  await pickAgent(ctx);
  assert.equal(closed, 1);
});
