// `/agents`: pick a child run from the live registry, then read its recent
// activity, cancel it, or take its transcript over in a Pi session of your
// own. Pi widgets cannot take input, so all of it lives behind a command.
//
// One registration across copies. Pi keeps commands per extension and does
// not dedupe: two extensions registering `agents` end up as `agents:1` and
// `agents:2` and neither answers to `/agents` (extensions/runner.js,
// resolveRegisteredCommands). Opium and Spiral each bundle a copy of this
// package, so the copies claim `command:agents` on globalThis and only the
// first registers. On `/reload` (and session replacement) Pi emits
// `session_shutdown` to the old extensions, invalidates them, then loads
// everything again (agent-session.js, reload); globalThis survives, so the
// owner releases its claims on `session_shutdown` and the next load claims
// them anew. An owner whose extension fails to load after claiming keeps the
// claim until the process ends.
import * as fs from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type KeyId,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  liveRuns,
  runActivity,
  runControl,
  type ActivityEntry,
  type LiveRun,
} from './live.ts';
import {
  endOf,
  formatElapsed,
  isActive,
  oneLine,
  statusOf,
  type Paint,
} from './view.ts';

export interface AgentsCommandOptions {
  /** Also open the picker on this key; none by default. */
  shortcut?: KeyId;
}

type Host = Pick<ExtensionAPI, 'registerCommand' | 'registerShortcut' | 'on'>;
type Ctx = Pick<ExtensionContext, 'mode' | 'hasUI' | 'ui'>;

export const COMMAND_NAME = 'agents';
/** Redraws of an open activity view are coalesced to this interval. */
export const REFRESH_MS = 250;
const NOTE_MAX = 40;
const OLDER_COPY = ' (unavailable: run tracked by an older pi-agent-runner)';

const CLAIMS = Symbol.for('pi-agent-runner:agents-command:v1');

