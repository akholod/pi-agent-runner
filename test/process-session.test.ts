import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WRAP_UP_MESSAGE, liveRuns, runAgent } from '../src/index.ts';
import type { ParentContext, RunAgentOptions } from '../src/index.ts';
import {
  buildProcessArgs,
  createProcessSessionFactory,
} from '../src/process-session.ts';
import type { ProcessSessionOptions } from '../src/process-session.ts';
import { fakeBus, sleep } from './fake.ts';

const FAKE = fileURLToPath(
  new URL('fixtures/fake-pi-rpc.mjs', import.meta.url),
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const gone = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return false;
};

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'process-test-'));

type Ui = NonNullable<ParentContext['ctx']['ui']>;

const parentWith = (ui?: Partial<Ui>): ParentContext => ({
  events: fakeBus(),
  ctx: { ui } as ParentContext['ctx'],
});

const factory = (
  env: Record<string, string> = {},
  extra: ProcessSessionOptions = {},
) =>
  createProcessSessionFactory({
    command: [process.execPath, FAKE],
    env,
    resolveExtensions: () => Promise.resolve([]),
    shutdownGraceMs: 200,
    termGraceMs: 200,
    abortGraceMs: 200,
    ...extra,
  });

const options = (
  task: string,
  extra: Partial<RunAgentOptions> = {},
): RunAgentOptions => ({
  parent: parentWith(),
  cwd: os.tmpdir(),
  model: 'fake/model',
  systemPrompt: 'test',
  task,
  backend: 'process',
  ...extra,
});

const pidsOf = (file: string) =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as {
    pid: number;
    grandchild: number;
  };

test('process: a prompt completes with the answer', async () => {
  const result = await runAgent(options('scenario:normal'), {
    factory: factory(),
  });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.value, 'hello');
  assert.equal(result.model, 'fake/model');
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.input, 10);
  assert.equal(result.usage.cost, 0.5);
});

test('process: kills a child stuck in a tool on tool timeout', async () => {
  const pidFile = path.join(scratch(), 'pids.json');
  const result = await runAgent(
    options('scenario:stuck', { toolTimeoutMs: 300 }),
    { factory: factory({ FAKE_PIDFILE: pidFile }) },
  );
  assert.equal(result.status, 'timed_out');
  assert.match(String(result.error), /tool 'bash' exceeded/);
  const { pid, grandchild } = pidsOf(pidFile);
  assert.ok(await gone(pid), 'child process is gone');
  assert.ok(await gone(grandchild), 'grandchild in the group is gone');
});

test('process: kills a child stuck in a tool on run timeout', async () => {
  const pidFile = path.join(scratch(), 'pids.json');
  const result = await runAgent(options('scenario:stuck', { timeoutMs: 300 }), {
    factory: factory({ FAKE_PIDFILE: pidFile }),
  });
  assert.equal(result.status, 'timed_out');
  const { pid, grandchild } = pidsOf(pidFile);
  assert.ok(await gone(pid));
  assert.ok(await gone(grandchild));
});

test('process: kills a child that ignores abort (cancelled)', async () => {
  const pidFile = path.join(scratch(), 'pids.json');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runAgent(
    options('scenario:stuck', { signal: controller.signal }),
    { factory: factory({ FAKE_PIDFILE: pidFile }) },
  );
  assert.equal(result.status, 'cancelled');
  const { pid, grandchild } = pidsOf(pidFile);
  assert.ok(await gone(pid));
  assert.ok(await gone(grandchild));
});

test('process: a cooperative abort needs no kill', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const result = await runAgent(
    options('scenario:slow', { signal: controller.signal }),
    { factory: factory({}, { abortGraceMs: 10_000 }) },
  );
  assert.equal(result.status, 'cancelled');
  assert.ok(Date.now() - started < 5000);
});

test('process: the wrap-up reaches the child as a steer command', async () => {
  const result = await runAgent(
    options('scenario:wrap', { timeoutMs: 200, wrapUpMs: 5000 }),
    { factory: factory() },
  );
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.wrappedUp, true);
  assert.equal(result.value, `steered:${WRAP_UP_MESSAGE}`);
});

test('process: a child ignoring the wrap-up is stopped after it', async () => {
  const result = await runAgent(
    options('scenario:slow', { timeoutMs: 150, wrapUpMs: 150 }),
    { factory: factory() },
  );
  assert.equal(result.status, 'timed_out');
  assert.equal(
    result.error,
    'timed out after 150ms; no final answer within the 150ms wrap-up',
  );
  assert.equal(result.wrappedUp, true);
});

test('process: the idle limit fires on a silent child', async () => {
  const result = await runAgent(
    options('scenario:slow', { idleTimeoutMs: 200 }),
    { factory: factory() },
  );
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'no activity for 200ms');
});

test('process: the idle limit does not fire on a child in a tool', async () => {
  const pidFile = path.join(scratch(), 'pids.json');
  const result = await runAgent(
    options('scenario:stuck', { idleTimeoutMs: 100, timeoutMs: 500 }),
    { factory: factory({ FAKE_PIDFILE: pidFile }) },
  );
  // Only the wall clock ends a child that sits in a tool.
  assert.equal(result.status, 'timed_out');
  assert.equal(result.error, 'timed out after 500ms');
  const { pid, grandchild } = pidsOf(pidFile);
  assert.ok(await gone(pid));
  assert.ok(await gone(grandchild));
});

test('process: an unexpected exit fails the run with the code', async () => {
  const result = await runAgent(options('scenario:exit'), {
    factory: factory(),
  });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /child process exited with code 3/);
});

