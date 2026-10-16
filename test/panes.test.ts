import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { ActivityEntry, LiveRegistry, LiveRun } from '../src/live.ts';
import type { FeedRecord } from '../src/pane-feed.ts';
import {
  detectMultiplexer,
  mountPanes,
  type PanesContext,
  type PanesHandle,
  type PanesOptions,
} from '../src/panes.ts';

const LINGER = 5000;
const GRACE = 1000;

const herdrEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', PATH: '/bin' };
const tmuxEnv = { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%0' };

let dir: string;
let handles: PanesHandle[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panes-test-'));
});

afterEach(() => {
  for (const handle of handles) handle.dispose();
  handles = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (id: string, over: Partial<LiveRun> = {}): LiveRun => ({
  id,
  name: 'explorer',
  context: 'opium',
  model: 'anthropic/claude-opus-5-5',
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

const fakeRegistry = () => {
  const listeners = new Set<() => void>();
  let runs: LiveRun[] = [];
  const registry: LiveRegistry = {
    list: () => runs.map((r) => ({ ...r, tokens: { ...r.tokens } })),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    registry,
    listeners,
    set(next: LiveRun[]) {
      runs = next;
      for (const listener of [...listeners]) listener();
    },
  };
};

interface Timer {
  fn: () => void;
  ms: number;
}

const fakeTimers = () => {
  let nextId = 1;
  const pending = new Map<number, Timer>();
  return {
    setTimer(fn: () => void, ms: number) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(handle: unknown) {
      pending.delete(handle as number);
    },
    pending: () => [...pending.values()],
    fireAll() {
      for (const [id, timer] of [...pending]) {
        pending.delete(id);
        timer.fn();
      }
    },
  };
};

type Call = string[];

interface Fake {
  calls: Call[];
  /** Makes the next matching call(s) reject. */
  failWhen?: (call: Call) => boolean;
  opened: number;
}

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

const setup = (
  over: Partial<PanesOptions> = {},
  env: NodeJS.ProcessEnv = herdrEnv,
) => {
  const reg = fakeRegistry();
  const timers = fakeTimers();
  const fake: Fake = { calls: [], opened: 0 };
  const entries = new Map<string, ActivityEntry[]>();
  const notes: Array<[string, string | undefined]> = [];
  let clock = 10_000;
  const options: PanesOptions = {
    registry: reg.registry,
    env,
    hasBinary: () => true,
    feedDir: path.join(dir, 'feeds'),
    viewer: '/pkg/dist/pane-viewer.js',
    node: '/usr/bin/node',
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    activity: (id) => entries.get(id),
    exec: (file, args) => {
      const call = [file, ...args];
      fake.calls.push(call);
      if (fake.failWhen?.(call)) return Promise.reject(new Error('boom'));
      fake.opened += 1;
      const isHerdr = file === 'herdr';
      if (isHerdr && args[1] === 'split') {
        const id = `w1:p${fake.opened + 1}`;
        return Promise.resolve(`{"result":{"pane":{"pane_id":"${id}"}}}`);
      }
      if (file === 'tmux' && args[0] === 'split-window') {
        return Promise.resolve(`%${fake.opened}\n`);
      }
      return Promise.resolve('{}');
    },
    execSync: () => undefined,
    ...over,
  };
  const ctx: PanesContext = {
    mode: 'tui',
    hasUI: true,
    cwd: '/work/proj',
    ui: { notify: (message, type) => notes.push([message, type]) },
  };
  const mount = (opts: Partial<PanesOptions> = {}, c = ctx): PanesHandle => {
    const handle = mountPanes(c, { ...options, ...opts });
    handles.push(handle);
    return handle;
  };
  return {
    reg,
    timers,
    fake,
    entries,
    notes,
    mount,
    options,
    ctx,
    tick: (ms: number) => {
      clock += ms;
    },
  };
};

const feedFiles = (): string[] => {
  try {
    return fs.readdirSync(path.join(dir, 'feeds')).sort();
  } catch {
    return [];
  }
};

const records = (file: string): FeedRecord[] =>
  fs
    .readFileSync(path.join(dir, 'feeds', file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FeedRecord);

const splits = (calls: Call[]) =>
  calls.filter((c) => c[0] === 'herdr' && c[2] === 'split');

test('detectMultiplexer: herdr first, then tmux, by env and binary', () => {
  const has =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name);
  assert.equal(detectMultiplexer('auto', herdrEnv, has('herdr')), 'herdr');
  assert.equal(
    detectMultiplexer(
      'auto',
      { ...herdrEnv, ...tmuxEnv },
      has('herdr', 'tmux'),
    ),
    'herdr',
  );
  assert.equal(
    detectMultiplexer('auto', { ...herdrEnv, ...tmuxEnv }, has('tmux')),
    'tmux',
  );
  assert.equal(detectMultiplexer(undefined, tmuxEnv, has('tmux')), 'tmux');
  assert.equal(detectMultiplexer('auto', tmuxEnv, has('herdr')), undefined);
  assert.equal(detectMultiplexer('auto', {}, has('herdr', 'tmux')), undefined);
  assert.equal(
    detectMultiplexer('tmux', { ...herdrEnv }, has('herdr', 'tmux')),
    undefined,
  );
  assert.equal(
    detectMultiplexer('herdr', { ...herdrEnv, ...tmuxEnv }, has('herdr')),
    'herdr',
  );
});

test('does nothing without a TUI', () => {
  const t = setup();
  t.mount({}, { ...t.ctx, hasUI: false });
  t.mount({}, { ...t.ctx, mode: 'print' as PanesContext['mode'] });
  t.reg.set([run('a')]);
  assert.equal(t.reg.listeners.size, 0);
  assert.deepEqual(t.fake.calls, []);
});

test('does nothing without a multiplexer', () => {
  const t = setup({}, {});
  t.mount();
  t.reg.set([run('a')]);
  assert.equal(t.reg.listeners.size, 0);
  assert.deepEqual(t.fake.calls, []);
  assert.deepEqual(feedFiles(), []);
});

test('herdr: a running child opens a pane with the viewer', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a', { state: 'starting' })]);
  await settle();
  assert.deepEqual(t.fake.calls, []);

  t.reg.set([run('a')]);
  await settle();
  const feed = path.join(dir, 'feeds', 'a-g1.jsonl');
  assert.deepEqual(t.fake.calls, [
    [
      'herdr',
      'pane',
      'split',
      '--current',
      '--direction',
      'right',
      '--cwd',
      '/work/proj',
      '--no-focus',
    ],
    [
      'herdr',
      'pane',
      'run',
      'w1:p2',
      `exec '/usr/bin/node' '/pkg/dist/pane-viewer.js' '${feed}' '${LINGER}'`,
    ],
  ]);
  const [start] = records('a-g1.jsonl');
  assert.equal(start.t, 'start');
  assert.equal((start as { name: string }).name, 'explorer');
  assert.equal((start as { pid: number }).pid, process.pid);
});

test('a .ts viewer is started with type stripping', async () => {
  const t = setup({ viewer: '/pkg/src/pane-viewer.ts' });
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  const line = t.fake.calls[1].at(-1);
  assert.match(
    line ?? '',
    /^exec '.*node' '--experimental-strip-types' '.*pane-viewer\.ts'/,
  );
});

test('tmux: first pane right of the user pane, then down', async () => {
  const t = setup({}, tmuxEnv);
  t.mount();
  t.reg.set([run('a'), run('b')]);
  await settle();
  const feedA = path.join(dir, 'feeds', 'a-g1.jsonl');
  const viewer = (feed: string) =>
    `'/usr/bin/node' '/pkg/dist/pane-viewer.js' '${feed}' '${LINGER}'`;
  assert.deepEqual(t.fake.calls, [
    [
      'tmux',
      'split-window',
      '-d',
      '-h',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      '/work/proj',
      '-t',
      '%0',
      viewer(feedA),
    ],
    [
      'tmux',
      'split-window',
      '-d',
      '-v',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      '/work/proj',
      '-t',
      '%1',
      viewer(path.join(dir, 'feeds', 'b-g1.jsonl')),
    ],
  ]);
});

test('herdr: first pane right, later ones down', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a'), run('b'), run('c')]);
  await settle();
  const dirs = splits(t.fake.calls).map((c) => c.slice(3, 6));
  assert.deepEqual(dirs, [
    ['--current', '--direction', 'right'],
    ['--pane', 'w1:p2', '--direction'],
    ['--pane', 'w1:p4', '--direction'],
  ]);
  assert.deepEqual(
    splits(t.fake.calls).map((c) => c[c.indexOf('--direction') + 1]),
    ['right', 'down', 'down'],
  );
});

test('at most max panes; a later run never gets one', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a'), run('b'), run('c'), run('d')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 3);
  assert.deepEqual(feedFiles(), ['a-g1.jsonl', 'b-g1.jsonl', 'c-g1.jsonl']);

  // a pane closes: the fourth run, still running, is not queued
  t.reg.set([
    run('a', { state: 'completed', endedAt: 2000 }),
    run('b'),
    run('c'),
    run('d'),
  ]);
  t.timers.fireAll();
  await settle();
  assert.equal(splits(t.fake.calls).length, 3);
  assert.deepEqual(feedFiles(), ['b-g1.jsonl', 'c-g1.jsonl']);

  // but a run that starts now has room
  t.reg.set([run('b'), run('c'), run('d'), run('e')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 4);
  assert.deepEqual(feedFiles(), ['b-g1.jsonl', 'c-g1.jsonl', 'e-g1.jsonl']);
});

test('max is configurable', async () => {
  const t = setup({ max: 1 });
  t.mount();
  t.reg.set([run('a'), run('b')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 1);
});

test('the pane closes after the end plus the linger', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  t.reg.set([
    run('a', {
      state: 'failed',
      error: 'boom',
      turns: 3,
      tokens: { input: 10, output: 5 },
      endedAt: 3000,
    }),
  ]);
  await settle();
  const end = records('a-g1.jsonl').at(-1) as Extract<FeedRecord, { t: 'end' }>;
  assert.equal(end.t, 'end');
  assert.equal(end.status, 'failed');
  assert.equal(end.error, 'boom');
  assert.equal(end.turns, 3);
  // nothing is closed before the timer
  assert.equal(t.fake.calls.filter((c) => c[2] === 'close').length, 0);
  const [timer] = t.timers.pending();
  assert.equal(timer.ms, LINGER + GRACE);

  t.timers.fireAll();
  await settle();
  assert.deepEqual(t.fake.calls.at(-1), ['herdr', 'pane', 'close', 'w1:p2']);
  assert.deepEqual(feedFiles(), []);
});

test('tmux closes with kill-pane; a gone pane is fine', async () => {
  const t = setup({}, tmuxEnv);
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  t.fake.failWhen = (call) => call[1] === 'kill-pane';
  t.reg.set([run('a', { state: 'completed', endedAt: 2000 })]);
  t.timers.fireAll();
  await settle();
  assert.deepEqual(t.fake.calls.at(-1), ['tmux', 'kill-pane', '-t', '%1']);
  assert.deepEqual(t.notes, []);
  assert.deepEqual(feedFiles(), []);
});

test('a run that leaves the registry ends its pane', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  t.reg.set([]);
  const end = records('a-g1.jsonl').at(-1) as Extract<FeedRecord, { t: 'end' }>;
  assert.equal(end.t, 'end');
  assert.equal(end.status, 'ended');
  t.timers.fireAll();
  await settle();
  assert.equal(t.fake.calls.filter((c) => c[2] === 'close').length, 1);
});

test('a revived run gets a new pane for its next generation', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  t.reg.set([run('a', { state: 'completed', endedAt: 2000 })]);
  t.reg.set([run('a', { generation: 2, startedAt: 5000 })]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 2);
  assert.deepEqual(feedFiles(), ['a-g1.jsonl', 'a-g2.jsonl']);
  // the second pane stacks under the lingering first one
  assert.equal(splits(t.fake.calls)[1][3], '--pane');
});

