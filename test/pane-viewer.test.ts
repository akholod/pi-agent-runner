import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { FeedRecord } from '../src/pane-feed.ts';
import {
  endLines,
  footerLine,
  headerLines,
  runViewer,
  type ViewerOutput,
} from '../src/pane-viewer.ts';

let dir: string;
let feed: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-test-'));
  feed = path.join(dir, 'run.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Start = Extract<FeedRecord, { t: 'start' }>;

const START: Start = {
  t: 'start',
  at: 1000,
  pid: process.pid,
  id: 's-1',
  name: 'explorer',
  context: 'ralph US-002',
  model: 'anthropic/claude-opus-5-5-20260101',
  generation: 1,
  startedAt: 1000,
};

const append = (...records: FeedRecord[]): void => {
  fs.appendFileSync(
    feed,
    records.map((r) => `${JSON.stringify(r)}\n`).join(''),
  );
};

const capture = (over: Partial<ViewerOutput> = {}) => {
  const chunks: string[] = [];
  const out: ViewerOutput = {
    write: (text) => chunks.push(text),
    columns: 60,
    rows: 12,
    ...over,
  };
  return { out, text: () => chunks.join(''), chunks };
};

const END: FeedRecord = {
  t: 'end',
  at: 63_000,
  status: 'completed',
  turns: 4,
  tokens: { input: 12_000, output: 300 },
  cost: 0,
  startedAt: 1000,
};

test('renders the feed, then exits after the linger', async () => {
  append(
    START,
    { t: 'entry', at: 1, kind: 'tool', text: 'read src/a.ts' },
    { t: 'entry', at: 2, kind: 'thought', text: 'Planning the fix' },
    { t: 'entry', at: 3, kind: 'error', text: 'bash: exit 2' },
    { t: 'entry', at: 4, kind: 'text', text: 'All done' },
    END,
  );
  const cap = capture();
  const began = Date.now();
  await runViewer({ feed, out: cap.out, lingerMs: 60, pollMs: 5 });
  const took = Date.now() - began;
  assert.ok(took >= 55, `exited after ${took}ms, before the linger`);
  assert.ok(took < 2000);
  const lines = cap.text().split('\n');
  assert.equal(lines[0], 'explorer · ralph US-002 · opus-5-5');
  assert.match(lines[1], /^─+$/);
  assert.ok(lines.some((l) => /▸ read src\/a\.ts$/.test(l)));
  assert.ok(lines.some((l) => /~ Planning the fix$/.test(l)));
  assert.ok(lines.some((l) => /✗ bash: exit 2$/.test(l)));
  assert.ok(lines.some((l) => /“ All done$/.test(l)));
  assert.ok(lines.includes('✓ completed · 1:02 · 4 turns · 12.3k tok'));
  assert.ok(!cap.text().includes('\x1b'));
});

test('tails a feed that grows, including a line cut in half', async () => {
  fs.writeFileSync(feed, '');
  const cap = capture();
  const done = runViewer({ feed, out: cap.out, lingerMs: 10, pollMs: 5 });
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  await wait(20);
  append(START);
  const entry: FeedRecord = {
    t: 'entry',
    at: 1,
    kind: 'tool',
    text: 'bash ls',
  };
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(feed, line.slice(0, 12));
  await wait(30);
  assert.doesNotMatch(cap.text(), /bash ls/);
  fs.appendFileSync(feed, line.slice(12));
  await wait(30);
  assert.match(cap.text(), /▸ bash ls/);
  append(END);
  await done;
});

test('shows the reason of a failed run', async () => {
  append(START, {
    ...END,
    status: 'timed_out',
    error: 'timed out after 600000ms',
  } as FeedRecord);
  const cap = capture();
  await runViewer({ feed, out: cap.out, lingerMs: 5, pollMs: 5 });
  assert.match(cap.text(), /◔ timed out · 1:02/);
  assert.match(cap.text(), /timed out after 600000ms/);
});

test('a dead Pi process ends the viewer without an end record', async () => {
  append(START);
  const cap = capture();
  await runViewer({
    feed,
    out: cap.out,
    lingerMs: 5,
    pollMs: 5,
    alive: () => false,
  });
  assert.match(cap.text(), /the agent process exited/);
});

test('a removed feed ends the viewer', async () => {
  append(START);
  const cap = capture();
  const done = runViewer({ feed, out: cap.out, lingerMs: 5, pollMs: 5 });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 30);
  });
  fs.rmSync(feed);
  await done;
  assert.match(cap.text(), /explorer/);
});

