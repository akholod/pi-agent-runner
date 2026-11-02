// No binding anywhere in this process: nothing imports bind-host.ts and
// fake.ts is not used. The default Pi session factory must fail cleanly and
// before any side effect.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  createPiSessionFactory,
  getHostRuntimeInfo,
  liveRuns,
  runAgent,
  startAgent,
} from '../src/index.ts';
import type {
  ChildSession,
  ChildSessionFactory,
  ParentContext,
  RunAgentOptions,
} from '../src/index.ts';

const parent = (): ParentContext => ({
  events: { emit() {}, on: () => () => {} },
  ctx: {} as ParentContext['ctx'],
});

const options = (cwd: string, extra: Partial<RunAgentOptions> = {}) =>
  ({
    task: 'do it',
    systemPrompt: 'be brief',
    cwd,
    parent: parent(),
    ...extra,
  }) as RunAgentOptions;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'runner-unbound-'));

test('the process starts unbound', () => {
  assert.deepEqual(getHostRuntimeInfo(), { bound: false });
});

test('createPiSessionFactory fails fast when unbound', () => {
  assert.throws(
    () => createPiSessionFactory(),
    /PI_AGENT_RUNNER_HOST_UNBOUND:/,
  );
});

test('runAgent with the default factory fails cleanly', async () => {
  const cwd = tmp();
  const transcript = path.join(cwd, 'deep', 'dir', 'run.jsonl');
  const result = await runAgent(options(cwd, { transcriptPath: transcript }));
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /^PI_AGENT_RUNNER_HOST_UNBOUND:/);
  assert.equal(result.value, undefined);
  assert.equal(fs.existsSync(path.join(cwd, 'deep')), false);
  assert.deepEqual(liveRuns().list(), []);
  fs.rmSync(cwd, { recursive: true });
});

test('startAgent with the default factory rejects cleanly', async () => {
  const cwd = tmp();
  const transcript = path.join(cwd, 'deep', 'run.jsonl');
  await assert.rejects(
    startAgent(options(cwd, { transcriptPath: transcript })),
    /PI_AGENT_RUNNER_HOST_UNBOUND:/,
  );
  assert.equal(fs.existsSync(path.join(cwd, 'deep')), false);
  assert.deepEqual(liveRuns().list(), []);
  fs.rmSync(cwd, { recursive: true });
});

test('an unbound host is not an invalid result schema', async () => {
  const cwd = tmp();
  const result = await runAgent(
    options(cwd, {
      result: { kind: 'structured', schema: { type: 'string' } },
    }),
  );
  assert.equal(result.status, 'failed');
  assert.match(result.error ?? '', /^PI_AGENT_RUNNER_HOST_UNBOUND:/);
  assert.doesNotMatch(result.error ?? '', /invalid result schema/);
  fs.rmSync(cwd, { recursive: true });
});

test('an injected factory works without binding', async () => {
  const cwd = tmp();
  const session: ChildSession = {
    sessionId: 'fake-1',
    modelId: 'fake/model',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
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
  const factory: ChildSessionFactory = { create: async () => session };
  const result = await runAgent(options(cwd), { factory });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'hello');
  fs.rmSync(cwd, { recursive: true });
});

test('renderers take an explicit text runtime unbound', async () => {
  const realTui = await import('@earendil-works/pi-tui');
  const { entryLines } = await import('../src/agents-command.ts');
  const paint = {
    fg: (_c: string, text: string) => text,
    bold: (t: string) => t,
  };
  assert.throws(
    () => entryLines({ at: 1, kind: 'text', text: 'hi' }, 40, paint),
    /PI_AGENT_RUNNER_HOST_UNBOUND:/,
  );
  const lines = entryLines(
    { at: 1, kind: 'text', text: 'hi' },
    40,
    paint,
    realTui,
  );
  assert.match(lines[0], /hi$/);
});
