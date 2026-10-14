// One widget for every live child agent in the process (Spiral's and
// Opium's runs together), shown above the editor while something runs or
// finished recently. The renderer is pure. The controller re-lays rows on
// registry changes and once a second for the clock; between those, spinner
// ticks only swap the glyph on cached rows. Nothing ticks while idle.

import type {
  ExtensionContext,
  Theme,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  isPossiblyStuck,
  liveRuns,
  type LiveRegistry,
  type LiveRun,
} from './live.ts';

export const WIDGET_KEY = 'pi-agent-runner-runs';
export const RECENT_WINDOW_MS = 10 * 60_000;
export const MAX_RECENT = 3;
// rows below the header, the "+N more" line included
export const MAX_ROWS = 6;
export const SPIN_MS = 160;
export const CLOCK_MS = 1000;
export const CHANGE_MS = 100;
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// a running row shows how long it has been quiet past this; tool calls and
// model turns that are going fine send events well within it
export const QUIET_AFTER_MS = 30_000;

export type Paint = Pick<Theme, 'fg' | 'bold'>;

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };

export const isActive = (run: LiveRun): boolean =>
  run.state === 'starting' || run.state === 'running' || run.waitingForUser;

const isSpinning = (run: LiveRun): boolean =>
  run.state === 'running' && !run.waitingForUser;

// an idle run has no end yet; its last activity stands in for one
export const endOf = (run: LiveRun): number =>
  run.endedAt ?? run.lastActivityAt;

const quietFor = (run: LiveRun, now: number): number =>
  now - run.lastActivityAt;

// no step for STUCK_AFTER_MS and no sign of life either: a child that
// streams a long answer or tool output is slow, not stuck
const isStuck = (run: LiveRun, now: number): boolean =>
  isPossiblyStuck(run, now) && quietFor(run, now) >= QUIET_AFTER_MS;

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const formatElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s % 60)}`;
  return `${m}:${pad2(s % 60)}`;
};

export const formatTokens = (n: number): string => {
  if (n <= 0) return '';
  if (n < 1000) return `${n}`;
  if (n < 99_950) return `${(n / 1000).toFixed(1)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

export const formatCost = (usd: number): string => {
  if (!(usd > 0)) return '';
  if (usd < 0.01) return '<$0.01';
  if (usd < 99.995) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
};

// cost when the provider reports one; subscription providers report 0
const usageOf = (run: LiveRun): string => {
  if (run.cost > 0) return formatCost(run.cost);
  const tokens = formatTokens(run.tokens.input + run.tokens.output);
  return tokens && `${tokens} tok`;
};

// 'anthropic/claude-opus-5-5-20260101' -> 'opus-5-5'
export const shortModel = (model?: string): string => {
  if (!model) return '';
  return model
    .slice(model.lastIndexOf('/') + 1)
    .replace(/^claude-/, '')
    .replace(/-(\d{8}|latest)$/, '');
};

// control characters would break the widget line, not just look odd
export const oneLine = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();

const graphemes = new Intl.Segmenter();

// plain-text clip; truncateToWidth would wrap the ellipsis in resets and
// drop the cell's color from it
const clip = (text: string, width: number): string => {
  if (visibleWidth(text) <= width) return text;
  if (width < 1) return '';
  let out = '';
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = visibleWidth(segment);
    if (used + w > width - 1) break;
    out += segment;
    used += w;
  }
  return `${out}…`;
};

interface Rows {
  active: LiveRun[];
  recent: LiveRun[];
}

// active oldest first, so rows keep their place; finished newest first
const selectRows = (runs: LiveRun[], now: number): Rows => ({
  active: runs
    .filter(isActive)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)),
  recent: runs
    .filter((run) => !isActive(run) && now - endOf(run) < RECENT_WINDOW_MS)
    .sort((a, b) => endOf(b) - endOf(a) || a.id.localeCompare(b.id))
    .slice(0, MAX_RECENT),
});

export interface Glyph {
  text: string;
  color: ThemeColor;
  spin: boolean;
}

export interface Tail {
  text: string;
  color: ThemeColor;
}

