import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { LiveRegistry, LiveRun } from '../src/live.ts';
import {
  CHANGE_MS,
  CLOCK_MS,
  MAX_ROWS,
  QUIET_AFTER_MS,
  RECENT_WINDOW_MS,
  SPINNER,
  SPIN_MS,
  WIDGET_KEY,
  formatCost,
  formatElapsed,
  formatTokens,
  mountRunsView,
  renderRunsView,
  shortModel,
  type MountOptions,
  type Paint,
  type RunsView,
  type ViewContext,
  type WidgetFactory,
} from '../src/view.ts';

const NOW = 10_000_000;
const SEC = 1000;
const MIN = 60_000;

const run = (over: Partial<LiveRun>): LiveRun => ({
  id: 's-exec',
  name: 'spiral-executor',
  context: 'ralph US-002',
  model: 'openai/gpt-6-luna',
  state: 'running',
  waitingForUser: false,
  currentTool: 'bash',
  turns: 4,
  toolCalls: 7,
  tokens: { input: 12_000, output: 300 },
  cost: 0.02,
  generation: 1,
  startedAt: NOW - 41 * SEC,
  lastActivityAt: NOW - SEC,
  lastStepAt: NOW - 3 * SEC,
  ...over,
});

const waiting = (over: Partial<LiveRun> = {}): LiveRun =>
  run({
    id: 's-critic',
    name: 'spiral-critic',
    context: 'ralplan #2',
    model: 'anthropic/claude-opus-5',
    waitingForUser: true,
    currentTool: 'edit',
    turns: 2,
    tokens: { input: 0, output: 0 },
    startedAt: NOW - 65 * SEC,
    ...over,
  });

const done = (over: Partial<LiveRun> = {}): LiveRun =>
  run({
    id: 'o-explorer',
    name: 'explorer',
    context: 'opium',
    state: 'completed',
    currentTool: undefined,
    turns: 6,
    tokens: { input: 8000, output: 100 },
    startedAt: NOW - 2 * MIN - 22 * SEC,
    endedAt: NOW - 2 * MIN,
    ...over,
  });

const render = (runs: LiveRun[], width = 100, frame = 0): string[] =>
  renderRunsView(runs, NOW, width, undefined, frame);

// column start of `text` on each line, measured in cells
const columnOf = (line: string, text: string): number =>
  visibleWidth(line.slice(0, line.indexOf(text)));

test('formatters: elapsed, tokens, cost, model', () => {
  assert.equal(formatElapsed(41 * SEC), '0:41');
  assert.equal(formatElapsed(65 * SEC), '1:05');
  assert.equal(formatElapsed(3600 * SEC + 62 * SEC), '1:01:02');
  assert.equal(formatTokens(0), '');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_300), '12.3k');
  assert.equal(formatTokens(99_960), '100k');
  assert.equal(formatTokens(2_400_000), '2.4M');
  assert.equal(formatCost(0), '');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(0.415), '$0.41');
  assert.equal(formatCost(12.5), '$12.50');
  assert.equal(formatCost(240.4), '$240');
  assert.equal(shortModel('openai/gpt-6-luna'), 'gpt-6-luna');
  assert.equal(shortModel('anthropic/claude-opus-5-20260101'), 'opus-5');
  assert.equal(shortModel(undefined), '');
});

test('the three example rows: spinner, waiting for you, done', () => {
  const lines = render([run({}), waiting(), done()]);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^agents ─+ 1 running · 1 waiting$/);
  assert.equal(visibleWidth(lines[0]), 100);
  // the critic started first, so it leads
  assert.deepEqual(lines.slice(1), [
    '⏸ spiral-critic    ralplan #2    opus-5      waiting for you  $0.02  1:05',
    '⠋ spiral-executor  ralph US-002  gpt-6-luna  bash             $0.02  0:41',
    '✓ explorer         opium         gpt-6-luna  done             $0.02  0:22',
  ]);
});