test('on a terminal it pins a footer and scrolls the rest', async () => {
  const state: FeedRecord = {
    t: 'state',
    at: 2000,
    state: 'running',
    turns: 3,
    toolCalls: 5,
    tokens: { input: 1200, output: 300 },
    cost: 0,
    waiting: false,
    wrappingUp: false,
  };
  append(
    START,
    state,
    { t: 'entry', at: 5, kind: 'tool', text: 'grep x' },
    END,
  );
  const cap = capture({ isTTY: true, rows: 10, columns: 50 });
  await runViewer({
    feed,
    out: cap.out,
    lingerMs: 5,
    pollMs: 5,
    now: () => 6000,
  });
  const text = cap.text();
  // header rows pinned, scroll region between them and the footer row
  assert.ok(text.includes('\x1b[3;9r'));
  const footers = text.split('\x1b[10;1H\x1b[2K').slice(1);
  assert.ok(
    footers.some((f) =>
      /running · turn 3 · 5 tools · 1\.5k tok · 0:05/.test(f),
    ),
  );
  assert.ok(footers.some((f) => /completed · 1:02/.test(f)));
  assert.match(text, /grep x/);
  // the scroll region and cursor are given back
  assert.ok(text.includes('\x1b[r'));
  assert.ok(text.includes('\x1b[?25h'));
});

test('footerLine: waiting, wrapping up and the clock', () => {
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const state = (over: object): Extract<FeedRecord, { t: 'state' }> => ({
    t: 'state',
    at: 0,
    state: 'running',
    turns: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0 },
    cost: 0,
    waiting: false,
    wrappingUp: false,
    ...over,
  });
  const line = (s: ReturnType<typeof state> | undefined, now = 66_000) =>
    footerLine(START, s, undefined, now, 0, 80, plain);
  assert.equal(line(undefined), '⠋ starting · 1:05');
  assert.equal(line(state({ waiting: true })), '⏸ waiting for you · 1:05');
  assert.equal(line(state({ wrappingUp: true })), '⠋ wrapping up · 1:05');
  assert.equal(
    line(state({ turns: 2, cost: 0.42 })),
    '⠋ running · turn 2 · $0.42 · 1:05',
  );
});

test('headerLines and endLines are plain text without a paint', () => {
  const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const [title] = headerLines(
    { ...START, generation: 2, context: undefined },
    60,
    plain,
  );
  assert.equal(title, 'explorer g2 · opus-5-5');
  assert.deepEqual(
    endLines(
      { ...END, status: 'failed', error: 'boom\nbang' } as never,
      60,
      plain,
    ),
    ['✗ failed · 1:02 · 4 turns · 12.3k tok', '  boom bang'],
  );
});

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const SEQUENCES = new RegExp(
  `${ESC}\\](?:[^${BEL}]*)${BEL}|${ESC}\\[([?0-9;]*)([A-Za-z])|${ESC}([78])` +
    `|\\n|[^${ESC}\\n]+`,
  'g',
);