test('the feed carries entries once, state changes and the end', async () => {
  const t = setup();
  t.mount();
  const gen: ActivityEntry = {
    at: 1,
    kind: 'generation',
    text: 'generation 1 started',
  };
  const tool: ActivityEntry = { at: 2, kind: 'tool', text: 'read a.ts' };
  t.entries.set('a', [gen, tool]);
  t.reg.set([run('a')]);
  await settle();
  t.reg.set([run('a')]); // a change with nothing new
  const thought: ActivityEntry = { at: 3, kind: 'thought', text: 'hmm' };
  t.entries.set('a', [gen, tool, thought]);
  t.reg.set([run('a', { turns: 1, toolCalls: 1 })]);
  const text: ActivityEntry = { at: 4, kind: 'text', text: 'done' };
  t.entries.set('a', [gen, tool, thought, text]);
  t.reg.set([
    run('a', {
      state: 'completed',
      turns: 1,
      toolCalls: 1,
      tokens: { input: 7, output: 3 },
      endedAt: 9000,
    }),
  ]);

  const out = records('a-g1.jsonl');
  assert.deepEqual(
    out.map((r) => (r.t === 'entry' ? `entry:${r.kind}` : r.t)),
    [
      'start',
      'entry:generation',
      'entry:tool',
      'state',
      'entry:thought',
      'state',
      'entry:text',
      'end',
    ],
  );
  const end = out.at(-1) as Extract<FeedRecord, { t: 'end' }>;
  assert.deepEqual(end.tokens, { input: 7, output: 3 });
  assert.equal(end.status, 'completed');
});