export interface Status {
  glyph: Glyph;
  text: string;
  color: ThemeColor;
  // kept when the cell is clipped: the quiet time matters more than the tool
  tail?: Tail;
  note?: string;
}

const NOTE_MAX = 40;

// 'timed out after 600000ms' on a timed out row says nothing the status
// and the clock do not; 'no activity for 300000ms' does
const reasonOf = (run: LiveRun, label: string): string => {
  let text = oneLine(run.error ?? '').replace(/\b(\d{4,})ms\b/g, (_, ms) =>
    formatElapsed(Number(ms)),
  );
  if (text.toLowerCase().startsWith(label)) {
    text = text.slice(label.length).trim();
  }
  return text === 'aborted' || text.startsWith('after ') ? '' : text;
};

const doingOf = (run: LiveRun): Tail => {
  if (run.wrappingUp) return { text: 'wrapping up', color: 'warning' };
  if (run.currentTool) return { text: oneLine(run.currentTool), color: 'text' };
  return { text: 'thinking', color: 'muted' };
};

const runningOf = (run: LiveRun, now: number): Status => {
  const doing = doingOf(run);
  const quiet = quietFor(run, now);
  const stuck = isStuck(run, now);
  const tail: Tail | undefined =
    quiet >= QUIET_AFTER_MS
      ? {
          text: ` · quiet ${formatElapsed(quiet)}`,
          color: stuck ? 'warning' : 'muted',
        }
      : undefined;
  if (stuck) {
    return {
      glyph: { text: '▲', color: 'warning', spin: false },
      text: doing.text,
      color: 'warning',
      tail,
    };
  }
  return {
    glyph: { text: SPINNER[0], color: 'accent', spin: true },
    ...doing,
    tail,
  };
};

export const statusOf = (run: LiveRun, now: number): Status => {
  const mark = (text: string, color: ThemeColor, label: string): Status => ({
    glyph: { text, color, spin: false },
    text: label,
    color,
  });
  const failed = (text: string, color: ThemeColor, label: string): Status => ({
    ...mark(text, color, label),
    note: reasonOf(run, label),
  });
  if (isActive(run)) {
    if (run.waitingForUser) return mark('⏸', 'warning', 'waiting for you');
    if (run.state === 'starting') return mark('○', 'muted', 'starting');
    return runningOf(run, now);
  }
  switch (run.state) {
    case 'completed':
      return { ...mark('✓', 'success', 'done'), color: 'muted' };
    case 'failed':
      return failed('✗', 'error', 'failed');
    case 'structured_output_failed':
      return failed('✗', 'error', 'bad output');
    case 'timed_out':
      return failed('◔', 'warning', 'timed out');
    case 'cancelled':
      return failed('■', 'muted', 'cancelled');
    default:
      return mark('○', 'muted', run.state);
  }
};

type Key =
  'name' | 'context' | 'model' | 'status' | 'usage' | 'elapsed' | 'note';

interface Column {
  key: Key;
  max: number;
  right?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'name', max: 20 },
  { key: 'context', max: 16 },
  { key: 'model', max: 14 },
  { key: 'status', max: 26 },
  { key: 'usage', max: 9, right: true },
  { key: 'elapsed', max: 8, right: true },
];

// on a narrow terminal these go first, in this order; the context stays
// longest, it tells parallel runs of one agent apart
const DROP: Key[] = ['model', 'usage', 'context'];
// then these shrink, down to MIN_CELL
const SHRINK: Key[] = ['status', 'name'];
const MIN_CELL = 8;
// the note (a failure reason) only takes the room left after the columns
const MIN_NOTE = 8;
const GAP = 2;
// a clipped head keeps the tail only with this much of itself left
const MIN_HEAD = 3;

interface Cell {
  text: string;
  color: ThemeColor;
  bold?: boolean;
  tail?: Tail;
}

interface Row {
  glyph: Glyph;
  cells: Record<Key, Cell>;
}

