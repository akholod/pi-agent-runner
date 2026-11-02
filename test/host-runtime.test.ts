// Not importing bind-host.ts: these tests drive the registry themselves.
// The slot is dropped between tests (no public reset helper exists).
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import {
  TESTED_HOST_VERSIONS,
  bindHostRuntime,
  getHostRuntimeInfo,
  requireHostRuntime,
  serializeLoading,
} from '../src/host-runtime.ts';
import type { HostRuntime } from '../src/host-runtime.ts';
import * as api from '../src/index.ts';

const SLOT = Symbol.for('pi-agent-runner:host-runtime:v1');
const reset = () => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
};

const host = (): HostRuntime => ({
  pi,
  tui,
  typebox: { Unsafe, Compile },
});

// A different wrapper object around the same references, as jiti may hand
// out for the same module.
const wrapped = (): HostRuntime => ({
  pi: { ...pi },
  tui: { ...tui },
  typebox: { Unsafe, Compile },
});

const withVersion = (version: unknown): HostRuntime =>
  ({
    ...host(),
    pi: { ...pi, VERSION: version },
  }) as HostRuntime;

beforeEach(reset);

describe('unbound', () => {
  test('info says not bound', () => {
    assert.deepEqual(getHostRuntimeInfo(), { bound: false });
  });

  test('requireHostRuntime throws the documented message', () => {
    assert.throws(
      () => requireHostRuntime(),
      (error: Error) => {
        assert.match(error.message, /^PI_AGENT_RUNNER_HOST_UNBOUND:/);
        return true;
      },
    );
  });

  test('serializeLoading rejects before running the task', async () => {
    let ran = false;
    await assert.rejects(
      serializeLoading(async () => {
        ran = true;
      }),
      /PI_AGENT_RUNNER_HOST_UNBOUND:/,
    );
    assert.equal(ran, false);
  });

  test('the public entry exports the binding API', () => {
    assert.equal(api.bindHostRuntime, bindHostRuntime);
    assert.equal(api.getHostRuntimeInfo, getHostRuntimeInfo);
  });
});

