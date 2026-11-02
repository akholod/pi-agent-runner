// Pure host-installation lookups; no binding needed.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  HOST_PACKAGE,
  hostCliCommand,
  resolveProcessCommand,
  tuiModuleUrlFrom,
} from '../src/host-paths.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-host-paths-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (file: string, content: string | object = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
};

// A fake installation: <name>/package.json plus whatever the test adds.
const install = (name: string, manifest: object) => {
  const dir = path.join(root, name);
  write(path.join(dir, 'package.json'), manifest);
  return dir;
};

const host = (dir: string, version = '1.5.0') => ({
  getPackageDir: () => dir,
  VERSION: version,
});

const refuses = (run: () => unknown, reason: RegExp) =>
  assert.throws(run, (error: Error) => {
    assert.match(error.message, /^cannot determine the host Pi CLI: /);
    assert.match(error.message, reason);
    assert.match(error.message, /explicit command/);
    return true;
  });

test('the host CLI is node plus the installation bin.pi', () => {
  const dir = install('ok', {
    name: HOST_PACKAGE,
    version: '1.5.0',
    bin: { pi: 'dist/bundle/cli.js' },
  });
  write(path.join(dir, 'dist', 'bundle', 'cli.js'));
  assert.deepEqual(hostCliCommand(host(dir)), [
    process.execPath,
    path.join(dir, 'dist', 'bundle', 'cli.js'),
  ]);
});

test('a string bin is accepted', () => {
  const dir = install('string-bin', {
    name: HOST_PACKAGE,
    version: '1.5.0',
    bin: 'cli.js',
  });
  write(path.join(dir, 'cli.js'));
  assert.equal(hostCliCommand(host(dir))[1], path.join(dir, 'cli.js'));
});

test('another package, another version or no bin is refused', () => {
  const other = install('other', {
    name: 'something-else',
    version: '1.5.0',
    bin: { pi: 'cli.js' },
  });
  write(path.join(other, 'cli.js'));
  refuses(() => hostCliCommand(host(other)), /not @earendil-works/);

  const stale = install('stale', {
    name: HOST_PACKAGE,
    version: '1.1.0',
    bin: { pi: 'cli.js' },
  });
  write(path.join(stale, 'cli.js'));
  refuses(() => hostCliCommand(host(stale)), /version 1\.1\.0 but .* 1\.5\.0/);

  const nobin = install('nobin', { name: HOST_PACKAGE, version: '1.5.0' });
  refuses(() => hostCliCommand(host(nobin)), /no bin\.pi/);
});

test('a bin outside the installation or missing is refused', () => {
  const escape = install('escape', {
    name: HOST_PACKAGE,
    version: '1.5.0',
    bin: { pi: '../outside.js' },
  });
  write(path.join(root, 'outside.js'));
  refuses(() => hostCliCommand(host(escape)), /not a file of the host/);
  const missing = install('missing', {
    name: HOST_PACKAGE,
    version: '1.5.0',
    bin: { pi: 'nope.js' },
  });
  refuses(() => hostCliCommand(host(missing)), /not a file of the host/);
});

test('an unreadable manifest or a throwing getPackageDir is refused', () => {
  refuses(
    () => hostCliCommand(host(path.join(root, 'no-such-dir'))),
    /manifest is unreadable/,
  );
  refuses(
    () =>
      hostCliCommand({
        VERSION: '1.5.0',
        getPackageDir: () => {
          throw new Error('boom');
        },
      }),
    /boom/,
  );
});

test('an explicit command wins and needs no binding', () => {
  assert.deepEqual(resolveProcessCommand(['/bin/fake', '--x']), [
    '/bin/fake',
    '--x',
  ]);
  assert.throws(() => resolveProcessCommand([]), /`command` is empty/);
  // without an explicit command the host is required (none is bound here)
  assert.throws(() => resolveProcessCommand(), /PI_AGENT_RUNNER_HOST_UNBOUND:/);
});

test('tui: the entry comes from the nearest node_modules up the tree', () => {
  const dir = path.join(root, 'tui-a', 'lib', 'node_modules', '@x', 'host');
  write(path.join(dir, 'package.json'), {});
  const tui = path.join(root, 'tui-a', 'lib', 'node_modules');
  write(path.join(tui, '@earendil-works', 'pi-tui', 'package.json'), {
    main: 'dist/index.js',
  });
  write(path.join(tui, '@earendil-works', 'pi-tui', 'dist', 'index.js'));
  assert.equal(
    tuiModuleUrlFrom(dir),
    pathToFileURL(
      path.join(tui, '@earendil-works', 'pi-tui', 'dist', 'index.js'),
    ).href,
  );
  // a closer copy wins
  const near = path.join(dir, 'node_modules', '@earendil-works', 'pi-tui');
  write(path.join(near, 'package.json'), { main: 'main.js' });
  write(path.join(near, 'main.js'));
  assert.equal(
    tuiModuleUrlFrom(dir),
    pathToFileURL(path.join(near, 'main.js')).href,
  );
});

test('tui: exports conditions are read', () => {
  const dir = path.join(root, 'tui-b');
  const tui = path.join(dir, 'node_modules', '@earendil-works', 'pi-tui');
  write(path.join(tui, 'package.json'), {
    exports: { '.': { types: './t.d.ts', import: './esm/index.mjs' } },
  });
  write(path.join(tui, 'esm', 'index.mjs'));
  assert.equal(
    tuiModuleUrlFrom(dir),
    pathToFileURL(path.join(tui, 'esm', 'index.mjs')).href,
  );
});

test('tui: a missing package or entry file throws', () => {
  assert.throws(
    () => tuiModuleUrlFrom(path.join(root, 'tui-none')),
    /not found/,
  );
  const dir = path.join(root, 'tui-c');
  write(
    path.join(dir, 'node_modules', '@earendil-works', 'pi-tui', 'package.json'),
    { main: 'gone.js' },
  );
  assert.throws(() => tuiModuleUrlFrom(dir), /no usable entry file/);
});
