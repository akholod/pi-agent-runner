// A bound host whose CLI cannot be determined: the default process backend
// fails before any side effect, and tells the caller to pass a command. An
// injected fake factory keeps working.
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
import { liveRuns, runAgent, startAgent } from '../src/index.ts';
import type { ParentContext, RunAgentOptions } from '../src/index.ts';
import { createProcessSessionFactory } from '../src/process-session.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fail-fast-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

bindHostRuntime({
  pi: { ...pi, getPackageDir: () => path.join(root, 'no-such-installation') },
  tui,
  typebox: { Unsafe, Compile },
});

const options = (extra: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  parent: {
    events: { emit() {}, on: () => () => {} },
    ctx: {},
  } as unknown as ParentContext,
  cwd: root,
  model: 'fake/model',
  systemPrompt: 'test',
  task: 'scenario:normal',
  backend: 'process',
  ...extra,
});

test('runAgent fails with a clear error and no side effects', async () => {
  const transcript = path.join(root, 'deep', 'run.jsonl');
  const timers = process
    .getActiveResourcesInfo()
    .filter((n) => n === 'Timeout');
  const result = await runAgent(options({ transcriptPath: transcript }));
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /cannot determine the host Pi CLI/);
  assert.match(result.error ?? '', /explicit command/);
  assert.equal(fs.existsSync(path.join(root, 'deep')), false);
  assert.deepEqual(liveRuns().list(), []);
  assert.equal(
    process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length,
    timers.length,
  );
});

test('startAgent rejects with no side effects', async () => {
  const transcript = path.join(root, 'deep2', 'run.jsonl');
  await assert.rejects(
    startAgent(options({ transcriptPath: transcript })),
    /cannot determine the host Pi CLI/,
  );
  assert.equal(fs.existsSync(path.join(root, 'deep2')), false);
  assert.deepEqual(liveRuns().list(), []);
});

test('the factory refuses before creating its temp directory', async () => {
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('pi-agent-runner-'));
  await assert.rejects(
    createProcessSessionFactory({
      resolveExtensions: () => {
        throw new Error('extensions must not be resolved yet');
      },
    }).create({
      cwd: root,
      systemPrompt: 'x',
      model: 'fake/model',
      parent: options().parent,
    } as never),
    /cannot determine the host Pi CLI/,
  );
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith('pi-agent-runner-'));
  assert.deepEqual(after, before);
});

test('an injected factory still works', async () => {
  const session = {
    sessionId: 's',
    modelId: 'fake/model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
      },
    ],
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    dispose: async () => {},
  };
  const result = await runAgent(options(), {
    factory: { create: async () => session },
  });
  assert.equal(result.status, 'completed');
});