describe('binding', () => {
  test('stores the references and reports info', () => {
    bindHostRuntime(host());
    const bound = requireHostRuntime();
    assert.equal(bound.pi.createAgentSession, pi.createAgentSession);
    assert.equal(bound.pi.ModelRuntime, pi.ModelRuntime);
    assert.equal(bound.tui.visibleWidth, tui.visibleWidth);
    assert.equal(bound.typebox.Compile, Compile);
    assert.equal(bound.processCommand, undefined);
    const info = getHostRuntimeInfo();
    assert.deepEqual(info, {
      bound: true,
      source: 'injected',
      hostVersion: pi.VERSION,
      testedVersions: TESTED_HOST_VERSIONS,
      warnings: [],
    });
  });

  test('the installed baseline is a tested version', () => {
    assert.ok(TESTED_HOST_VERSIONS.includes(pi.VERSION));
    assert.deepEqual([...TESTED_HOST_VERSIONS], ['1.1.0', '1.5.0']);
  });

  test('only the used members are kept, not the namespace', () => {
    bindHostRuntime(host());
    assert.notEqual(requireHostRuntime().pi, pi);
    assert.equal('AuthStorage' in requireHostRuntime().pi, false);
  });

  test('rebinding the same references is a no-op', () => {
    bindHostRuntime(host());
    const first = requireHostRuntime();
    bindHostRuntime(host());
    assert.equal(requireHostRuntime(), first);
  });

  test('rebinding through different wrapper objects is a no-op', () => {
    bindHostRuntime(host());
    const first = requireHostRuntime();
    bindHostRuntime(wrapped());
    assert.equal(requireHostRuntime(), first);
  });

  test('different implementations conflict, even with equal VERSION', () => {
    bindHostRuntime(host());
    const other = {
      ...host(),
      pi: { ...pi, getAgentDir: () => '/elsewhere' },
    };
    assert.throws(
      () => bindHostRuntime(other),
      (error: Error) => {
        assert.match(error.message, /^HOST_CONFLICT:/);
        assert.match(error.message, /pi\.getAgentDir/);
        return true;
      },
    );
    assert.equal(requireHostRuntime().pi.getAgentDir, pi.getAgentDir);
  });

  test('a different tui or typebox member conflicts', () => {
    bindHostRuntime(host());
    assert.throws(
      () =>
        bindHostRuntime({
          ...host(),
          tui: { ...tui, visibleWidth: () => 0 },
        }),
      /HOST_CONFLICT:.*tui\.visibleWidth/,
    );
    assert.throws(
      () =>
        bindHostRuntime({
          ...host(),
          typebox: {
            Unsafe,
            Compile: (() => ({})) as unknown as typeof Compile,
          },
        }),
      /HOST_CONFLICT:.*typebox\.Compile/,
    );
  });

  test('processCommand is stored, and a different one conflicts', () => {
    bindHostRuntime({ ...host(), processCommand: ['node', 'pi.js'] });
    assert.deepEqual(requireHostRuntime().processCommand, ['node', 'pi.js']);
    bindHostRuntime({ ...host(), processCommand: ['node', 'pi.js'] });
    assert.throws(
      () => bindHostRuntime({ ...host(), processCommand: ['pi'] }),
      /HOST_CONFLICT:.*processCommand/,
    );
    assert.throws(() => bindHostRuntime(host()), /HOST_CONFLICT:/);
  });

  test('a malformed processCommand is rejected', () => {
    assert.throws(
      () => bindHostRuntime({ ...host(), processCommand: [] as never }),
      /processCommand/,
    );
    assert.deepEqual(getHostRuntimeInfo(), { bound: false });
  });

  test('the shared loading queue runs tasks one after another', async () => {
    bindHostRuntime(host());
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = serializeLoading(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = serializeLoading(async () => {
      order.push('second:start');
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(order, ['first:start']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start']);
  });

  test('a failed loading task does not block the next one', async () => {
    bindHostRuntime(host());
    await assert.rejects(
      serializeLoading(() => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(await serializeLoading(async () => 'ok'), 'ok');
  });

  test('another runner copy shares the slot through globalThis', () => {
    bindHostRuntime(host());
    const slot = (globalThis as Record<symbol, unknown>)[SLOT] as {
      protocol: number;
      loading: Promise<unknown>;
    };
    assert.equal(slot.protocol, 1);
    assert.ok(slot.loading instanceof Promise);
  });
});

describe('capabilities', () => {
  const missing = (build: () => unknown, capability: RegExp) => {
    assert.throws(
      () => bindHostRuntime(build() as HostRuntime),
      (error: Error) => {
        assert.match(error.message, capability);
        assert.match(error.message, new RegExp(`VERSION ${pi.VERSION}`));
        return true;
      },
    );
    assert.deepEqual(getHostRuntimeInfo(), { bound: false });
  };

  test('a missing function names the capability and the version', () => {
    missing(
      () => ({ ...host(), pi: { ...pi, createAgentSession: undefined } }),
      /pi\.createAgentSession \(function\)/,
    );
    missing(
      () => ({ ...host(), tui: { ...tui, wrapTextWithAnsi: undefined } }),
      /tui\.wrapTextWithAnsi \(function\)/,
    );
    missing(
      () => ({ ...host(), typebox: { Unsafe, Compile: undefined } }),
      /typebox\.Compile \(function\)/,
    );
  });

  test('a missing class or static method is named', () => {
    missing(
      () => ({ ...host(), pi: { ...pi, DefaultResourceLoader: undefined } }),
      /pi\.DefaultResourceLoader \(class\)/,
    );
    missing(
      () => ({
        ...host(),
        pi: { ...pi, SessionManager: class SessionManager {} },
      }),
      /pi\.SessionManager\.open \(static method\)/,
    );
    missing(
      () => ({
        ...host(),
        pi: { ...pi, ModelRuntime: class ModelRuntime {} },
      }),
      /pi\.ModelRuntime\.create \(static method\)/,
    );
  });

  test('a missing Key field is named', () => {
    missing(
      () => ({ ...host(), tui: { ...tui, Key: {} } }),
      /tui\.Key\.escape/,
    );
  });

  test('a missing group is named', () => {
    missing(() => ({ ...host(), typebox: undefined }), /typebox/);
    assert.throws(
      () => bindHostRuntime(undefined as never),
      /expected a HostRuntime object/,
    );
  });
});

describe('version policy', () => {
  test('below the minimum is refused', () => {
    assert.throws(
      () => bindHostRuntime(withVersion('1.0.9')),
      /VERSION 1\.0\.9 is below the minimum 1\.1\.0/,
    );
    assert.throws(
      () => bindHostRuntime(withVersion('0.9.0')),
      /below the minimum/,
    );
    assert.deepEqual(getHostRuntimeInfo(), { bound: false });
  });

  test('tested versions bind without warnings', () => {
    for (const version of TESTED_HOST_VERSIONS) {
      reset();
      bindHostRuntime(withVersion(version));
      assert.deepEqual(getHostRuntimeInfo(), {
        bound: true,
        source: 'injected',
        hostVersion: version,
        testedVersions: TESTED_HOST_VERSIONS,
        warnings: [],
      });
    }
  });

  test('a newer untested version binds with a warning', () => {
    bindHostRuntime(withVersion('9.4.0'));
    const info = getHostRuntimeInfo();
    assert.ok(info.bound);
    assert.equal(info.hostVersion, '9.4.0');
    assert.equal(info.warnings.length, 1);
    assert.match(info.warnings[0], /9\.4\.0 is not among the tested/);
  });

  test('an unparseable version binds with a warning', () => {
    bindHostRuntime(withVersion('next'));
    const info = getHostRuntimeInfo();
    assert.ok(info.bound);
    assert.equal(info.hostVersion, 'next');
    assert.match(info.warnings[0], /not a recognizable version/);
  });

  test('a missing VERSION is refused', () => {
    assert.throws(
      () => bindHostRuntime(withVersion(undefined)),
      /pi\.VERSION \(string\)/,
    );
  });

  test('the info snapshot does not expose the internal list', () => {
    bindHostRuntime(withVersion('9.4.0'));
    const info = getHostRuntimeInfo();
    assert.ok(info.bound);
    (info.warnings as string[]).push('tampered');
    const again = getHostRuntimeInfo();
    assert.ok(again.bound);
    assert.equal(again.warnings.length, 1);
  });
});