test('rows align: every column starts at the same cell', () => {
  const lines = render([run({}), waiting(), done()]).slice(1);
  for (const [a, b, c] of [
    ['ralplan', 'ralph US', 'opium'],
    ['opus-5', 'gpt-6', 'gpt-6'],
    ['waiting', 'bash', 'done'],
  ]) {
    const cols = [
      columnOf(lines[0], a),
      columnOf(lines[1], b),
      columnOf(lines[2], c),
    ];
    assert.equal(new Set(cols).size, 1, `${a}: ${cols}`);
  }
  assert.ok(
    lines.every((line) => visibleWidth(line) === visibleWidth(lines[0])),
  );
});

test('the spinner glyph follows the frame; static glyphs do not', () => {
  const runs = [run({}), waiting()];
  const a = render(runs, 100, 0);
  const b = render(runs, 100, 3);
  assert.ok(a[2].startsWith(SPINNER[0]));
  assert.ok(b[2].startsWith(SPINNER[3]));
  assert.equal(a[2].slice(1), b[2].slice(1));
  assert.equal(a[1], b[1]);
});

test('a running run with no tool reads as thinking; starting and idle', () => {
  const lines = render([
    run({ currentTool: undefined }),
    run({ id: 'b', state: 'starting', startedAt: NOW - SEC }),
    done({ id: 'c', state: 'idle', endedAt: undefined }),
  ]);
  assert.match(lines[1], /^⠋ .* thinking /);
  assert.match(lines[2], /^○ .* starting /);
  assert.match(lines[3], /^○ .* idle /);
});

test('a wrapping up run shows the status word instead of the tool', () => {
  const lines = render([run({ currentTool: 'bash', wrappingUp: true })]);
  assert.match(lines[1], /^⠋ .* wrapping up /);
  assert.doesNotMatch(lines[1], /bash/);
});

test('a quiet running run shows how long, past QUIET_AFTER_MS', () => {
  const at = (quiet: number): string =>
    render([run({ lastActivityAt: NOW - quiet })])[1];
  assert.doesNotMatch(at(QUIET_AFTER_MS - SEC), /quiet/);
  assert.match(at(QUIET_AFTER_MS), /^⠋ spiral-executor .* bash · quiet 0:30 /);
  assert.match(at(95 * SEC), / bash · quiet 1:35 /);
  const thinking = render([
    run({ currentTool: undefined, lastActivityAt: NOW - 40 * SEC }),
  ]);
  assert.match(thinking[1], / thinking · quiet 0:40 /);
});

test('stuck: no step for long and quiet; marked in row and header', () => {
  const stuck = run({
    lastStepAt: NOW - 3 * MIN - 10 * SEC,
    lastActivityAt: NOW - 3 * MIN - 10 * SEC,
    startedAt: NOW - 4 * MIN,
  });
  const lines = render([stuck]);
  assert.match(lines[0], /1 running · 1 stuck$/);
  assert.match(lines[1], /^▲ spiral-executor .* bash · quiet 3:10 .* 4:00$/);

  const seen: string[] = [];
  const paint: Paint = {
    fg: (color, text) => {
      seen.push(`${color}:${text}`);
      return text;
    },
    bold: (text) => text,
  };
  renderRunsView([stuck], NOW, 100, paint);
  for (const want of ['warning:▲', 'warning:bash', 'warning: · quiet 3:10']) {
    assert.ok(seen.includes(want), want);
  }
});

test('streaming without a step is not stuck; waiting never is', () => {
  const streaming = run({
    lastStepAt: NOW - 3 * MIN,
    lastActivityAt: NOW - SEC,
    startedAt: NOW - 4 * MIN,
  });
  const quietWait = waiting({
    lastStepAt: NOW - 5 * MIN,
    lastActivityAt: NOW - 5 * MIN,
    startedAt: NOW - 6 * MIN,
  });
  const lines = render([streaming, quietWait]);
  assert.doesNotMatch(lines[0], /stuck/);
  assert.match(lines[1], /^⏸ spiral-critic .* waiting for you /);
  assert.doesNotMatch(lines[1], /quiet/);
  assert.match(lines[2], /^⠋ spiral-executor .* bash /);
  assert.doesNotMatch(lines[2], /quiet/);
});

