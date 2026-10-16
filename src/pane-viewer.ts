// Read-only live feed of one child run, for a terminal multiplexer pane:
// `node pane-viewer.js <feed file> [lingerMs]`. It tails the feed the
// runner writes, prints a header, one compact line per event and a footer
// with state, turn, tokens and the clock. It never reads the keyboard and
// never writes to the session. After the run's end record it shows the
// final status for `lingerMs`, then exits, which closes the pane.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import { entryLines } from './agents-command.ts';
import { DEFAULT_LINGER_MS, paneTitle, type FeedRecord } from './pane-feed.ts';
import {
  SPINNER,
  formatCost,
  formatElapsed,
  formatTokens,
  oneLine,
  shortModel,
  type Paint,
} from './view.ts';

export const POLL_MS = 100;
// the feed file is created before the pane; this long without it is a
// pane that outlived its run
const FEED_WAIT_MS = 5000;
const HEADER_ROWS = 2;
// printed lines kept for a repaint after a resize
const MAX_HISTORY = 500;
const FOOTER_ROWS = 1;

const CODES: Partial<Record<ThemeColor, string>> = {
  dim: '2',
  muted: '90',
  error: '31',
  warning: '33',
  success: '32',
  accent: '36',
};

export const ansiPaint: Paint = {
  fg: (color, text) => {
    const code = CODES[color];
    return code ? `\x1b[${code}m${text}\x1b[0m` : text;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };

export interface ViewerOutput {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
  on?(event: 'resize', listener: () => void): unknown;
}

export interface ViewerOptions {
  feed: string;
  out?: ViewerOutput;
  lingerMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Is the Pi process that writes the feed still there? */
  alive?: (pid: number) => boolean;
}

type Start = Extract<FeedRecord, { t: 'start' }>;
type State = Extract<FeedRecord, { t: 'state' }>;
type End = Extract<FeedRecord, { t: 'end' }>;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const usageText = (
  tokens: { input: number; output: number },
  cost: number,
): string => {
  const money = formatCost(cost);
  if (money) return money;
  const count = formatTokens(tokens.input + tokens.output);
  return count && `${count} tok`;
};

interface Ending {
  mark: string;
  color: ThemeColor;
}

const endingOf = (status: string): Ending => {
  switch (status) {
    case 'completed':
      return { mark: '✓', color: 'success' };
    case 'failed':
    case 'structured_output_failed':
      return { mark: '✗', color: 'error' };
    case 'timed_out':
      return { mark: '◔', color: 'warning' };
    case 'cancelled':
      return { mark: '■', color: 'muted' };
    default:
      return { mark: '●', color: 'muted' };
  }
};

const endLabel = (status: string): string => status.replace(/_/g, ' ');

export const headerLines = (start: Start, width: number, p: Paint) => {
  const gen = start.generation > 1 ? ` g${start.generation}` : '';
  const parts = [
    p.bold(oneLine(start.name) + gen),
    ...[start.context, shortModel(start.model)]
      .map((part) => oneLine(part ?? ''))
      .filter(Boolean)
      .map((part) => p.fg('muted', part)),
  ];
  const title = parts.join(p.fg('dim', ' · '));
  return [
    truncateToWidth(title, width, '…'),
    p.fg('dim', '─'.repeat(Math.max(0, width))),
  ];
};

export const endLines = (end: End, width: number, p: Paint): string[] => {
  const { mark, color } = endingOf(end.status);
  const usage = usageText(end.tokens, end.cost);
  const facts = [
    endLabel(end.status),
    formatElapsed(end.at - end.startedAt),
    end.turns > 0 ? `${end.turns} turns` : '',
    usage,
  ].filter(Boolean);
  const lines = [p.fg(color, `${mark} ${facts.join(' · ')}`)];
  const reason = oneLine(end.error ?? '');
  if (reason) lines.push(p.fg(color, `  ${reason}`));
  return lines.map((line) => truncateToWidth(line, width, '…'));
};

export const footerLine = (
  start: Start,
  state: State | undefined,
  end: End | undefined,
  now: number,
  frame: number,
  width: number,
  p: Paint,
): string => {
  if (end) {
    const { mark, color } = endingOf(end.status);
    const took = formatElapsed(end.at - end.startedAt);
    const text = `${mark} ${endLabel(end.status)} · ${took}`;
    return truncateToWidth(p.fg(color, text), width, '…');
  }
  const running = !state || state.state === 'running';
  let label: string = state?.state ?? 'starting';
  if (state?.waiting) label = 'waiting for you';
  else if (state?.wrappingUp) label = 'wrapping up';
  const glyph =
    running && !state?.waiting ? SPINNER[frame % SPINNER.length] : '⏸';
  const facts = [
    label,
    state && state.turns > 0 ? `turn ${state.turns}` : '',
    state && state.toolCalls > 0 ? `${state.toolCalls} tools` : '',
    state ? usageText(state.tokens, state.cost) : '',
    formatElapsed(now - start.startedAt),
  ].filter(Boolean);
  const color: ThemeColor =
    state?.waiting || state?.wrappingUp ? 'warning' : 'accent';
  return truncateToWidth(
    p.fg(color, `${glyph} ${facts.join(' · ')}`),
    width,
    '…',
  );
};

/**
 * Follows the feed until the run ends (plus the linger), the Pi process
 * that writes it is gone, or the feed file is removed. Resolves then.
 */
export const runViewer = (options: ViewerOptions): Promise<void> => {
  const out = options.out ?? process.stdout;
  const tty = out.isTTY === true;
  const p = tty ? ansiPaint : plain;
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  const now = options.now ?? Date.now;
  const alive = options.alive ?? processAlive;
  const width = (): number => Math.max(20, out.columns ?? 80);
  const rows = (): number => Math.max(6, out.rows ?? 24);
  const bottom = (): number => rows() - FOOTER_ROWS;

  let start: Start | undefined;
  let state: State | undefined;
  let end: End | undefined;
  let frame = 0;
  let offset = 0;
  let pending = '';
  let seen = false;
  let waited = 0;
  let finishing = false;
  const poll = options.pollMs ?? POLL_MS;
  const write = (text: string): void => {
    out.write(text);
  };

  const footer = (): void => {
    if (!tty || !start) return;
    const line = footerLine(start, state, end, now(), frame, width(), p);
    write(`\x1b7\x1b[${rows()};1H\x1b[2K${line}\x1b8`);
  };

  // What was printed, as functions of the width: a resize wraps it anew.
  // The pane shows only the tail that fits, so the buffer is bounded.
  const history: Array<(width: number) => string[]> = [];
  const remember = (render: (width: number) => string[]): void => {
    history.push(render);
    if (history.length > MAX_HISTORY) history.shift();
  };

  // header, scroll region, body tail (bottom-aligned, as live output
  // leaves it) and footer, all with absolute positions
  const paint = (): void => {
    if (!tty || !start) return;
    const w = width();
    const room = Math.max(0, bottom() - HEADER_ROWS);
    const body = history.flatMap((render) => render(w)).slice(-room);
    const first = bottom() - body.length + 1;
    const at = (row: number, text: string): string =>
      `\x1b[${row};1H\x1b[2K${text}`;
    const head = headerLines(start, w, p);
    const header = head.map((l, i) => at(i + 1, l)).join('');
    const rowsOut = body.map((l, i) => at(first + i, l)).join('');
    const region = `\x1b[${HEADER_ROWS + 1};${bottom()}r`;
    write(
      ['\x1b[?25l\x1b[r\x1b[2J', header, region, rowsOut]
        .concat(`\x1b[${bottom()};1H`)
        .join(''),
    );
    footer();
  };

  // lines appear at the bottom of the scroll region and push the rest up
  const emit = (render: (width: number) => string[]): void => {
    const lines = render(width());
    if (lines.length === 0) return;
    remember(render);
    if (!tty) {
      write(`${lines.join('\n')}\n`);
      return;
    }
    write(`\x1b[${bottom()};1H${lines.map((line) => `\n${line}`).join('')}`);
    footer();
  };

  // herdr and tmux show the terminal title as the pane's name
  const setTitle = (record: Start): void => {
    if (!tty) return;
    const title = paneTitle(record);
    if (title) write(`\x1b]0;${title}\x07`);
  };

  const handle = (record: FeedRecord): void => {
    if (record.t === 'start') {
      start = record;
      if (tty) paint();
      else write(`${headerLines(record, width(), p).join('\n')}\n`);
      setTitle(record);
    } else if (record.t === 'entry') {
      emit((w) => entryLines(record, w, p));
    } else if (record.t === 'state') {
      state = record;
      footer();
    } else if (record.t === 'end') {
      end = record;
      emit((w) => endLines(record, w, p));
    }
  };

  const consume = (chunk: string): void => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as FeedRecord);
      } catch {
        // a torn or foreign line
      }
    }
  };

  // false once the file is gone
  const readMore = (): boolean => {
    let fd: number;
    try {
      fd = fs.openSync(options.feed, 'r');
    } catch {
      return !seen;
    }
    try {
      seen = true;
      const size = fs.fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const buffer = Buffer.alloc(size - offset);
        const got = fs.readSync(fd, buffer, 0, buffer.length, offset);
        offset += got;
        consume(buffer.subarray(0, got).toString('utf8'));
      }
    } finally {
      fs.closeSync(fd);
    }
    return true;
  };

  return new Promise<void>((resolve) => {
    const timers: {
      poll?: ReturnType<typeof setInterval>;
      end?: ReturnType<typeof setTimeout>;
    } = {};
    let lastFooter = 0;
    let closed = false;

    const finish = (): void => {
      clearInterval(timers.poll);
      clearTimeout(timers.end);
      closed = true;
      if (tty) write(`\x1b[r\x1b[${rows()};1H\x1b[2K\x1b[?25h\n`);
      resolve();
    };

    // The run is over or cannot go on: show it, wait, leave.
    const wind = (lines: string[]): void => {
      if (finishing) return;
      finishing = true;
      emit(() => lines);
      timers.end = setTimeout(finish, lingerMs);
    };

    const tick = (): void => {
      if (finishing) return;
      let present: boolean;
      try {
        present = readMore();
      } catch {
        present = false;
      }
      if (end || !present) {
        wind([]);
      } else if (!seen || !start) {
        waited += poll;
        if (waited >= FEED_WAIT_MS) finish();
      } else if (!alive(start.pid)) {
        wind([p.fg('warning', '✗ the agent process exited')]);
      } else if (now() - lastFooter >= 1000) {
        lastFooter = now();
        frame += 1;
        footer();
      }
    };

    // also while lingering: the final status must survive a resize
    out.on?.('resize', () => {
      if (tty && !closed) paint();
    });
    timers.poll = setInterval(tick, poll);
    tick();
  });
};

// Pane processes inherit the terminal: typed keys would echo into the feed.
const muteEcho = (on: boolean): void => {
  if (!process.stdin.isTTY) return;
  spawnSync('stty', [on ? 'echo' : '-echo'], {
    stdio: ['inherit', 'ignore', 'ignore'],
  });
};

const isMain = (): boolean => {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return (
      fs.realpathSync(script) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  const [feed, linger] = process.argv.slice(2);
  if (!feed) {
    process.stderr.write('usage: pane-viewer <feed file> [lingerMs]\n');
    process.exit(2);
  }
  const lingerMs = Number(linger);
  muteEcho(false);
  process.on('exit', () => muteEcho(true));
  runViewer({
    feed,
    lingerMs: Number.isFinite(lingerMs) && linger ? lingerMs : undefined,
  }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
