import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import { builtinMcpDisabled, builtinMcpServers } from '../src/index.ts';
import type { ChildSpec } from '../src/index.ts';
import { runAgent } from '../src/index.ts';
import {
  activeMcpServers,
  childMcpConfig,
  mcpToolPattern,
  withMcpTools,
} from '../src/mcp.ts';
import {
  createProcessSessionFactory,
  processExtensionPaths,
} from '../src/process-session.ts';
import { buildInlineFactories } from '../src/session.ts';
import { FakeSession, assistant, factoryOf, parent, sleep } from './fake.ts';

const ECHO = fileURLToPath(new URL('fixtures/mcp-echo.mjs', import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));

const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof data === 'string' ? data : JSON.stringify(data),
  );
};

// Points Pi's agent dir at a scratch dir holding `files` for one test.
const withAgentDir = async (
  files: Record<string, unknown>,
  body: (agentDir: string) => Promise<void> | void,
) => {
  const agentDir = scratch();
  for (const [name, data] of Object.entries(files)) {
    write(path.join(agentDir, name), data);
  }
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await body(agentDir);
  } finally {
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
};

const stdio = (extra: object = {}) => ({
  command: process.execPath,
  args: [ECHO],
  ...extra,
});

const spec = (extra: Partial<ChildSpec> = {}): ChildSpec => ({
  cwd: os.tmpdir(),
  systemPrompt: 'sys',
  extensions: 'none',
  noContextFiles: true,
  noSkills: true,
  providerExtensions: {},
  policyExtensions: [],
  parent,
  guard: { allowedTools: ['read'], git: true, cwd: os.tmpdir() },
  forwardAsks: true,
  ...extra,
});

test('mcpToolPattern sanitizes names like Pi', () => {
  assert.equal(mcpToolPattern('codegraph'), 'mcp__codegraph__*');
  assert.equal(mcpToolPattern('my-srv'), 'mcp__my_srv__*');
});

test('withMcpTools adds one pattern per server to an allowlist', () => {
  assert.deepEqual(withMcpTools(['read'], ['a', 'b-c', 'a']), [
    'read',
    'mcp__a__*',
    'mcp__b_c__*',
  ]);
  assert.deepEqual(withMcpTools([], ['a']), ['mcp__a__*']);
  assert.equal(withMcpTools(undefined, ['a']), undefined);
  assert.deepEqual(withMcpTools(['read'], []), ['read']);
  assert.deepEqual(withMcpTools(['read'], undefined), ['read']);
});

test('runAgent: mcpServers adds patterns to the allowlist', async () => {
  const session = new FakeSession();
  session.script = (s) => {
    s.messages.push(assistant('ok'));
    return Promise.resolve();
  };
  const factory = factoryOf(() => Promise.resolve(session));
  await runAgent(
    {
      parent,
      cwd: '/tmp',
      systemPrompt: 'sys',
      task: 'go',
      tools: ['read'],
      mcpServers: ['codegraph', 'my-srv'],
    },
    { factory },
  );
  const [created] = factory.calls;
  assert.deepEqual(created.guard.allowedTools, [
    'read',
    'mcp__codegraph__*',
    'mcp__my_srv__*',
  ]);
  assert.deepEqual(created.mcpServers, ['codegraph', 'my-srv']);
});

test('runAgent: without tools the allowlist stays open', async () => {
  const session = new FakeSession();
  const factory = factoryOf(() => Promise.resolve(session));
  await runAgent(
    { parent, cwd: '/tmp', systemPrompt: 's', task: 't', mcpServers: ['a'] },
    { factory },
  );
  assert.equal(factory.calls[0].guard.allowedTools, undefined);
});

test('builtinMcpServers reads the agent dir config', async () => {
  await withAgentDir(
    {
      'mcp.json': {
        mcpServers: {
          codegraph: stdio(),
          'my-docs': { url: 'https://example.com/mcp' },
          off: stdio({ enabled: false }),
          broken: { nothing: true },
          'bad name!': stdio(),
          legacy: { url: 'https://x.test/sse', type: 'sse' },
        },
      },
    },
    () => {
      assert.deepEqual(builtinMcpServers(), [
        { name: 'codegraph', enabled: true },
        { name: 'my-docs', enabled: true },
        { name: 'off', enabled: false },
      ]);
    },
  );
  await withAgentDir({}, () => {
    assert.deepEqual(builtinMcpServers(), []);
  });
  await withAgentDir({ 'mcp.json': '{ not json' }, () => {
    assert.deepEqual(builtinMcpServers(), []);
  });
});