test('a wrapping up run keeps the quiet time and the stuck mark', () => {
  const lines = render([
    run({
      wrappingUp: true,
      lastStepAt: NOW - 3 * MIN,
      lastActivityAt: NOW - 3 * MIN,
      startedAt: NOW - 4 * MIN,
    }),
  ]);
  assert.match(lines[1], /^▲ spiral-executor .* wrapping up · quiet 3:00 /);
});

test('a clipped status keeps its quiet time', () => {
  const lines = render(
    [
      run({
        currentTool: 'mcp__custom-tools__bash',
        lastActivityAt: NOW - MIN,
      }),
    ],
    70,
  );
  assert.match(lines[1], / mcp__custom-tools… · quiet 1:00 /);
});

test('failure reasons trail the row, one line, clipped', () => {
  const lines = render([
    done({
      id: 'a',
      state: 'failed',
      error:
        '429 Too Many Requests:\n  rate limit exceeded for org, retry later',
      endedAt: NOW - 1 * SEC,
    }),
    done({
      id: 'b',
      state: 'timed_out',
      error: 'no activity for 300000ms',
      endedAt: NOW - 2 * SEC,
    }),
    done({
      id: 'c',
      state: 'structured_output_failed',
      error: 'missing field "summary"',
      endedAt: NOW - 3 * SEC,
    }),
  ]);
  assert.match(
    lines[1],
    /^✗ explorer .* failed .* \d:\d\d {2}429 Too Many Requests: rate limit ex/,
  );
  assert.match(lines[1], /rate limit excee…$/);
  assert.equal(visibleWidth(lines[1].slice(lines[1].indexOf('429'))), 40);
  assert.match(lines[2], / timed out .* \d:\d\d {2}no activity for 5:00$/);
  assert.match(lines[3], / bad output .* \d:\d\d {2}missing field "summary"$/);
  // a short reason fits where a long one has no room
  const at58 = (error: string): string =>
    render([done({ state: 'failed', error })], 58)[1];
  assert.match(at58('boom'), / 0:22 {2}boom$/);
  assert.match(at58('x'.repeat(40)), / 0:22$/);
});

test('a reason that only repeats the status is left out', () => {
  const [, timedOut] = render([
    done({ state: 'timed_out', error: 'timed out after 600000ms' }),
  ]);
  assert.match(timedOut, / timed out .* 0:22$/);
  const [, cancelled] = render([
    done({ state: 'cancelled', error: 'aborted' }),
  ]);
  assert.match(cancelled, / cancelled .* 0:22$/);
});

test('usage: cost when reported, tokens otherwise', () => {
  const lines = render([
    run({ id: 'a', cost: 0.42 }),
    run({ id: 'b', cost: 0, tokens: { input: 25_000, output: 800 } }),
    run({ id: 'c', cost: 0, tokens: { input: 0, output: 0 } }),
  ]);
  assert.match(lines[1], / bash {6,}\$0\.42 {2}0:41$/);
  assert.match(lines[2], / bash +25\.8k tok {2}0:41$/);
  assert.match(lines[3], / bash +0:41$/);
});

test('the generation shows after the name from the second one on', () => {
  const lines = render([
    run({ id: 'a', generation: 1 }),
    run({ id: 'b', name: 'fixer', generation: 2 }),
  ]);
  assert.match(lines[1], /^⠋ spiral-executor {2}/);
  assert.match(lines[2], /^⠋ fixer g2 {2,}ralph/);
  // the name clips, the generation stays
  const long = render([run({ name: 'n'.repeat(40), generation: 3 })]);
  assert.match(long[1], /^⠋ n{16}… g3 {2}/);
});

test('failed, bad output, timed out, cancelled: own glyphs', () => {
  const lines = render([
    done({ id: 'a', state: 'failed', endedAt: NOW - 1 * SEC }),
    done({ id: 'b', state: 'timed_out', endedAt: NOW - 2 * SEC }),
    done({ id: 'c', state: 'cancelled', endedAt: NOW - 3 * SEC }),
  ]);
  assert.match(lines[0], /^agents ─+$/, 'no counts when nothing runs');
  assert.match(lines[1], /^✗ explorer .* failed /);
  assert.match(lines[2], /^◔ explorer .* timed out /);
  assert.match(lines[3], /^■ explorer .* cancelled /);
  const bad = render([done({ state: 'structured_output_failed' })]);
  assert.match(bad[1], /^✗ explorer .* bad output /);
});

