// Own process: a host is bound, then pane-viewer is imported. Importing it
// must not change which TUI functions the host-bound renderers use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import * as realTui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from '../src/host-runtime.ts';
import { tuiRuntime } from '../src/tui.ts';

const seen = { truncate: 0, wrap: 0 };
const hostTui = {
  Key: realTui.Key,
  matchesKey: realTui.matchesKey,
  visibleWidth: realTui.visibleWidth,
  truncateToWidth: (...args: Parameters<typeof realTui.truncateToWidth>) => {
    seen.truncate++;
    return realTui.truncateToWidth(...args);
  },
  wrapTextWithAnsi: (...args: Parameters<typeof realTui.wrapTextWithAnsi>) => {
    seen.wrap++;
    return realTui.wrapTextWithAnsi(...args);
  },
};

bindHostRuntime({ pi, tui: hostTui, typebox: { Unsafe, Compile } });

const paint = {
  fg: (_c: string, text: string) => text,
  bold: (t: string) => t,
};

test('importing pane-viewer keeps the bound host TUI functions', async () => {
  const before = tuiRuntime();
  assert.equal(before.truncateToWidth, hostTui.truncateToWidth);
  const viewer = await import('../src/pane-viewer.ts');
  const after = tuiRuntime();
  assert.equal(after.truncateToWidth, hostTui.truncateToWidth);
  assert.equal(after.wrapTextWithAnsi, hostTui.wrapTextWithAnsi);
  assert.notEqual(after.truncateToWidth, realTui.truncateToWidth);

  // host-bound renderers outside the viewer still go through the host
  const { entryLines } = await import('../src/agents-command.ts');
  const wrapped = seen.wrap;
  entryLines({ at: 1000, kind: 'text', text: 'hello' }, 40, paint);
  assert.equal(seen.wrap, wrapped + 1);
  assert.equal(typeof viewer.runViewer, 'function');
});

test('the viewer renderers use the text runtime they are given', async () => {
  const viewer = await import('../src/pane-viewer.ts');
  const before = seen.truncate;
  let explicit = 0;
  const given = {
    wrapTextWithAnsi: realTui.wrapTextWithAnsi,
    truncateToWidth: (...args: Parameters<typeof realTui.truncateToWidth>) => {
      explicit++;
      return realTui.truncateToWidth(...args);
    },
  };
  viewer.headerLines(
    {
      t: 'start',
      at: 1,
      pid: 1,
      id: 's',
      name: 'n',
      generation: 1,
      startedAt: 1,
    },
    40,
    paint,
    given,
  );
  assert.equal(explicit, 1);
  assert.equal(seen.truncate, before);
});
