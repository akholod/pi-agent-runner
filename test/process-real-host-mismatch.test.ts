// The child's host is Pi 1.x, the parent claims another version: the entry
// point refuses to bind, the marker commands never appear, and the parent
// stops the child before any prompt.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { hostCliCommand } from '../src/host-paths.ts';
import { bindHostRuntime } from '../src/host-runtime.ts';
import { runAgent } from '../src/index.ts';
import type { ParentContext } from '../src/index.ts';
import { createProcessSessionFactory } from '../src/process-session.ts';

// the real CLI of the local installation, resolved while VERSION still matches
const cli = hostCliCommand(pi);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mismatch-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

bindHostRuntime({
  pi: { ...pi, VERSION: '9.9.9' },
  tui,
  typebox: { Unsafe, Compile },
});

const parent = {
  events: { emit() {}, on: () => () => {} },
  ctx: {
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    thinkingLevel: 'off',
    sessionManager: { getSessionId: () => 'parent' },
  },
} as unknown as ParentContext;

test('a version mismatch in the child blocks the first prompt', async () => {
  const transcript = path.join(root, 'child.jsonl');
  const result = await runAgent(
    {
      parent,
      cwd: root,
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: 'x',
      task: 'must never be sent',
      backend: 'process',
      transcriptPath: transcript,
    },
    {
      factory: createProcessSessionFactory({
        command: [...cli],
        resolveExtensions: async () => [],
        shutdownGraceMs: 200,
        termGraceMs: 200,
      }),
    },
  );
  assert.equal(result.status, 'failed');
  // Pi refuses to start (or, in versions that carry on, the marker check does)
  assert.match(
    result.error ?? '',
    /child process exited|child extension did not load/,
  );
  const reason = `child host is Pi ${pi.VERSION} but the parent is Pi 9.9.9`;
  assert.ok((result.error ?? '').includes(reason), result.error);
  // the child never ran a prompt: no transcript was written
  assert.equal(fs.existsSync(transcript), false);
});