test('order: active oldest first, then three finished newest first', () => {
  const lines = render([
    done({ id: 'old', name: 'f-old', endedAt: NOW - 5 * MIN }),
    run({ id: 'young', name: 'r-young', startedAt: NOW - 10 * SEC }),
    done({ id: 'new', name: 'f-new', endedAt: NOW - 1 * MIN }),
    run({ id: 'elder', name: 'r-elder', startedAt: NOW - 50 * SEC }),
    done({ id: 'mid', name: 'f-mid', endedAt: NOW - 3 * MIN }),
    done({ id: 'oldest', name: 'f-oldest', endedAt: NOW - 8 * MIN }),
    done({ id: 'gone', name: 'f-gone', endedAt: NOW - RECENT_WINDOW_MS }),
  ]);
  const names = lines.slice(1).map((line) => line.split(/\s+/)[1]);
  assert.deepEqual(names, ['r-elder', 'r-young', 'f-new', 'f-mid', 'f-old']);
});

test('extra rows collapse into "+N more"', () => {
  const runs = Array.from({ length: 9 }, (_, i) =>
    run({ id: `r${i}`, name: `agent-${i}`, startedAt: NOW - (20 - i) * SEC }),
  );
  const lines = render(runs);
  assert.equal(lines.length, MAX_ROWS + 1);
  assert.match(lines[1], /agent-0 /);
  assert.equal(lines.at(-1), '  +4 more');
  assert.equal(render(runs.slice(0, MAX_ROWS)).length, MAX_ROWS + 1);
  assert.doesNotMatch(render(runs.slice(0, MAX_ROWS)).at(-1)!, /more/);
});

test('narrow widths drop model, then usage, then context; never wrap', () => {
  const runs = [run({}), waiting(), done()];
  const at = (width: number): string => render(runs, width)[2];
  assert.match(at(80), /gpt-6-luna/);
  const noModel = at(70);
  assert.doesNotMatch(noModel, /gpt-6/);
  assert.match(noModel, /ralph US-002 .*\$0\.02/);
  const noUsage = at(60);
  assert.doesNotMatch(noUsage, /\$/);
  assert.match(noUsage, /ralph US-002/);
  const noContext = at(50);
  assert.doesNotMatch(noContext, /ralph/);
  assert.match(noContext, /^⠋ spiral-executor .*bash .*0:41$/);

  const long = [
    run({
      name: 'n'.repeat(80),
      context: 'c'.repeat(80),
      currentTool: 'x'.repeat(80),
      generation: 12,
      lastActivityAt: NOW - 3 * MIN,
      lastStepAt: NOW - 3 * MIN,
    }),
    done({ id: 'f', state: 'failed', error: 'e\n'.repeat(80) }),
    ...runs,
  ];
  for (const width of [160, 100, 60, 40, 24, 12, 3, 1]) {
    for (const line of render(long, width)) {
      assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      assert.doesNotMatch(line, /\n/);
    }
  }
  assert.ok(render(long, 100).some((line) => /^▲ nnn+… g12 /.test(line)));
  assert.deepEqual(render(runs, 0), []);
});

test('nothing active or recent renders nothing', () => {
  assert.deepEqual(render([]), []);
  assert.deepEqual(render([done({ endedAt: NOW - RECENT_WINDOW_MS })]), []);
});

test('a theme colors states', () => {
  const seen: string[] = [];
  const paint: Paint = {
    fg: (color, text) => {
      seen.push(`${color}:${text}`);
      return text;
    },
    bold: (text) => text,
  };
  renderRunsView(
    [run({}), waiting(), done(), done({ id: 'f', state: 'failed' })],
    NOW,
    100,
    paint,
  );
  for (const want of [
    `accent:${SPINNER[0]}`,
    'warning:⏸',
    'warning:waiting for you',
    'success:✓',
    'error:✗',
    'dim:agents',
  ]) {
    assert.ok(seen.includes(want), want);
  }
});

// --- mount ---