test('builtinMcpServers: project config only when trusted', async () => {
  const project = scratch();
  write(path.join(project, '.pi', 'mcp.json'), {
    mcpServers: {
      local: stdio(),
      codegraph: stdio({ description: 'project one' }),
      shared: { enabled: false },
    },
  });
  await withAgentDir(
    { 'mcp.json': { mcpServers: { codegraph: stdio(), shared: stdio() } } },
    (agentDir) => {
      const names = (cwd?: string) =>
        builtinMcpServers(cwd).map((s) => `${s.name}:${s.enabled}`);
      assert.deepEqual(names(project), ['codegraph:true', 'shared:true']);
      assert.deepEqual(names(), ['codegraph:true', 'shared:true']);
      new pi.ProjectTrustStore(agentDir).set(project, true);
      assert.deepEqual(names(project), [
        'codegraph:true',
        'shared:false',
        'local:true',
      ]);
      assert.deepEqual(names(), ['codegraph:true', 'shared:true']);
    },
  );
  fs.rmSync(project, { recursive: true, force: true });
});

test('builtinMcpDisabled reads -builtin:mcp from the settings', async () => {
  await withAgentDir({}, () => {
    assert.equal(builtinMcpDisabled(), false);
  });
  await withAgentDir({ 'settings.json': { extensions: ['x.ts'] } }, () => {
    assert.equal(builtinMcpDisabled(), false);
  });
  await withAgentDir(
    { 'settings.json': { extensions: ['-builtin:mcp'] } },
    () => {
      assert.equal(builtinMcpDisabled(), true);
    },
  );
  await withAgentDir(
    { 'settings.json': { extensions: ['!builtin:*'] } },
    () => {
      assert.equal(builtinMcpDisabled(), true);
    },
  );
  await withAgentDir(
    { 'settings.json': { extensions: ['-builtin:codemode'] } },
    () => {
      assert.equal(builtinMcpDisabled(), false);
    },
  );
  await withAgentDir({ 'settings.json': '{ not json' }, () => {
    assert.equal(builtinMcpDisabled(), false);
  });
});

test('builtinMcpDisabled: a trusted project overrides', async () => {
  const project = scratch();
  write(path.join(project, '.pi', 'settings.json'), {
    extensions: ['+builtin:mcp'],
  });
  await withAgentDir(
    { 'settings.json': { extensions: ['-builtin:mcp'] } },
    (agentDir) => {
      assert.equal(builtinMcpDisabled(project), true);
      new pi.ProjectTrustStore(agentDir).set(project, true);
      assert.equal(builtinMcpDisabled(project), false);
      assert.equal(builtinMcpDisabled(), true);
    },
  );
  fs.rmSync(project, { recursive: true, force: true });
});

test('activeMcpServers: none when empty or disabled', async () => {
  await withAgentDir({}, () => {
    assert.deepEqual(activeMcpServers(undefined, '/tmp'), []);
    assert.deepEqual(activeMcpServers([], '/tmp'), []);
    assert.deepEqual(activeMcpServers(['a', 'a', 'b'], '/tmp'), ['a', 'b']);
  });
  await withAgentDir(
    { 'settings.json': { extensions: ['-builtin:mcp'] } },
    () => {
      assert.deepEqual(activeMcpServers(['a'], '/tmp'), []);
    },
  );
});

const ctx = (cwd: string, trusted = true) => ({
  cwd,
  isProjectTrusted: () => trusted,
});