const claims = (): Set<string> => {
  const holder = globalThis as Record<symbol, unknown>;
  return (holder[CLAIMS] ??= new Set<string>()) as Set<string>;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

const clockOf = (at: number): string => {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(pad2).join(':');
};

// active runs first, then by recency: newest start, newest end
const recency = (run: LiveRun): number =>
  isActive(run) ? run.startedAt : endOf(run);

export const orderRuns = (runs: LiveRun[]): LiveRun[] =>
  [...runs].sort(
    (a, b) =>
      Number(isActive(b)) - Number(isActive(a)) ||
      recency(b) - recency(a) ||
      a.id.localeCompare(b.id),
  );

/** `⠋ worker g2 · ralph US-002 · running: bash · quiet 0:45 · 1:23` */
export const describeRun = (run: LiveRun, now: number): string => {
  const status = statusOf(run, now);
  const running = run.state === 'running' && !run.waitingForUser;
  const note = status.note ? `: ${status.note.slice(0, NOTE_MAX)}` : '';
  const doing = `${running ? 'running: ' : ''}${status.text}`;
  const state = `${doing}${status.tail?.text ?? ''}${note}`;
  const end = isActive(run) ? now : endOf(run);
  const generation = run.generation > 1 ? ` g${run.generation}` : '';
  const cells = [
    `${oneLine(run.name)}${generation}`,
    oneLine(run.context ?? ''),
    state,
    formatElapsed(end - run.startedAt),
  ];
  return `${status.glyph.text} ${cells.filter(Boolean).join(' · ')}`;
};

const quote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export type Takeover =
  { ok: true; command: string } | { ok: false; reason: string };

// Pi's own `--fork` writes a new session file (new id, `parentSession` link,
// session-manager.js forkFrom) and leaves the original alone, which a live
// startAgent handle may still be appending to; a plain copy would carry the
// same session id as the original.
export const takeoverOf = (run: LiveRun): Takeover => {
  if (run.state === 'starting' || run.state === 'running') {
    return { ok: false, reason: 'the agent is still running' };
  }
  if (!run.transcriptPath || !fs.existsSync(run.transcriptPath)) {
    return { ok: false, reason: 'the agent has no transcript file yet' };
  }
  return { ok: true, command: `pi --fork ${quote(run.transcriptPath)}` };
};

const KINDS: Record<
  ActivityEntry['kind'],
  { mark: string; color: ThemeColor }
> = {
  tool: { mark: '▸', color: 'text' },
  error: { mark: '✗', color: 'error' },
  text: { mark: '“', color: 'muted' },
  thought: { mark: '~', color: 'muted' },
  generation: { mark: '●', color: 'dim' },
};

// clock, mark and a space each side
const INDENT = 11;
// the title, two rules and the key hint
const CHROME = 4;

const entryLines = (entry: ActivityEntry, width: number, p: Paint) => {
  const { mark, color } = KINDS[entry.kind];
  const room = Math.max(1, width - INDENT);
  return wrapTextWithAnsi(entry.text, room).map((line, index) =>
    index === 0
      ? `${p.fg('dim', clockOf(entry.at))} ${p.fg(color, `${mark} ${line}`)}`
      : `${' '.repeat(INDENT)}${p.fg(color, line)}`,
  );
};

export interface ActivityViewSpec {
  /** Undefined once the run has left the registry. */
  run?: LiveRun;
  /** Undefined for a run tracked by an older copy. */
  entries?: ActivityEntry[];
  now: number;
  width: number;
  /** Rows for the entries; the frame comes on top. */
  rows: number;
  /** Lines scrolled up from the newest. */
  offset: number;
  /** Line count of the previous render: a scrolled view stays put. */
  previousTotal?: number;
  paint: Paint;
}

export interface ActivityView {
  lines: string[];
  offset: number;
  /** Most the view can be scrolled up. */
  max: number;
  total: number;
}

export const renderActivity = (spec: ActivityViewSpec): ActivityView => {
  const { run, entries, width, rows, paint: p } = spec;
  let body: string[];
  if (entries === undefined) {
    body = [p.fg('muted', 'No activity: tracked by an older pi-agent-runner')];
  } else if (entries.length === 0) {
    body = [p.fg('muted', 'No activity yet')];
  } else {
    body = entries.flatMap((entry) => entryLines(entry, width, p));
  }
  const max = Math.max(0, body.length - rows);
  const grown =
    spec.offset > 0 && spec.previousTotal !== undefined
      ? Math.max(0, body.length - spec.previousTotal)
      : 0;
  const offset = Math.min(max, Math.max(0, spec.offset + grown));
  const end = body.length - offset;
  const notes = [
    max - offset > 0 ? `${max - offset} earlier` : '',
    offset > 0 ? `${offset} newer` : '',
  ].filter(Boolean);
  const hint = [...notes, '↑↓/PgUp/PgDn scroll', 'Esc/q close'];
  const rule = p.fg('dim', '─'.repeat(width));
  const title = run ? describeRun(run, spec.now) : 'agent no longer listed';
  const lines = [
    p.bold(title),
    rule,
    ...body.slice(Math.max(0, end - rows), end),
    rule,
    p.fg('dim', hint.join(' · ')),
  ].map((line) => truncateToWidth(line, width, '…'));
  return { lines, offset, max, total: body.length };
};

const bodyRows = (tui: TUI): number =>
  Math.max(3, Math.floor(tui.terminal.rows * 0.8) - CHROME);

const activityComponent = (
  id: string,
  tui: TUI,
  theme: Theme,
  done: (result: undefined) => void,
): Component & { dispose(): void } => {
  const registry = liveRuns();
  let offset = 0;
  let last: ActivityView | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // a burst of registry changes becomes one redraw
  const unsubscribe = registry.subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      tui.requestRender();
    }, REFRESH_MS);
    timer.unref();
  });
  const dispose = () => {
    unsubscribe();
    clearTimeout(timer);
    timer = undefined;
  };
  const scroll = (delta: number) => {
    offset = Math.min(last?.max ?? 0, Math.max(0, offset + delta));
    tui.requestRender();
  };
  return {
    render(width) {
      last = renderActivity({
        run: registry.list().find((run) => run.id === id),
        entries: runActivity(id),
        now: Date.now(),
        width,
        rows: bodyRows(tui),
        offset,
        previousTotal: last?.total,
        paint: theme,
      });
      offset = last.offset;
      return last.lines;
    },
    handleInput(data) {
      const page = Math.max(1, bodyRows(tui) - 1);
      if (matchesKey(data, Key.escape) || matchesKey(data, 'q')) {
        dispose();
        done(undefined);
      } else if (matchesKey(data, Key.up)) {
        scroll(1);
      } else if (matchesKey(data, Key.down)) {
        scroll(-1);
      } else if (matchesKey(data, Key.pageUp)) {
        scroll(page);
      } else if (matchesKey(data, Key.pageDown)) {
        scroll(-page);
      }
    },
    invalidate() {},
    dispose,
  };
};

type ActionId = 'activity' | 'cancel' | 'takeover';

interface Action {
  id: ActionId;
  label: string;
  /** False for a run an older copy tracked: it left no buffer or control. */
  available: boolean;
}

// Only what applies to the run's state; `available` is about the copy.
const actionsFor = (run: LiveRun): Action[] => {
  const actions: Action[] = [
    {
      id: 'activity',
      label: 'Recent activity',
      available: runActivity(run.id) !== undefined,
    },
  ];
  if (run.state === 'starting' || run.state === 'running') {
    actions.push({
      id: 'cancel',
      label: 'Cancel run',
      available: runControl(run.id) !== undefined,
    });
  } else if (takeoverOf(run).ok) {
    actions.push({
      id: 'takeover',
      label: 'Take over in a new Pi session',
      available: true,
    });
  }
  return actions;
};