test('a shifted activity buffer does not repeat entries', async () => {
  const t = setup();
  t.mount();
  const mk = (n: number): ActivityEntry => ({
    at: n,
    kind: 'tool',
    text: `tool ${n}`,
  });
  t.entries.set('a', [mk(1), mk(2), mk(3)]);
  t.reg.set([run('a')]);
  t.entries.set('a', [mk(2), mk(3), mk(4)]);
  t.reg.set([run('a', { turns: 1 })]);
  const texts = records('a-g1.jsonl')
    .filter((r) => r.t === 'entry')
    .map((r) => (r as { text: string }).text);
  assert.deepEqual(texts, ['tool 1', 'tool 2', 'tool 3', 'tool 4']);
});

test('feeds are private and removed with the pane', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('weird/../id')]);
  await settle();
  const feeds = path.join(dir, 'feeds');
  assert.equal(fs.statSync(feeds).mode & 0o777, 0o700);
  const [name] = feedFiles();
  assert.equal(name, 'weird_.._id-g1.jsonl');
  assert.equal(fs.statSync(path.join(feeds, name)).mode & 0o777, 0o600);
  t.reg.set([]);
  t.timers.fireAll();
  await settle();
  assert.deepEqual(feedFiles(), []);
});

test('a linked feed directory is refused with a warning', async () => {
  const t = setup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'panes-target-'));
  fs.symlinkSync(target, path.join(dir, 'feeds'));
  try {
    t.mount();
    t.reg.set([run('a'), run('b')]);
    await settle();
    assert.deepEqual(t.fake.calls, []);
    assert.equal(t.notes.length, 1);
    assert.equal(t.notes[0][1], 'warning');
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('the filter picks which runs get a pane', async () => {
  const t = setup({ filter: (r) => r.name === 'critic' });
  t.mount();
  t.reg.set([run('a'), run('b', { name: 'critic' })]);
  await settle();
  assert.deepEqual(feedFiles(), ['b-g1.jsonl']);
});

test('one owner per process: a second mount opens nothing', async () => {
  const t = setup();
  t.mount();
  const second = fakeRegistry();
  t.mount({ registry: second.registry });
  t.reg.set([run('a')]);
  second.set([run('a')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 1);
  assert.equal(second.listeners.size, 0);
});

test('handover: the next mount takes over a disposed owner', async () => {
  const t = setup();
  const first = t.mount();
  const second = t.mount();
  t.reg.set([run('a')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 1);

  first.dispose();
  await settle();
  const closes = t.fake.calls.filter((c) => c[2] === 'close');
  assert.deepEqual(closes, [['herdr', 'pane', 'close', 'w1:p2']]);
  assert.equal(t.reg.listeners.size, 1);
  // the new owner picks up the run that is still going
  await settle();
  assert.equal(splits(t.fake.calls).length, 2);

  second.dispose();
  await settle();
  assert.equal(t.reg.listeners.size, 0);
  assert.deepEqual(feedFiles(), []);
});

test('disposing a mount that is not the owner changes nothing', async () => {
  const t = setup();
  t.mount();
  const second = t.mount();
  t.reg.set([run('a')]);
  await settle();
  second.dispose();
  await settle();
  assert.equal(t.fake.calls.filter((c) => c[2] === 'close').length, 0);
  assert.deepEqual(feedFiles(), ['a-g1.jsonl']);
});

test('dispose kills every open pane and removes the feeds', async () => {
  const t = setup();
  const handle = t.mount();
  t.reg.set([run('a'), run('b')]);
  await settle();
  handle.dispose();
  await settle();
  const closes = t.fake.calls.filter((c) => c[2] === 'close');
  assert.deepEqual(
    closes.map((c) => c[3]),
    ['w1:p2', 'w1:p4'],
  );
  assert.deepEqual(feedFiles(), []);
  // nothing opens afterwards
  t.reg.set([run('a'), run('b'), run('c')]);
  await settle();
  assert.equal(splits(t.fake.calls).length, 2);
});

test('dispose before a pane is opened opens nothing', async () => {
  const t = setup();
  const handle = t.mount();
  t.reg.set([run('a')]);
  handle.dispose();
  await settle();
  assert.deepEqual(t.fake.calls, []);
  assert.deepEqual(feedFiles(), []);
});

test('dispose during a split closes the pane when it appears', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = setup();
  const inner = t.options.exec;
  assert.ok(inner);
  const handle = t.mount({
    exec: async (file, args) => {
      if (args[1] === 'split') await gate;
      return inner(file, args);
    },
  });
  t.reg.set([run('a')]);
  await settle();
  handle.dispose();
  release();
  await settle();
  const closes = t.fake.calls.filter((c) => c[2] === 'close');
  assert.deepEqual(closes, [['herdr', 'pane', 'close', 'w1:p2']]);
  assert.deepEqual(feedFiles(), []);
});

test('a failing CLI warns once and stops opening panes', async () => {
  const t = setup();
  t.fake.failWhen = (call) => call[2] === 'split';
  t.mount();
  t.reg.set([run('a'), run('b')]);
  await settle();
  t.reg.set([run('a'), run('b'), run('c')]);
  await settle();
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0][1], 'warning');
  assert.match(t.notes[0][0], /herdr/);
  assert.equal(splits(t.fake.calls).length, 1);
  assert.deepEqual(feedFiles(), []);
});

test('a failing pane run closes the new pane and disables panes', async () => {
  const t = setup();
  t.fake.failWhen = (call) => call[2] === 'run';
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  assert.equal(t.notes.length, 1);
  assert.deepEqual(t.fake.calls.at(-1), ['herdr', 'pane', 'close', 'w1:p2']);
});

test('a viewer pane closed by hand does not disable panes', async () => {
  const t = setup();
  t.mount();
  t.reg.set([run('a')]);
  await settle();
  // splitting the vanished viewer fails; the user's own pane still works
  t.fake.failWhen = (call) => call[2] === 'split' && call.includes('--pane');
  t.reg.set([run('a'), run('b')]);
  await settle();
  assert.deepEqual(t.notes, []);
  const last = splits(t.fake.calls).at(-1) ?? [];
  assert.equal(last[3], '--current');
  assert.deepEqual(feedFiles(), ['b-g1.jsonl']);
});

test('a throwing filter or notify never breaks the registry', async () => {
  const t = setup({
    filter: () => {
      throw new Error('bad filter');
    },
  });
  t.mount();
  assert.doesNotThrow(() => t.reg.set([run('a')]));
  await settle();
  assert.deepEqual(t.fake.calls, []);
});