test('childMcpConfig: named enabled servers, direct', async () => {
  await withAgentDir(
    {
      'mcp.json': {
        mcpServers: {
          codegraph: stdio({
            exposure: 'codemode',
            toolExposure: { a: 'codemode', b: 'hidden', c: 'direct' },
          }),
          hiddenOne: stdio({
            exposure: 'hidden',
            toolExposure: { x: 'direct' },
          }),
          deferred: stdio({ exposure: 'deferred' }),
          off: stdio({ enabled: false }),
          other: stdio(),
        },
      },
    },
    () => {
      const loaded = childMcpConfig(['codegraph', 'hiddenOne', 'off', 'gone'])(
        ctx(os.tmpdir()),
      );
      assert.deepEqual(
        loaded.servers.map((s) => s.name),
        ['codegraph', 'hiddenOne'],
      );
      const [graph, hidden] = loaded.servers.map((s) => s.config);
      assert.equal(graph.exposure, 'direct');
      assert.deepEqual(graph.toolExposure, { b: 'hidden', c: 'direct' });
      assert.equal(hidden.exposure, 'hidden');
      assert.deepEqual(hidden.toolExposure, { x: 'direct' });
      assert.equal(loaded.autoEnableCodemode, false);
      assert.deepEqual(loaded.errors, ['MCP server "gone" is not configured']);
      assert.equal(
        childMcpConfig(['deferred'])(ctx('/tmp')).servers[0].config.exposure,
        'direct',
      );
    },
  );
});

test('childMcpConfig matches names that differ in - and _', async () => {
  await withAgentDir({ 'mcp.json': { mcpServers: { 'a-b': stdio() } } }, () => {
    const loaded = childMcpConfig(['a_b'])(ctx('/tmp'));
    assert.deepEqual(
      loaded.servers.map((s) => s.name),
      ['a-b'],
    );
    assert.deepEqual(loaded.errors, []);
  });
});

test('childMcpConfig ignores the project config unless trusted', async () => {
  const project = scratch();
  write(path.join(project, '.pi', 'mcp.json'), {
    mcpServers: { local: stdio() },
  });
  await withAgentDir({}, (agentDir) => {
    const names = (trusted: boolean) =>
      childMcpConfig(['local'])(ctx(project, trusted)).servers.map(
        (s) => s.name,
      );
    assert.deepEqual(names(true), []);
    new pi.ProjectTrustStore(agentDir).set(project, true);
    assert.deepEqual(names(true), ['local']);
    // Pi's own answer for the session wins over the store.
    assert.deepEqual(names(false), []);
  });
  fs.rmSync(project, { recursive: true, force: true });
});

test('in-process: MCP extension only when asked and allowed', async () => {
  const names = (s: ChildSpec) => buildInlineFactories(s).map((e) => e.name);
  await withAgentDir({}, () => {
    assert.ok(!names(spec()).includes('pi-agent-runner:mcp'));
    assert.ok(!names(spec({ mcpServers: [] })).includes('pi-agent-runner:mcp'));
    const withMcp = buildInlineFactories(spec({ mcpServers: ['codegraph'] }));
    const mcp = withMcp.find((e) => e.name === 'pi-agent-runner:mcp');
    assert.ok(mcp);
    assert.equal(typeof mcp.factory, 'function');
    assert.equal(mcp.replaceable, true);
    // After the guard, before the freeze and tool-start hooks.
    assert.deepEqual(
      withMcp.map((e) => e.name),
      [
        'pi-agent-runner:guard',
        'pi-agent-runner:active-agent',
        'pi-agent-runner:mcp',
        'pi-agent-runner:freeze-prompt',
        'pi-agent-runner:tool-start',
        'pi-agent-runner:activity',
      ],
    );
  });
  await withAgentDir(
    { 'settings.json': { extensions: ['-builtin:mcp'] } },
    () => {
      assert.ok(
        !names(spec({ mcpServers: ['codegraph'] })).includes(
          'pi-agent-runner:mcp',
        ),
      );
    },
  );
});