// A tiny terminal: just the sequences the viewer uses.
const terminal = (columns: number, rows: number) => {
  const term = {
    columns,
    rows,
    isTTY: true,
    title: '',
    screen: [] as string[],
    top: 1,
    bottom: rows,
    row: 1,
    saved: 1,
    listeners: [] as Array<() => void>,
    on(_event: 'resize', listener: () => void) {
      term.listeners.push(listener);
    },
    resize(c: number, r: number) {
      term.columns = c;
      term.rows = r;
      // a real terminal keeps its content but re-wraps it badly; clear it
      term.screen = Array.from({ length: r }, () => '');
      term.top = 1;
      term.bottom = r;
      for (const listener of term.listeners) listener();
    },
    lines: () => term.screen.map((l) => l.replace(SGR, '')),
    write(text: string) {
      const re = SEQUENCES;
      for (const m of text.matchAll(re)) {
        const [token, args, cmd, esc] = m;
        if (token.startsWith('\x1b]')) {
          term.title = token.slice(4, -1);
        } else if (cmd === 'H') {
          term.row = Number(args.split(';')[0] || 1);
        } else if (cmd === 'K') {
          term.screen[term.row - 1] = '';
        } else if (cmd === 'J') {
          term.screen = Array.from({ length: term.rows }, () => '');
        } else if (cmd === 'r') {
          const [t, b] = args ? args.split(';').map(Number) : [1, term.rows];
          term.top = t;
          term.bottom = b;
        } else if (esc === '7') {
          term.saved = term.row;
        } else if (esc === '8') {
          term.row = term.saved;
        } else if (token === '\n') {
          if (term.row === term.bottom) {
            term.screen.splice(term.top - 1, 1);
            term.screen.splice(term.bottom - 1, 0, '');
          } else {
            term.row += 1;
          }
        } else if (!cmd && !esc) {
          term.screen[term.row - 1] = (term.screen[term.row - 1] ?? '') + token;
        }
      }
    },
  };
  term.screen = Array.from({ length: rows }, () => '');
  return term;
};

const nextTick = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test('a resize repaints the header, the body tail and the footer', async () => {
  const term = terminal(60, 12);
  const tools: FeedRecord[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(
    (n) => ({ t: 'entry', at: n, kind: 'tool', text: `bash step ${n}` }),
  );
  append(START, ...tools);
  const done = runViewer({
    feed,
    out: term,
    lingerMs: 400,
    pollMs: 5,
    now: () => 6000,
  });
  await nextTick(40);
  assert.equal(term.title, 'explorer · ralph US-002');
  assert.match(term.lines()[0], /^explorer · ralph US-002 · opus-5-5/);
  assert.match(term.lines()[10], /bash step 12$/);

  // pane gets shorter and narrower, as when another pane is split off
  term.resize(40, 8);
  let lines = term.lines();
  assert.match(lines[0], /^explorer · ralph US-002/);
  assert.match(lines[1], /^─+$/);
  assert.match(lines[6], /bash step 12$/);
  assert.match(lines[5], /bash step 11$/);
  assert.match(lines[7], /^\S starting · 0:05/);

  // new events still scroll under the header after the repaint
  append({ t: 'entry', at: 13, kind: 'text', text: 'after resize' });
  await nextTick(40);
  lines = term.lines();
  assert.match(lines[6], /after resize$/);
  assert.match(lines[5], /bash step 12$/);

  // a resize after the end keeps the final status on screen
  append(END);
  await nextTick(40);
  term.resize(50, 10);
  lines = term.lines();
  assert.match(lines[0], /^explorer/);
  assert.ok(lines.some((l) => /✓ completed · 1:02 · 4 turns/.test(l)));
  assert.match(lines[9], /^✓ completed · 1:02/);
  assert.ok(lines.filter((l) => l.startsWith('explorer')).length === 1);
  await done;
});

test('a long entry is wrapped anew to the new width', async () => {
  const term = terminal(60, 12);
  append(START, {
    t: 'entry',
    at: 1,
    kind: 'text',
    text: 'one two three four five six seven eight nine ten eleven twelve',
  });
  const done = runViewer({ feed, out: term, lingerMs: 100, pollMs: 5 });
  await nextTick(40);
  const wide = term.lines().filter((l) => /one two|twelve/.test(l));
  assert.equal(wide.length, 2);
  term.resize(30, 12);
  const narrow = term.lines().filter((l) => /one|four|ten|twelve|six/.test(l));
  assert.ok(narrow.length >= 3);
  assert.ok(narrow.every((l) => l.length <= 30));
  append(END);
  await done;
});
