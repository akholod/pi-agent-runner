// Precedence: factory `command` > bound `processCommand` > host CLI. Here the
// host binds a `processCommand`; its getPackageDir would not even resolve.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from '../src/host-runtime.ts';
import { runAgent } from '../src/index.ts';
import type { ParentContext, RunAgentOptions } from '../src/index.ts';
import { createProcessSessionFactory } from '../src/process-session.ts';

const FAKE = fileURLToPath(
  new URL('fixtures/fake-pi-rpc.mjs', import.meta.url),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-bound-cmd-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOUND = path.join(root, 'bound-pi.mjs');
const EXPLICIT = path.join(root, 'explicit-pi.mjs');
fs.copyFileSync(FAKE, BOUND);
fs.copyFileSync(FAKE, EXPLICIT);

bindHostRuntime({
  pi: {
    ...pi,
    getPackageDir: () => {
      throw new Error('the host CLI must not be consulted');
    },
  },
  tui,
  typebox: { Unsafe, Compile },
  processCommand: [process.execPath, BOUND],
});

const options = (): RunAgentOptions => ({
  parent: {
    events: { emit() {}, on: () => () => {} },
    ctx: {},
  } as unknown as ParentContext,
  cwd: os.tmpdir(),
  model: 'fake/model',
  systemPrompt: 'test',
  task: 'scenario:normal',
  backend: 'process',
});

const scriptUsed = async (command?: string[]) => {
  const copy = path.join(fs.mkdtempSync(path.join(root, 'r-')), 'seen.json');
  const result = await runAgent(options(), {
    factory: createProcessSessionFactory({
      command,
      env: { FAKE_ARGV_COPY: copy },
      resolveExtensions: () => Promise.resolve([]),
      shutdownGraceMs: 200,
      termGraceMs: 200,
      abortGraceMs: 200,
    }),
  });
  assert.equal(result.status, 'completed', result.error);
  return (JSON.parse(fs.readFileSync(copy, 'utf8')) as { script: string })
    .script;
};

test('the bound processCommand beats the host CLI', async () => {
  assert.equal(await scriptUsed(), BOUND);
});

test('the factory command beats the bound processCommand', async () => {
  assert.equal(await scriptUsed([process.execPath, EXPLICIT]), EXPLICIT);
});