interface Registry extends LiveRegistry {
  runs: LiveRun[];
  listeners: Set<() => void>;
  // registry.list calls, one per refresh
  lists: number;
  emit(): void;
}

const registry = (): Registry => {
  const r: Registry = {
    runs: [],
    listeners: new Set(),
    lists: 0,
    list: () => {
      r.lists += 1;
      return r.runs;
    },
    subscribe(listener) {
      r.listeners.add(listener);
      return () => r.listeners.delete(listener);
    },
    emit: () => r.listeners.forEach((fn) => fn()),
  };
  return r;
};

interface Timer {
  fn: () => void;
  ms: number;
}

interface Clock {
  now: number;
  timers: Map<number, Timer>;
  // the spin, clock or expiry timer; the change cooldown is left out
  ticks(): Timer[];
  cooldowns(): Timer[];
  // fire every pending timer once, advancing the clock by its delay
  fire(): void;
  // fire only the pending change cooldowns
  settle(): void;
  options(reg: LiveRegistry): MountOptions;
}

const drain = (c: Clock, pick: (t: Timer) => boolean): void => {
  const pending = [...c.timers.entries()].filter(([, t]) => pick(t));
  for (const [id] of pending) c.timers.delete(id);
  for (const [, t] of pending) {
    c.now += t.ms;
    t.fn();
  }
};

const clock = (): Clock => {
  let next = 0;
  const isCooldown = (t: Timer): boolean => t.ms === CHANGE_MS;
  const c: Clock = {
    now: NOW,
    timers: new Map(),
    ticks: () => [...c.timers.values()].filter((t) => !isCooldown(t)),
    cooldowns: () => [...c.timers.values()].filter(isCooldown),
    fire: () => drain(c, () => true),
    settle: () => drain(c, isCooldown),
    options: (reg) => ({
      registry: reg,
      now: () => c.now,
      setTimer: (fn, ms) => {
        next += 1;
        c.timers.set(next, { fn, ms });
        return next;
      },
      clearTimer: (handle) => c.timers.delete(handle as number),
    }),
  };
  return c;
};

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

interface Host extends ViewContext {
  widget?: WidgetFactory;
  calls: Array<WidgetFactory | undefined>;
  renders: number;
  draw(width?: number): string[] | undefined;
}

const host = (mode: ViewContext['mode'] = 'tui', hasUI = true): Host => {
  let component: ReturnType<WidgetFactory> | undefined;
  const h: Host = {
    mode,
    hasUI,
    calls: [],
    renders: 0,
    ui: {
      setWidget: ((key: string, content: WidgetFactory | undefined) => {
        assert.equal(key, WIDGET_KEY);
        h.calls.push(content);
        h.widget = content;
        component = content?.(
          { requestRender: () => (h.renders += 1) } as never,
          theme as never,
        );
      }) as ViewContext['ui']['setWidget'],
    },
    draw: (width = 100) => component?.render(width),
  };
  return h;
};

// the widget store is process-wide: a failed test must not leave an owner
const views: RunsView[] = [];
const mount = (ctx: ViewContext, options: MountOptions): RunsView => {
  const view = mountRunsView(ctx, options);
  views.push(view);
  return view;
};
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
});

test('mount is a no-op outside the TUI', () => {
  const reg = registry();
  reg.runs = [run({})];
  for (const ctx of [host('rpc'), host('tui', false)]) {
    mount(ctx, clock().options(reg));
    assert.equal(ctx.calls.length, 0);
    assert.equal(reg.listeners.size, 0);
  }
});

test('empty registry shows no widget; it appears and leaves with runs', () => {
  const reg = registry();
  const c = clock();
  const ctx = host();
  mount(ctx, c.options(reg));
  assert.equal(ctx.calls.length, 0);
  assert.equal(c.timers.size, 0, 'no timer while empty');

  reg.runs = [run({})];
  reg.emit();
  assert.equal(typeof ctx.widget, 'function', 'first change draws at once');
  assert.match(ctx.draw()![1], /spiral-executor/);

  reg.runs = [];
  reg.emit();
  assert.equal(ctx.calls.length, 1, 'second change waits for the cooldown');
  c.settle();
  assert.equal(ctx.calls.at(-1), undefined, 'widget removed');
  c.settle();
  assert.equal(c.timers.size, 0, 'nothing left once quiet');
});

