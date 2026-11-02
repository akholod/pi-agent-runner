// The viewer as the multiplexer pane runs it: a separate node process with no
// runner registry and no binding. It renders with the host TUI module whose
// URL it gets in argv, and never with a copy of its own.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tuiModuleUrlFrom } from '../src/host-paths.ts';
import type { FeedRecord } from '../src/pane-feed.ts';

const VIEWER = fileURLToPath(new URL('../src/pane-viewer.ts', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-viewer-proc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const feedWith = (records: FeedRecord[]) => {
  const file = path.join(root, `feed-${fs.readdirSync(root).length}.jsonl`);
  fs.writeFileSync(
    file,
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  return file;
};

const records: FeedRecord[] = [
  {
    t: 'start',
    at: 1000,
    pid: process.pid,
    id: 's-1',
    name: 'explorer',
    generation: 1,
    startedAt: 1000,
  },
  { t: 'entry', at: 2000, kind: 'tool', text: 'grep needle' },
  {
    t: 'end',
    at: 3000,
    status: 'completed',
    startedAt: 1000,
    turns: 1,
    tokens: { input: 1, output: 1 },
    cost: 0,
  } as FeedRecord,
];

const view = (args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', VIEWER, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// A module exporting only what the viewer needs, marked so the output proves
// the viewer used it.
const markedTui = () => {
  const file = path.join(root, 'marked-tui.mjs');
  fs.writeFileSync(
    file,
    `const mark = (t) => t.replace('needle', 'NEEDLE-FROM-HOST');
export const truncateToWidth = (t, w) => mark(t).slice(0, w);
export const wrapTextWithAnsi = (t) => [mark(t)];
`,
  );
  return pathToFileURL(file).href;
};

test('the viewer renders with the TUI module it is handed', () => {
  const out = view([feedWith(records), '10', markedTui()]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /explorer/);
  assert.match(out.stdout, /grep NEEDLE-FROM-HOST/);
});

test('the viewer renders with the real host pi-tui module', () => {
  const localPackage = fileURLToPath(
    new URL('../node_modules/@earendil-works/pi-coding-agent', import.meta.url),
  );
  const out = view([feedWith(records), '10', tuiModuleUrlFrom(localPackage)]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /grep needle/);
});

test('no TUI module URL: usage error, nothing rendered', () => {
  const out = view([feedWith(records), '10']);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /usage: pane-viewer/);
  assert.equal(out.stdout, '');
});

test('an unusable TUI module fails; there is no fallback copy', () => {
  const missing = view([feedWith(records), '10', 'file:///no/such/tui.mjs']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pane-viewer: /);
  assert.equal(missing.stdout, '');

  const empty = path.join(root, 'empty-tui.mjs');
  fs.writeFileSync(empty, 'export const x = 1;\n');
  const wrong = view([feedWith(records), '10', pathToFileURL(empty).href]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not export the text helpers/);
  assert.equal(wrong.stdout, '');
});