const rowOf = (run: LiveRun, now: number): Row => {
  const status = statusOf(run, now);
  const active = isActive(run);
  const end = active ? now : endOf(run);
  return {
    glyph: status.glyph,
    cells: {
      name: {
        text: oneLine(run.name),
        color: active ? 'text' : 'muted',
        bold: active,
        tail:
          run.generation > 1
            ? { text: ` g${run.generation}`, color: 'dim' }
            : undefined,
      },
      context: { text: oneLine(run.context ?? ''), color: 'muted' },
      model: { text: shortModel(run.model), color: 'dim' },
      status: { text: status.text, color: status.color, tail: status.tail },
      usage: { text: usageOf(run), color: 'dim' },
      elapsed: {
        text: formatElapsed(end - run.startedAt),
        color: active ? 'muted' : 'dim',
      },
      note: { text: status.note ?? '', color: 'muted' },
    },
  };
};

interface Placed {
  key: Key;
  width: number;
  right: boolean;
}

const widthOf = (cell: Cell): number =>
  visibleWidth(cell.text) + visibleWidth(cell.tail?.text ?? '');

const naturalWidth = (rows: Row[], key: Key): number =>
  Math.max(...rows.map((row) => widthOf(row.cells[key])));

// widths come from the visible rows only; empty columns take no space
const fitColumns = (rows: Row[], budget: number): Placed[] => {
  const width = {} as Record<Key, number>;
  for (const { key, max } of COLUMNS) {
    width[key] = Math.min(max, naturalWidth(rows, key));
  }
  let keys = COLUMNS.map((col) => col.key).filter((key) => width[key] > 0);
  const total = (): number =>
    keys.reduce((sum, key) => sum + width[key], 0) + GAP * (keys.length - 1);
  for (const key of DROP) {
    if (total() <= budget) break;
    keys = keys.filter((k) => k !== key);
  }
  for (const key of SHRINK) {
    const over = total() - budget;
    if (over <= 0) break;
    if (keys.includes(key) && width[key] > MIN_CELL) {
      width[key] = Math.max(MIN_CELL, width[key] - over);
    }
  }
  const placed = COLUMNS.filter((col) => keys.includes(col.key)).map((col) => ({
    key: col.key,
    width: width[col.key],
    right: col.right === true,
  }));
  const note = Math.min(NOTE_MAX, naturalWidth(rows, 'note'));
  const room = Math.min(note, budget - total() - GAP);
  if (room > 0 && room >= Math.min(MIN_NOTE, note)) {
    placed.push({ key: 'note', width: room, right: false });
  }
  return placed;
};

const paintCell = (cell: Cell, width: number, p: Paint): string => {
  const head = (text: string): string => {
    if (!text) return '';
    const colored = p.fg(cell.color, text);
    return cell.bold ? p.bold(colored) : colored;
  };
  const tail = cell.tail;
  if (!tail) return head(clip(cell.text, width));
  const room = width - visibleWidth(tail.text);
  if (visibleWidth(cell.text) <= room) {
    return head(cell.text) + p.fg(tail.color, tail.text);
  }
  if (room >= MIN_HEAD) {
    return head(clip(cell.text, room)) + p.fg(tail.color, tail.text);
  }
  return head(clip(cell.text + tail.text, width));
};

const renderCells = (
  row: Row,
  columns: Placed[],
  budget: number,
  p: Paint,
): string => {
  const parts = columns.map(({ key, width, right }) => {
    const painted = paintCell(row.cells[key], width, p);
    const fill = ' '.repeat(Math.max(0, width - visibleWidth(painted)));
    return right ? fill + painted : painted + fill;
  });
  const line = parts.join(' '.repeat(GAP)).trimEnd();
  return truncateToWidth(line, budget, '…');
};

const headerLine = (rows: Rows, now: number, width: number, p: Paint) => {
  const label = 'agents';
  const waiting = rows.active.filter((run) => run.waitingForUser).length;
  const stuck = rows.active.filter(
    (run) => isSpinning(run) && isStuck(run, now),
  ).length;
  const running = rows.active.length - waiting;
  const counts: string[] = [];
  if (running) counts.push(p.fg('dim', `${running} running`));
  if (waiting) counts.push(p.fg('warning', `${waiting} waiting`));
  if (stuck) counts.push(p.fg('warning', `${stuck} stuck`));
  const tail = counts.join(p.fg('dim', ' · '));
  // the counts sit at the end of the rule, but only with room to spare
  const withTail = width - label.length - visibleWidth(tail) - 2;
  const rule = (n: number): string => p.fg('dim', '─'.repeat(Math.max(0, n)));
  const line =
    tail && withTail >= 3
      ? `${p.fg('dim', label)} ${rule(withTail)} ${tail}`
      : `${p.fg('dim', label)} ${rule(width - label.length - 1)}`;
  return truncateToWidth(line, width, '');
};