const titleOf = (run: LiveRun): string =>
  [oneLine(run.name), oneLine(run.context ?? '')].filter(Boolean).join(' · ');

const showActivity = (ctx: Ctx, run: LiveRun): Promise<void> =>
  ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) =>
      activityComponent(run.id, tui, theme, done),
    { overlay: true, overlayOptions: { width: '90%', maxHeight: '85%' } },
  );

const cancelRun = async (ctx: Ctx, run: LiveRun): Promise<void> => {
  const title = `Cancel ${titleOf(run)}?`;
  const confirmed = await ctx.ui.confirm(
    title,
    'The current generation is aborted.',
  );
  if (!confirmed) return;
  // the dialog was open for a while
  const now = liveRuns()
    .list()
    .find((r) => r.id === run.id);
  const control = runControl(run.id);
  if (!control || (now?.state !== 'starting' && now?.state !== 'running')) {
    ctx.ui.notify(`${titleOf(run)} has already finished`, 'info');
    return;
  }
  await control.cancel();
  ctx.ui.notify(`Cancelled ${titleOf(run)}`, 'info');
};

const takeOver = (ctx: Ctx, run: LiveRun): void => {
  const result = takeoverOf(run);
  if (!result.ok) {
    ctx.ui.notify(`Cannot take over: ${result.reason}`, 'warning');
    return;
  }
  ctx.ui.notify(
    [
      'Continue in a new Pi session (a fork; the original is left alone):',
      `  ${result.command}`,
      'Not restored: the child extensions, tools and frozen system prompt.',
    ].join('\n'),
    'info',
  );
};

const act = async (ctx: Ctx, run: LiveRun): Promise<void> => {
  const labels = new Map<string, Action>();
  for (const action of actionsFor(run)) {
    labels.set(
      action.available ? action.label : action.label + OLDER_COPY,
      action,
    );
  }
  const picked = await ctx.ui.select(titleOf(run), [...labels.keys()]);
  const action = picked === undefined ? undefined : labels.get(picked);
  if (!action) return;
  if (!action.available) {
    ctx.ui.notify(`${action.label}:${OLDER_COPY.slice(1)}`, 'warning');
  } else if (action.id === 'activity') {
    await showActivity(ctx, run);
  } else if (action.id === 'cancel') {
    await cancelRun(ctx, run);
  } else {
    takeOver(ctx, run);
  }
};

export const summarize = (runs: LiveRun[], now: number): string => {
  const noun = runs.length === 1 ? 'child agent' : 'child agents';
  return [
    `${runs.length} ${noun}:`,
    ...runs.map((r) => describeRun(r, now)),
  ].join('\n');
};

/** Runs the picker: the command's and the shortcut's body. */
export const pickAgent = async (ctx: Ctx): Promise<void> => {
  const now = Date.now();
  const runs = orderRuns(liveRuns().list());
  if (runs.length === 0) {
    ctx.ui.notify('No child agents', 'info');
    return;
  }
  if (ctx.mode !== 'tui' || !ctx.hasUI) {
    ctx.ui.notify(summarize(runs, now), 'info');
    return;
  }
  const lines = new Map<string, LiveRun>();
  for (const run of runs) {
    const line = describeRun(run, now);
    lines.set(lines.has(line) ? `${line} (${run.id.slice(0, 8)})` : line, run);
  }
  const picked = await ctx.ui.select('Child agents', [...lines.keys()]);
  const run = picked === undefined ? undefined : lines.get(picked);
  if (run) await act(ctx, run);
};

export const registerAgentsCommand = (
  pi: Host,
  options: AgentsCommandOptions = {},
): void => {
  const taken = claims();
  const mine: string[] = [];
  const claim = (key: string): boolean => {
    if (taken.has(key)) return false;
    taken.add(key);
    mine.push(key);
    return true;
  };
  const release = () => {
    for (const key of mine.splice(0)) taken.delete(key);
  };
  try {
    if (claim(`command:${COMMAND_NAME}`)) {
      pi.registerCommand(COMMAND_NAME, {
        description: 'Child agents: recent activity, cancel, take over',
        handler: (_args, ctx) => pickAgent(ctx),
      });
    }
    const { shortcut } = options;
    if (shortcut && claim(`shortcut:${shortcut}`)) {
      pi.registerShortcut(shortcut, {
        description: 'Child agents',
        handler: (ctx) => pickAgent(ctx),
      });
    }
  } catch (error) {
    release();
    throw error;
  }
  if (mine.length > 0) pi.on('session_shutdown', release);
};