test('a burst of changes refreshes at most twice until timers fire', () => {
  const reg = registry();
  reg.runs = [run({})];
  const c = clock();
  const ctx = host();
  mount(ctx, c.options(reg));
  const before = reg.lists;
  for (let i = 0; i < 50; i += 1) {
    reg.runs = [run({ currentTool: `tool-${i}` })];
    reg.emit();
  }
  assert.ok(reg.lists - before <= 2, `${reg.lists - before} refreshes`);
  assert.equal(c.cooldowns().length, 1);
  // the trailing refresh picks up the last change
  c.settle();
  assert.equal(reg.lists - before, 2);
  assert.match(ctx.draw()![1], / tool-49 /);
  c.settle();
  assert.equal(c.cooldowns().length, 0, 'quiet: cooldown ends');
});

test('the spinner ticks only while something runs', () => {
  const reg = registry();
  const c = clock();
  const ctx = host();
  reg.runs = [run({})];
  mount(ctx, c.options(reg));
  assert.deepEqual(
    c.ticks().map((t) => t.ms),
    [SPIN_MS],
  );

  const first = ctx.draw()!;
  assert.equal(ctx.draw(), first, 'same frame is cached');
  // registry chatter keeps the same tick, so the spinner is not starved
  const tick = c.ticks()[0];
  reg.emit();
  reg.emit();
  c.settle();
  assert.deepEqual(c.ticks(), [tick]);

  const renders = ctx.renders;
  c.fire();
  assert.equal(ctx.renders, renders + 1);
  const second = ctx.draw()!;
  assert.ok(second[1].startsWith(SPINNER[1]));
  assert.equal(second[1].slice(1), first[1].slice(1), 'only the glyph moved');

  // waiting for the user: no spinner, the clock still moves each second
  reg.runs = [waiting()];
  reg.emit();
  c.settle();
  assert.deepEqual(
    c.ticks().map((t) => t.ms),
    [CLOCK_MS],
  );

  // finished: no tick, one wake-up when the row leaves the window
  reg.runs = [done({ endedAt: c.now })];
  reg.emit();
  c.settle();
  c.settle();
  assert.equal(c.cooldowns().length, 0);
  assert.deepEqual(
    c.ticks().map((t) => t.ms),
    [RECENT_WINDOW_MS],
  );
  c.fire();
  assert.equal(c.timers.size, 0, 'idle: no timer');
  assert.equal(ctx.calls.at(-1), undefined);
});

test('the clock advances on ticks', () => {
  const reg = registry();
  const c = clock();
  const ctx = host();
  reg.runs = [run({})];
  mount(ctx, c.options(reg));
  assert.match(ctx.draw()![1], /0:41$/);
  // 13 spinner ticks of 160 ms: two seconds later
  for (let i = 0; i < 13; i += 1) c.fire();
  assert.match(ctx.draw()![1], /0:43$/);
});

test('two mounts render once and hand over on dispose', () => {
  const reg = registry();
  reg.runs = [run({})];
  const c = clock();
  const opium = host();
  const spiral = host();
  const a = mount(opium, c.options(reg));
  const b = mount(spiral, c.options(reg));
  assert.equal(opium.calls.length, 1);
  assert.equal(spiral.calls.length, 0, 'second mount only counts');
  assert.equal(reg.listeners.size, 1);
  assert.equal(c.ticks().length, 1);

  // the owner is mid-cooldown when it goes away
  reg.emit();
  assert.equal(c.cooldowns().length, 1);
  a.dispose();
  assert.equal(opium.calls.at(-1), undefined, 'old widget cleared');
  assert.equal(typeof spiral.widget, 'function', 'handed over');
  assert.equal(reg.listeners.size, 1);
  assert.equal(c.ticks().length, 1);
  assert.equal(c.cooldowns().length, 0, 'old cooldown cleared');

  // disposing twice is harmless, and a non-owner dispose changes nothing
  a.dispose();
  const third = host();
  mount(third, c.options(reg)).dispose();
  assert.equal(third.calls.length, 0);
  assert.equal(typeof spiral.widget, 'function');

  b.dispose();
  assert.equal(spiral.calls.at(-1), undefined);
  assert.equal(reg.listeners.size, 0);
  assert.equal(c.timers.size, 0);
});

