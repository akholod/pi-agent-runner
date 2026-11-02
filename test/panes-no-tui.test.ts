// The host installation has no filesystem pi-tui entry: panes are disabled
// with a warning, and no viewer is started (never a copy of the runner's).
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from '../src/host-runtime.ts';
import type { LiveRegistry, LiveRun } from '../src/live.ts';
import { mountPanes } from '../src/panes.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-no-tui-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// a host whose package directory sits where no pi-tui can be found
const bare = path.join(root, 'bare');
fs.mkdirSync(bare);
bindHostRuntime({
  pi: { ...pi, getPackageDir: () => bare },
  tui,
  typebox: { Unsafe, Compile },
});

const run: LiveRun = {
  id: 'a',
  name: 'explorer',
  state: 'running',
  waitingForUser: false,
  turns: 0,
  toolCalls: 0,
  tokens: { input: 0, output: 0 },
  cost: 0,
  generation: 1,
  startedAt: 1000,
  lastActivityAt: 1000,
};

test('panes are disabled when the host TUI is not found', async () => {
  const listeners = new Set<() => void>();
  const registry: LiveRegistry = {
    list: () => [run],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const calls: string[][] = [];
  const notes: [string, string | undefined][] = [];
  const handle = mountPanes(
    {
      mode: 'tui',
      hasUI: true,
      cwd: root,
      ui: { notify: (message, type) => notes.push([message, type]) },
    },
    {
      registry,
      env: { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%0' },
      hasBinary: () => true,
      feedDir: path.join(root, 'feeds'),
      viewer: '/pkg/dist/pane-viewer.js',
      exec: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve('%1\n');
      },
      execSync: () => undefined,
    },
  );
  for (const listener of [...listeners]) listener();
  for (let i = 0; i < 6; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  handle.dispose();
  assert.deepEqual(calls, []);
  assert.equal(notes.length, 1);
  assert.match(
    notes[0][0],
    /^Agent panes disabled \(tmux\): no host TUI module for the viewer/,
  );
  assert.equal(notes[0][1], 'warning');
});