export interface ViewLine {
  glyph?: Glyph;
  text: string;
}

// everything but the spinner frame; cached by the widget
export const layoutRunsView = (
  runs: LiveRun[],
  now: number,
  width: number,
  theme?: Paint,
): ViewLine[] => {
  if (width < 1) return [];
  const p = theme ?? plain;
  const rows = selectRows(runs, now);
  const all = [...rows.active, ...rows.recent];
  if (all.length === 0) return [];

  const shown = all.length > MAX_ROWS ? all.slice(0, MAX_ROWS - 1) : all;
  const hidden = all.length - shown.length;
  const cells = shown.map((run) => rowOf(run, now));
  // glyph and one space come before the columns
  const budget = Math.max(0, width - 2);
  const columns = fitColumns(cells, budget);

  const lines: ViewLine[] = [{ text: headerLine(rows, now, width, p) }];
  for (const row of cells) {
    const text = budget > 0 ? renderCells(row, columns, budget, p) : '';
    lines.push({ glyph: row.glyph, text });
  }
  if (hidden > 0) {
    const more = p.fg('dim', `  +${hidden} more`);
    lines.push({ text: truncateToWidth(more, width, '…') });
  }
  return lines;
};

export const composeRunsView = (
  lines: ViewLine[],
  frame: number,
  theme?: Paint,
): string[] => {
  const p = theme ?? plain;
  const spinner = SPINNER[Math.abs(frame) % SPINNER.length];
  return lines.map(({ glyph, text }) => {
    if (!glyph) return text;
    const mark = p.fg(glyph.color, glyph.spin ? spinner : glyph.text);
    return text ? `${mark} ${text}` : mark;
  });
};

export const renderRunsView = (
  runs: LiveRun[],
  now: number,
  width: number,
  theme?: Paint,
  frame = 0,
): string[] =>
  composeRunsView(layoutRunsView(runs, now, width, theme), frame, theme);

export type WidgetFactory = (
  tui: TUI,
  theme: Theme,
) => Component & { dispose?(): void };

export type ViewContext = Pick<ExtensionContext, 'mode' | 'hasUI'> & {
  ui: Pick<ExtensionContext['ui'], 'setWidget'>;
};

export interface MountOptions {
  registry?: LiveRegistry;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RunsView {
  dispose(): void;
}

type TimerKind = 'spin' | 'clock' | 'expiry';

// draws the widget into one ctx until stopped
const startView = (ctx: ViewContext, options: MountOptions): (() => void) => {
  const registry = options.registry ?? liveRuns();
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref());
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let runs: LiveRun[] = [];
  let at = now();
  let frame = 0;
  let version = 0;
  let shown = false;
  let stopped = false;
  let tui: TUI | undefined;
  let timer: unknown;
  let kind: TimerKind | undefined;

  const setWidget = (content: WidgetFactory | undefined): void => {
    try {
      ctx.ui.setWidget(WIDGET_KEY, content, { placement: 'aboveEditor' });
    } catch {
      // a ctx from a session that already shut down
    }
  };

  const component = (theme: Theme): Component => {
    let layout: { key: string; lines: ViewLine[] } | undefined;
    let out: { key: string; lines: string[] } | undefined;
    return {
      render(width: number): string[] {
        const key = `${width}:${version}:${Math.floor(at / CLOCK_MS)}`;
        if (layout?.key !== key) {
          layout = { key, lines: layoutRunsView(runs, at, width, theme) };
        }
        const frameKey = `${key}:${frame}`;
        if (out?.key !== frameKey) {
          out = {
            key: frameKey,
            lines: composeRunsView(layout.lines, frame, theme),
          };
        }
        return out.lines;
      },
      invalidate(): void {
        layout = undefined;
        out = undefined;
      },
    };
  };