test('the loader gets the MCP extension as an inline extension', async () => {
  await withAgentDir({}, async (agentDir) => {
    const cwd = scratch();
    const loader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: pi.SettingsManager.create(cwd, agentDir),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: buildInlineFactories(
        spec({ mcpServers: ['x'], cwd }),
      ),
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(
      loaded.extensions.some((e) => e.path === '<inline:pi-agent-runner:mcp>'),
    );
    assert.ok(loaded.extensions.some((e) => e.commands.has('mcp')));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

test('process: the MCP extension is loaded after the installed ones', () => {
  const plain = processExtensionPaths(spec(), ['/p.ts'], []);
  assert.ok(!plain.some((p) => /child-mcp\.[tj]s$/.test(p)));
  const withMcp = processExtensionPaths(spec(), ['/p.ts'], ['a']);
  assert.deepEqual(
    withMcp.map((p) => path.basename(p).replace(/\.[tj]s$/, '')),
    ['child-extension', 'p', 'child-mcp', 'child-extension-tail'],
  );
});

// A real Pi session with only the runner's inline factories: the child sees
// the named server's tool, directly, and the other server never starts.
test('in-process smoke: only the named MCP servers connect', async () => {
  const dir = scratch();
  const pids = {
    echo: path.join(dir, 'echo.pid'),
    other: path.join(dir, 'other.pid'),
  };
  await withAgentDir(
    {
      'mcp.json': {
        mcpServers: {
          echo: stdio({ env: { MCP_ECHO_PIDFILE: pids.echo } }),
          other: stdio({ env: { MCP_ECHO_PIDFILE: pids.other } }),
        },
      },
    },
    async (agentDir) => {
      const cwd = scratch();
      const child = spec({
        cwd,
        mcpServers: ['echo'],
        guard: {
          allowedTools: withMcpTools(['read'], ['echo']),
          git: true,
          cwd,
        },
      });
      const settingsManager = pi.SettingsManager.create(cwd, agentDir);
      const loader = new pi.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: buildInlineFactories(child),
      });
      await loader.reload();
      const modelRuntime = await pi.ModelRuntime.create();
      const { session } = await pi.createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        tools: child.guard.allowedTools,
        resourceLoader: loader,
        sessionManager: pi.SessionManager.inMemory(cwd),
        settingsManager,
      });
      try {
        await session.bindExtensions({ mode: 'print' });
        const deadline = Date.now() + 15_000;
        while (
          !session.getActiveToolNames().includes('mcp__echo__echo') &&
          Date.now() < deadline
        ) {
          await sleep(50);
        }
        const active = session.getActiveToolNames();
        assert.ok(active.includes('mcp__echo__echo'), active.join(','));
        assert.ok(!active.some((name) => name.startsWith('mcp__other__')));
        assert.ok(!active.includes('codemode'));
        const tool = session.agent.state.tools.find(
          (t) => t.name === 'mcp__echo__echo',
        );
        assert.ok(tool);
        const result = await tool.execute('call-1', { text: 'hi' });
        assert.deepEqual(result.content, [{ type: 'text', text: 'echo:hi' }]);
        assert.ok(fs.existsSync(pids.echo));
        assert.ok(!fs.existsSync(pids.other));
      } finally {
        const runner = session.extensionRunner;
        await runner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
        fs.rmSync(cwd, { recursive: true, force: true });
      }
      const pid = Number(fs.readFileSync(pids.echo, 'utf8'));
      let alive = true;
      for (let i = 0; i < 100 && alive; i++) {
        try {
          process.kill(pid, 0);
          await sleep(50);
        } catch {
          alive = false;
        }
      }
      assert.ok(!alive, 'the MCP server process ended with the session');
    },
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

const FAKE = fileURLToPath(
  new URL('fixtures/fake-pi-rpc.mjs', import.meta.url),
);

test('process: child config carries MCP servers unless off', async () => {
  const run = async (settings: object) => {
    let seen: { mcpServers?: string[] } = {};
    await withAgentDir({ 'settings.json': settings }, async () => {
      const dir = scratch();
      const copy = path.join(dir, 'config.json');
      await runAgent(
        {
          parent,
          cwd: os.tmpdir(),
          model: 'fake/model',
          systemPrompt: 'test',
          task: 'scenario:normal',
          backend: 'process',
          mcpServers: ['codegraph'],
        },
        {
          factory: createProcessSessionFactory({
            command: [process.execPath, FAKE],
            env: { FAKE_CONFIG_COPY: copy },
            resolveExtensions: () => Promise.resolve([]),
            shutdownGraceMs: 200,
            termGraceMs: 200,
            abortGraceMs: 200,
          }),
        },
      );
      seen = JSON.parse(fs.readFileSync(copy, 'utf8')) as typeof seen;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return seen;
  };
  assert.deepEqual((await run({})).mcpServers, ['codegraph']);
  assert.equal(
    (await run({ extensions: ['-builtin:mcp'] })).mcpServers,
    undefined,
  );
});