test('dispose clears the widget, every timer and the subscription', () => {
  const reg = registry();
  reg.runs = [run({}), done()];
  const c = clock();
  const ctx = host();
  const view = mount(ctx, c.options(reg));
  reg.emit();
  reg.emit();
  assert.equal(c.ticks().length, 1);
  assert.equal(c.cooldowns().length, 1);
  view.dispose();
  assert.equal(c.timers.size, 0, 'tick and cooldown both cleared');
  assert.equal(reg.listeners.size, 0);
  assert.equal(ctx.calls.at(-1), undefined);
  const count = ctx.calls.length;
  reg.emit();
  view.dispose();
  assert.equal(ctx.calls.length, count, 'inert after dispose');

  // the next mount in the process starts fresh
  mount(ctx, c.options(reg));
  assert.equal(typeof ctx.widget, 'function');
});

test('the row shows the tool action with its arguments', () => {
  const lines = render([
    run({ currentTool: 'read', currentAction: 'read src/feed/parser.ts' }),
  ]);
  assert.match(lines[1], / read src\/feed\/parser\.ts /);
});

test('row priority: wrapping up, action, last thought, thinking', () => {
  const thought = 'Planning the fix';
  const row = (over: Partial<LiveRun>) => render([run(over)])[1];
  const base = { currentTool: undefined, lastThought: thought };
  assert.match(row(base), /^⠋ .* Planning the fix /);
  assert.match(
    row({ ...base, currentTool: 'bash', currentAction: 'bash npm test' }),
    / bash npm test /,
  );
  assert.doesNotMatch(
    row({ ...base, currentTool: 'bash', currentAction: 'bash npm test' }),
    /Planning/,
  );
  const wrapping = row({ ...base, currentTool: 'bash', wrappingUp: true });
  assert.match(wrapping, / wrapping up /);
  assert.doesNotMatch(wrapping, /Planning|bash/);
  assert.match(row({ currentTool: undefined }), / thinking /);
});

test('a long thought is clipped to the row width', () => {
  const lines = render(
    [run({ currentTool: undefined, lastThought: 'word '.repeat(40).trim() })],
    80,
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
  assert.match(lines[1], /word/);
});

test('a wide terminal gives the doing text the room left', () => {
  const thought = 'With all claims checked, I can write the final verdict now';
  const action = 'grep "No JS files found in .omc/plans and nothing else"';
  const rows = [
    run({ id: 'a', currentTool: undefined, lastThought: thought }),
    run({ id: 'b', currentTool: 'grep', currentAction: action }),
    done({ id: 'c' }),
  ];
  const wide = render(rows, 200);
  assert.match(wide[1], new RegExp(` ${thought} `));
  assert.match(wide[2], new RegExp(` ${action.replace(/[".]/g, '\\$&')} `));
  assert.ok(wide.every((line) => visibleWidth(line) <= 200));
  // columns stay aligned across rows
  const at = (line: string): number => line.indexOf('0:4');
  assert.equal(at(wide[1]), at(wide[2]));
  const narrow = render(rows, 100);
  assert.doesNotMatch(narrow[1], /final verdict/);
  assert.match(narrow[1], /… /);
  assert.ok(narrow.every((line) => visibleWidth(line) <= 100));
});

test('a thought uses at most its stored 120 characters', () => {
  const thought = `${'w'.repeat(119)}…`;
  const lines = render(
    [run({ currentTool: undefined, lastThought: thought })],
    300,
  );
  assert.ok(lines[1].includes(thought));
});

test('a failure note still fits beside a long thought', () => {
  const lines = render(
    [
      run({
        id: 'a',
        currentTool: undefined,
        lastThought: 'x'.repeat(100),
      }),
      done({ id: 'b', state: 'failed', error: 'rate limit exceeded' }),
    ],
    140,
  );
  assert.match(lines[2], /rate limit exceeded/);
});