  const factory: WidgetFactory = (host, theme) => {
    tui = host;
    return component(theme);
  };

  const stopTimer = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    kind = undefined;
  };

  const arm = (next: TimerKind, ms: number, fn: () => void): void => {
    // keep a running tick, or frequent registry changes would starve it
    if (kind === next && next !== 'expiry') return;
    stopTimer();
    kind = next;
    timer = setTimer(() => {
      timer = undefined;
      kind = undefined;
      fn();
    }, ms);
  };

  const schedule = ({ active, recent }: Rows): void => {
    if (!shown) return stopTimer();
    if (active.some(isSpinning)) return arm('spin', SPIN_MS, tick);
    if (active.length > 0) return arm('clock', CLOCK_MS, tick);
    // idle: wake once when the oldest finished run leaves the window
    const expiry = Math.min(
      ...recent.map((run) => endOf(run) + RECENT_WINDOW_MS),
    );
    return arm('expiry', Math.max(0, expiry - at), refresh);
  };

  function refresh(): void {
    if (stopped) return;
    runs = registry.list();
    at = now();
    version += 1;
    const rows = selectRows(runs, at);
    const visible = rows.active.length + rows.recent.length > 0;
    if (visible && !shown) {
      shown = true;
      setWidget(factory);
    } else if (!visible && shown) {
      shown = false;
      tui = undefined;
      setWidget(undefined);
    } else if (visible) {
      tui?.requestRender();
    }
    schedule(rows);
  }

  function tick(): void {
    if (stopped) return;
    frame = (frame + 1) % SPINNER.length;
    at = now();
    const rows = selectRows(runs, at);
    if (rows.active.length + rows.recent.length === 0) {
      refresh();
      return;
    }
    tui?.requestRender();
    schedule(rows);
  }

  // the registry fires on every streamed delta: refresh at once, then
  // coalesce the rest of a burst into one trailing refresh per CHANGE_MS
  // (a timer of its own, so it never resets the spinner or clock)
  let cooldown: unknown;
  let dirty = false;
  const cool = (): void => {
    cooldown = setTimer(() => {
      cooldown = undefined;
      if (!dirty || stopped) return;
      dirty = false;
      refresh();
      cool();
    }, CHANGE_MS);
  };
  const onChange = (): void => {
    if (stopped) return;
    if (cooldown !== undefined) {
      dirty = true;
      return;
    }
    refresh();
    cool();
  };
  const unsubscribe = registry.subscribe(onChange);
  refresh();

  return () => {
    if (stopped) return;
    stopped = true;
    stopTimer();
    if (cooldown !== undefined) clearTimer(cooldown);
    cooldown = undefined;
    unsubscribe();
    if (shown) setWidget(undefined);
    shown = false;
    tui = undefined;
  };
};

// Shared across every copy of this library in the process, so Opium and
// Spiral mounting for the same session still draw a single widget.
interface Mount {
  start(): () => void;
}

interface Store {
  mounts: Mount[];
  owner?: Mount;
  stop?: () => void;
}

const STORE = Symbol.for('pi-agent-runner:view:v1');

const store = (): Store => {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[STORE] ??= { mounts: [] });
};

export const mountRunsView = (
  ctx: ViewContext,
  options: MountOptions = {},
): RunsView => {
  if (ctx.mode !== 'tui' || !ctx.hasUI) return { dispose: () => undefined };
  const shared = store();
  const mount: Mount = { start: () => startView(ctx, options) };
  shared.mounts.push(mount);
  if (!shared.owner) {
    shared.owner = mount;
    shared.stop = mount.start();
  }
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      shared.mounts = shared.mounts.filter((m) => m !== mount);
      if (shared.owner !== mount) return;
      const stop = shared.stop;
      shared.owner = undefined;
      shared.stop = undefined;
      stop?.();
      // hand the widget to the most recent remaining mount
      const next = shared.mounts.at(-1);
      if (next) {
        shared.owner = next;
        shared.stop = next.start();
      }
    },
  };
};