test('process: a dialog is relayed to the parent ui', async () => {
  const asked: string[] = [];
  const ui = {
    select: (title: string, choices: string[]) => {
      asked.push(`${title}|${choices.join(',')}`);
      return Promise.resolve('Yes');
    },
  };
  const result = await runAgent(
    options('scenario:ask', { parent: parentWith(ui) }),
    { factory: factory() },
  );
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.value, 'answer:Yes');
  assert.deepEqual(asked, ['Allow it?|Yes,No']);
});

test('process: timers pause while a relayed dialog waits', async () => {
  const ui = {
    select: async () => {
      await sleep(700);
      return 'Yes';
    },
  };
  const result = await runAgent(
    options('scenario:ask', { parent: parentWith(ui), timeoutMs: 300 }),
    { factory: factory() },
  );
  assert.equal(result.status, 'completed', result.error);
  assert.ok(result.usage.waitedMs >= 600, `waited ${result.usage.waitedMs}`);
});

test('process: deny and a missing ui cancel at once', async () => {
  const ui = { select: () => Promise.reject(new Error('must not be asked')) };
  const denied = await runAgent(
    options('scenario:ask', {
      parent: parentWith(ui),
      permissionAsks: 'deny',
    }),
    { factory: factory() },
  );
  assert.equal(denied.value, 'answer:cancelled');
  const noUi = await runAgent(options('scenario:ask'), { factory: factory() });
  assert.equal(noUi.value, 'answer:cancelled');
});

test('process: submit_result round-trips to the parent', async () => {
  const result = await runAgent(
    options('scenario:submit', {
      result: {
        kind: 'structured',
        schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
        },
      },
    }),
    { factory: factory() },
  );
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.value, { n: 7 });
});

test('process: dispose escalates stdin close, SIGTERM, SIGKILL', async () => {
  const dir = scratch();
  const log = path.join(dir, 'log');
  const session = await factory({
    FAKE_IGNORE_SHUTDOWN: '1',
    FAKE_IGNORE_TERM: '1',
    FAKE_LOG: log,
  }).create({
    cwd: os.tmpdir(),
    systemPrompt: '',
    model: 'fake/model',
    extensions: 'none',
    noContextFiles: true,
    noSkills: true,
    providerExtensions: {},
    policyExtensions: [],
    parent: parentWith(),
    guard: { git: true, cwd: os.tmpdir() },
    forwardAsks: true,
  });
  const started = Date.now();
  await session.dispose();
  assert.ok(Date.now() - started >= 350, 'waited both graces');
  assert.equal(fs.readFileSync(log, 'utf8'), 'term\n');
});

test('process: a child without the guard extension is refused', async () => {
  const result = await runAgent(options('scenario:normal'), {
    factory: factory({ FAKE_NO_MARKERS: '1' }),
  });
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /child extension did not load/);
});

test('process: extensionFactories is refused', async () => {
  const result = await runAgent(
    options('x', { extensionFactories: [() => {}] }),
    { factory: factory() },
  );
  assert.equal(result.status, 'failed');
  assert.match(String(result.error), /extensionFactories cannot cross/);
});

test('process: the child shows up in the live registry', async () => {
  await runAgent(options('scenario:normal', { label: { name: 'proc-live' } }), {
    factory: factory(),
  });
  const run = liveRuns()
    .list()
    .find((r) => r.name === 'proc-live');
  assert.ok(run);
  assert.equal(run.id, 'fake-session');
  assert.equal(run.state, 'completed');
  assert.equal(run.turns, 1);
});

test('process: label.name goes into the child config', async () => {
  const dir = scratch();
  const copy = path.join(dir, 'config.json');
  const env = { FAKE_CONFIG_COPY: copy };
  await runAgent(options('scenario:normal', { label: { name: 'proc-name' } }), {
    factory: factory(env),
  });
  const named = JSON.parse(fs.readFileSync(copy, 'utf8')) as { label?: string };
  assert.equal(named.label, 'proc-name');
  await runAgent(options('scenario:normal'), { factory: factory(env) });
  const unnamed = JSON.parse(fs.readFileSync(copy, 'utf8')) as {
    label?: string;
  };
  assert.equal(unnamed.label, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildProcessArgs maps the spec to pi flags', () => {
  const spec = {
    cwd: '/w',
    systemPrompt: 'sp',
    extensions: 'none',
    noContextFiles: true,
    noSkills: true,
    providerExtensions: {},
    policyExtensions: [],
    parent: parentWith(),
    guard: { allowedTools: ['read', 'ls'], git: true, cwd: '/w' },
    forwardAsks: true,
    sessionFile: '/w/s.jsonl',
  } as const;
  const args = buildProcessArgs(spec as never, {
    model: 'p/m',
    thinking: 'high',
    systemPrompt: 'sp',
    extensionPaths: ['/a.ts', '/b.ts'],
  });
  assert.deepEqual(args, [
    '--mode',
    'rpc',
    '--model',
    'p/m',
    '--thinking',
    'high',
    '--system-prompt',
    'sp',
    '--tools',
    'read,ls',
    '--no-skills',
    '--no-context-files',
    '--no-prompt-templates',
    '--no-themes',
    '--session',
    '/w/s.jsonl',
    '--no-extensions',
    '-e',
    '/a.ts',
    '-e',
    '/b.ts',
  ]);
  const bare = buildProcessArgs(
    {
      ...spec,
      noSkills: false,
      noContextFiles: false,
      sessionFile: undefined,
      guard: { allowedTools: [], git: true, cwd: '/w' },
    } as never,
    {
      model: undefined,
      thinking: undefined,
      systemPrompt: 'x',
      extensionPaths: [],
    },
  );
  assert.ok(bare.includes('--no-tools'));
  assert.ok(bare.includes('--no-session'));
  assert.ok(!bare.includes('--no-skills'));
  assert.ok(!bare.includes('--model'));
  assert.ok(!bare.includes('--thinking'));
});
