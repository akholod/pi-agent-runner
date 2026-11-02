// The default process command is the verified CLI of the host installation.
// The bound host here points getPackageDir at a fake installation whose
// bin.pi is the fake RPC child; PATH is hostile (a decoy `pi` that must
// never run).
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-host-cli-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// <root>/host: a fake Pi installation at the bound VERSION
const installDir = path.join(root, 'host');
fs.mkdirSync(path.join(installDir, 'bin'), { recursive: true });
fs.copyFileSync(FAKE, path.join(installDir, 'bin', 'pi.mjs'));
fs.writeFileSync(
  path.join(installDir, 'package.json'),
  JSON.stringify({
    name: '@earendil-works/pi-coding-agent',
    version: pi.VERSION,
    bin: { pi: 'bin/pi.mjs' },
  }),
);

// <root>/hostile-bin/pi: what a PATH lookup of `pi` would find
const hostileBin = path.join(root, 'hostile-bin');
const decoyMarker = path.join(root, 'decoy-ran');
fs.mkdirSync(hostileBin);
fs.writeFileSync(
  path.join(hostileBin, 'pi'),
  `#!/bin/sh\necho ran > '${decoyMarker}'\nexit 1\n`,
  { mode: 0o755 },
);

bindHostRuntime({
  pi: { ...pi, getPackageDir: () => installDir },
  tui,
  typebox: { Unsafe, Compile },
});

const options = (extra: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  parent: {
    events: { emit() {}, on: () => () => {} },
    ctx: {},
  } as unknown as ParentContext,
  cwd: os.tmpdir(),
  model: 'fake/model',
  systemPrompt: 'test',
  task: 'scenario:normal',
  backend: 'process',
  ...extra,
});

const factory = (env: Record<string, string>, command?: string[]) =>
  createProcessSessionFactory({
    command,
    env: { PATH: hostileBin, ...env },
    resolveExtensions: () => Promise.resolve([]),
    shutdownGraceMs: 200,
    termGraceMs: 200,
    abortGraceMs: 200,
  });

interface Seen {
  argv: string[];
  script: string;
  execPath: string;
}

const run = async (
  extra: Partial<RunAgentOptions> = {},
  command?: string[],
) => {
  const dir = fs.mkdtempSync(path.join(root, 'run-'));
  const copy = path.join(dir, 'seen.json');
  const extensions = path.join(dir, 'extensions');
  fs.mkdirSync(extensions);
  const result = await runAgent(options(extra), {
    factory: factory(
      { FAKE_ARGV_COPY: copy, FAKE_COPY_EXTENSIONS: extensions },
      command,
    ),
  });
  const seen = JSON.parse(fs.readFileSync(copy, 'utf8')) as Seen;
  return { result, seen, extensions };
};

test('the default command is the host CLI, whatever PATH holds', async () => {
  const { result, seen } = await run();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(seen.execPath, process.execPath);
  assert.equal(seen.script, path.join(installDir, 'bin', 'pi.mjs'));
  assert.equal(fs.existsSync(decoyMarker), false, 'PATH `pi` was run');
});

test('an explicit command wins over the host CLI', async () => {
  const { result, seen } = await run({}, [process.execPath, FAKE]);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(seen.script, FAKE);
});

test('the child gets generated entry points in order', async () => {
  const { seen, extensions } = await run({ mcpServers: ['files'] });
  const loaded = seen.argv.flatMap((arg, i) =>
    arg === '-e' ? [seen.argv[i + 1]] : [],
  );
  assert.deepEqual(
    loaded.map((file) => path.basename(file)),
    [
      'pi-agent-runner-guard.ts',
      'pi-agent-runner-mcp.ts',
      'pi-agent-runner-tail.ts',
    ],
  );
  assert.ok(loaded.every((file) => !file.includes('node_modules')));
  const sources = fs
    .readdirSync(extensions)
    .sort()
    .map((name) => fs.readFileSync(path.join(extensions, name), 'utf8'));
  assert.equal(sources.length, 3);
  for (const source of sources) {
    assert.match(source, /from '@earendil-works\/pi-coding-agent'/);
    assert.match(source, /from '@earendil-works\/pi-tui'/);
    assert.match(source, /from 'typebox'/);
    assert.match(source, /from 'typebox\/compile'/);
    assert.match(source, new RegExp(`EXPECTED_VERSION = "${pi.VERSION}"`));
    assert.match(source, /import \{ bindHostRuntime \} from "file:\/\//);
    assert.match(source, /import extension from "file:\/\/.*child-/);
  }
  assert.match(sources[0], /child-extension\.[tj]s"/);
  assert.match(sources[1], /child-mcp\.[tj]s"/);
  assert.match(sources[2], /child-extension-tail\.[tj]s"/);
});

test('the entry points are removed with the child', async () => {
  const { seen } = await run();
  const entry = seen.argv[seen.argv.indexOf('-e') + 1];
  assert.equal(fs.existsSync(entry), false);
});
