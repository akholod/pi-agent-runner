// A real Pi child (the local devDependency CLI, found through the bound
// host's getPackageDir): the generated entry points are loaded by Pi's own
// extension loader, bind the host inside the child and register their marker
// commands. No prompt is sent, so no model or credentials are involved.
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import { assertProcessBackendReady } from '../src/process-session.ts';
import { createProcessSessionFactory } from '../src/process-session.ts';
import './bind-host.ts';

const parent = {
  events: { emit() {}, on: () => () => {} },
  ctx: {
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    thinkingLevel: 'off',
    sessionManager: { getSessionId: () => 'parent' },
  },
};

const spec = (extra: object = {}) =>
  ({
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
    ...extra,
  }) as never;

test('a real child starts with the verified host CLI and binds', async () => {
  assertProcessBackendReady();
  const factory = createProcessSessionFactory({
    resolveExtensions: async () => [],
    // a hostile PATH cannot redirect the default command
    env: { PATH: '/nonexistent' },
  });
  const session = await factory.create(spec());
  assert.ok(session.sessionId);
  await session.dispose();
});

test('a child with MCP servers loads the MCP entry point too', async () => {
  const factory = createProcessSessionFactory({
    resolveExtensions: async () => [],
    env: { PATH: '/nonexistent' },
  });
  const session = await factory.create(
    spec({ mcpServers: ['none-configured'] }),
  );
  await session.dispose();
});
