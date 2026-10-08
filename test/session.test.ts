import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isDenied,
  isFromPackage,
  providerOf,
  selectExtensionPaths,
} from '../src/session.ts';

const res = (path: string, source: string) => ({ path, metadata: { source } });
const NM = '/home/u/.pi/npm/node_modules';
const bg = res(
  `${NM}/pi-background-tasks/index.ts`,
  'npm:pi-background-tasks@latest',
);
const bridge = res(`${NM}/pi-claude-bridge/index.ts`, 'npm:pi-claude-bridge');
const subagents = res(`${NM}/pi-subagents/index.ts`, 'npm:pi-subagents@1.0.0');
const spiral = res('/home/u/pi_sandbox/spiral/ext.ts', 'local');
const all = [bg, bridge, subagents, spiral];

test('isFromPackage matches npm source with and without version', () => {
  assert.ok(isFromPackage(bg, 'pi-background-tasks'));
  assert.ok(isFromPackage(bridge, 'pi-claude-bridge'));
  assert.ok(!isFromPackage(bg, 'pi-background'));
});

test('isFromPackage matches by node_modules path', () => {
  const r = res(`${NM}/pi-x/index.ts`, 'git:somewhere');
  assert.ok(isFromPackage(r, 'pi-x'));
  assert.ok(!isFromPackage(r, 'pi'));
});

test('isDenied covers packages and sandbox paths', () => {
  assert.ok(isDenied(subagents));
  assert.ok(isDenied(spiral));
  assert.ok(isDenied(res('/a/pi_sandbox/opium/x.ts', 'local')));
  assert.ok(isDenied(res('/a/pi_sandbox/pi-agent-runner/x.ts', 'local')));
  assert.ok(!isDenied(bg));
});

test('providerOf reads the provider of provider/id', () => {
  assert.equal(providerOf('claude-bridge/sonnet'), 'claude-bridge');
  assert.equal(providerOf('sonnet'), undefined);
  assert.equal(providerOf(undefined), undefined);
});

test('none loads nothing unless the provider has an extension', () => {
  const map = { 'claude-bridge': 'pi-claude-bridge' };
  assert.deepEqual(selectExtensionPaths(all, 'none', map, 'anthropic'), []);
  assert.deepEqual(selectExtensionPaths(all, 'none', map, 'claude-bridge'), [
    bridge.path,
  ]);
});

test('requested packages load; unknown are skipped; denied never load', () => {
  const picked = selectExtensionPaths(
    all,
    { packages: ['pi-background-tasks', 'pi-subagents', 'nope'] },
    {},
    undefined,
  );
  assert.deepEqual(picked, [bg.path]);
});

test('provider package is added to requested ones without duplicates', () => {
  const picked = selectExtensionPaths(
    all,
    { packages: ['pi-claude-bridge'] },
    { 'claude-bridge': 'pi-claude-bridge' },
    'claude-bridge',
  );
  assert.deepEqual(picked, [bridge.path]);
});

test('a denied package is not loaded even as a provider extension', () => {
  const picked = selectExtensionPaths(all, 'none', { x: 'pi-subagents' }, 'x');
  assert.deepEqual(picked, []);
});
