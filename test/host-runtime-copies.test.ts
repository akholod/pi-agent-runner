// Two physical copies of host-runtime.ts, loaded from different files, as
// when Opium and Spiral each bundle the runner. The module-local state of
// each copy is separate; only the globalThis slot is shared. Own file, so
// the process-wide slot starts empty.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';

type Copy = typeof import('../src/host-runtime.ts');
type Host = Parameters<Copy['bindHostRuntime']>[0];

const SOURCE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'src',
  'host-runtime.ts',
);

const host = (): Host => ({ pi, tui, typebox: { Unsafe, Compile } });

let dir: string;
let a: Copy;
let b: Copy;

const load = async (name: string): Promise<Copy> => {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder);
  const file = path.join(folder, 'host-runtime.ts');
  fs.copyFileSync(SOURCE, file);
  return (await import(pathToFileURL(file).href)) as Copy;
};

const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-copies-'));
  a = await load('a');
  b = await load('b');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('two physical copies share one binding', () => {
  test('the copies are distinct module instances', () => {
    assert.notEqual(a.bindHostRuntime, b.bindHostRuntime);
    assert.notEqual(a.requireHostRuntime, b.requireHostRuntime);
    assert.notEqual(a.serializeLoading, b.serializeLoading);
    assert.notEqual(a.HostUnboundError, b.HostUnboundError);
  });

  test('both are unbound at first; each recognizes the other error', () => {
    assert.deepEqual(a.getHostRuntimeInfo(), { bound: false });
    assert.deepEqual(b.getHostRuntimeInfo(), { bound: false });
    assert.equal(a.isHostBound(), false);
    let caught: unknown;
    try {
      a.requireHostRuntime();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof a.HostUnboundError);
    assert.ok(!(caught instanceof b.HostUnboundError));
    assert.ok(b.isHostUnboundError(caught));
  });

  test('a binding made through A is visible through B', () => {
    a.bindHostRuntime(host());
    assert.equal(b.isHostBound(), true);
    const info = b.getHostRuntimeInfo();
    assert.ok(info.bound);
    assert.equal(info.hostVersion, pi.VERSION);
    assert.deepEqual(info, a.getHostRuntimeInfo());
    assert.equal(b.requireHostRuntime(), a.requireHostRuntime());
    assert.equal(
      b.requireHostRuntime().pi.createAgentSession,
      pi.createAgentSession,
    );
  });

  test('an identical rebind through B is a no-op', () => {
    const before = a.requireHostRuntime();
    b.bindHostRuntime(host());
    b.bindHostRuntime({
      pi: { ...pi },
      tui: { ...tui },
      typebox: { Unsafe, Compile },
    });
    assert.equal(a.requireHostRuntime(), before);
    assert.equal(b.requireHostRuntime(), before);
  });

  test('a conflicting bind through B throws and keeps the original', () => {
    const original = a.requireHostRuntime();
    assert.throws(
      () =>
        b.bindHostRuntime({
          ...host(),
          pi: { ...pi, getAgentDir: () => '/elsewhere' },
        }),
      /^Error: HOST_CONFLICT:.*pi\.getAgentDir/,
    );
    assert.equal(a.requireHostRuntime(), original);
    assert.equal(b.requireHostRuntime(), original);
    assert.equal(b.requireHostRuntime().pi.getAgentDir, pi.getAgentDir);
  });

  test('loading tasks of both copies run one at a time', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fromA = a.serializeLoading(async () => {
      order.push('a:start');
      await gate;
      order.push('a:end');
    });
    const fromB = b.serializeLoading(async () => {
      order.push('b:start');
      await tick();
      order.push('b:end');
    });
    const fromA2 = a.serializeLoading(async () => {
      order.push('a2:start');
    });
    await tick();
    await tick();
    assert.deepEqual(order, ['a:start']);
    release();
    await Promise.all([fromA, fromB, fromA2]);
    assert.deepEqual(order, [
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'a2:start',
    ]);
  });

  test('the queue continues after a rejected task of either copy', async () => {
    await assert.rejects(
      a.serializeLoading(() => Promise.reject(new Error('boom-a'))),
      /boom-a/,
    );
    assert.equal(await b.serializeLoading(async () => 'b-ran'), 'b-ran');
    const failing = b.serializeLoading(() =>
      Promise.reject(new Error('boom-b')),
    );
    const next = a.serializeLoading(async () => 'a-ran');
    await assert.rejects(failing, /boom-b/);
    assert.equal(await next, 'a-ran');
  });
});
