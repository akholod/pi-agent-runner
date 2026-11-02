// The runner may live (and the temp directory may be) under a path with a
// space, an apostrophe, `#`, `%` and a non-ASCII character. The generated
// entry points name the runner's modules by `file:` URL: they must resolve
// to the right files, and a real Pi child must be able to load them.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './bind-host.ts';

const APOSTROPHE = String.fromCharCode(39);
const ODD = `odd dir ${APOSTROPHE}q${APOSTROPHE} #1 %41 é`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-odd-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// a copy of the runner sources under the odd path
const home = path.join(root, ODD);
const copy = path.join(home, 'runner', 'dist');
fs.mkdirSync(copy, { recursive: true });
const SRC = fileURLToPath(new URL('../src', import.meta.url));
for (const name of fs.readdirSync(SRC)) {
  if (name.endsWith('.ts')) {
    fs.copyFileSync(path.join(SRC, name), path.join(copy, name));
  }
}
const oddTmp = path.join(home, 'tmp');
fs.mkdirSync(oddTmp);

const load = async () =>
  (await import(
    pathToFileURL(path.join(copy, 'process-session.ts')).href
  )) as typeof import('../src/process-session.ts');

test('generated entries name the copied modules by file URL', async () => {
  const { writeChildEntries } = await load();
  const dir = fs.mkdtempSync(path.join(oddTmp, 'entries-'));
  const entries = writeChildEntries(dir, '1.5.0');
  const targets = {
    guard: 'child-extension.ts',
    mcp: 'child-mcp.ts',
    tail: 'child-extension-tail.ts',
  };
  for (const [name, file] of Object.entries(entries)) {
    const source = fs.readFileSync(file, 'utf8');
    const urls = [...source.matchAll(/from "(file:\/\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.equal(urls.length, 2, source);
    const [runtime, target] = urls.map((url) => fileURLToPath(url));
    assert.equal(runtime, path.join(copy, 'host-runtime.ts'));
    assert.equal(
      target,
      path.join(copy, targets[name as keyof typeof targets]),
    );
    assert.ok(fs.existsSync(runtime) && fs.existsSync(target));
    // the URL is percent-encoded, not a raw path (an apostrophe is legal)
    const encoded = urls.every((url) => !/[ #é]/.test(url));
    assert.ok(encoded, urls.join());
    assert.ok(
      urls.every((url) => url.includes('%2541')),
      urls.join(),
    );
  }
});

test('a real child loads entry points from an odd runner path', async () => {
  const { createProcessSessionFactory } = await load();
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = oddTmp;
  try {
    const parent = {
      events: { emit() {}, on: () => () => {} },
      ctx: {
        model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
        thinkingLevel: 'off',
        sessionManager: { getSessionId: () => 'parent' },
      },
    };
    const session = await createProcessSessionFactory({
      resolveExtensions: async () => [],
      startTimeoutMs: 60_000,
    }).create({
      cwd: os.tmpdir(),
      systemPrompt: 'smoke',
      model: 'anthropic/claude-sonnet-4-5',
      extensions: 'none',
      noContextFiles: true,
      noSkills: true,
      providerExtensions: {},
      policyExtensions: [],
      parent,
      guard: { git: true, cwd: os.tmpdir(), allowedTools: ['read'] },
      forwardAsks: false,
    } as never);
    assert.ok(session.sessionId);
    await session.dispose();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
  // the child's per-run directory is gone (Node's own cache may remain)
  assert.deepEqual(
    fs.readdirSync(oddTmp).filter((n) => n.startsWith('pi-agent-runner-')),
    [],
  );
});
