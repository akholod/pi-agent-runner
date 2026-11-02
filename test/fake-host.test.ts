/* eslint-disable class-methods-use-this -- fakes mirror SDK instance methods */
// Execution goes through the injected host. The host here is made of spies;
// the local devDependency packages are never imported as values, so a call
// that bypassed the binding would reach the real SDK and fail loudly.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  bindHostRuntime,
  createPiSessionFactory,
  builtinMcpDisabled,
  builtinMcpServers,
} from '../src/index.ts';
import type { ChildSpec, HostRuntime, ParentContext } from '../src/index.ts';
import { pickAgent, renderActivity } from '../src/agents-command.ts';
import { trackRun } from '../src/live.ts';
import type { LiveRun } from '../src/live.ts';
import { childMcpExtension } from '../src/mcp.ts';
import { buildInlineFactories, submitResultTool } from '../src/session.ts';
import { toolParameters, validator } from '../src/structured.ts';
import { renderRunsView } from '../src/view.ts';

type Call = [string, ...unknown[]];
const calls: Call[] = [];
const log = (...call: Call) => calls.push(call);
const names = () => calls.map(([name]) => name);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fake-host-'));
const agentDir = path.join(root, 'agent');
fs.mkdirSync(agentDir);
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  calls.length = 0;
});

const MODEL = { provider: 'p', id: 'm' };
const SENTINEL = { sentinel: 'session-manager' };

const fakeSession = () => ({
  sessionId: 'fake-session',
  model: MODEL,
  messages: [],
  extensionRunner: { hasHandlers: () => false, emit: async () => {} },
  bindExtensions: async () => log('session.bindExtensions'),
  subscribe: () => () => {},
  prompt: async () => {},
  abort: async () => {},
  steer: async () => {},
  followUp: async () => {},
  clearQueue: () => ({ steering: [], followUp: [] }),
  setModel: async () => {},
  setThinkingLevel: () => {},
  dispose: () => log('session.dispose'),
});

const modelRuntime = {
  registerProvider: () => {},
  registerNativeProvider: () => {},
  refresh: async () => {},
  getModel: () => MODEL,
};

let trustAnswer = true;

class FakeSettingsManager {
  static create(...args: unknown[]) {
    log('SettingsManager.create', ...args);
    return { settings: true };
  }
}
class FakePackageManager {
  constructor(options: unknown) {
    log('DefaultPackageManager', options);
  }
  async resolve() {
    return { extensions: [] };
  }
}
class FakeResourceLoader {
  options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    log('DefaultResourceLoader', options);
    this.options = options;
  }
  async reload() {
    log('loader.reload');
  }
  getExtensions() {
    return {
      runtime: {
        pendingProviderRegistrations: [],
        pendingNativeProviderRegistrations: [],
      },
    };
  }
}
class FakeModelRuntime {
  static async create() {
    log('ModelRuntime.create');
    return modelRuntime;
  }
}
class FakeSessionManager {
  static open(...args: unknown[]) {
    log('SessionManager.open', ...args);
    return SENTINEL;
  }
  static inMemory(...args: unknown[]) {
    log('SessionManager.inMemory', ...args);
    return SENTINEL;
  }
}
class FakeTrustStore {
  constructor(dir: string) {
    log('ProjectTrustStore', dir);
  }
  get(cwd: string) {
    log('ProjectTrustStore.get', cwd);
    return trustAnswer;
  }
}

const mcpExtension = () => {};
const codemodeExtension = () => {};
const unsafeResult = { unsafe: 'schema' };
const compiled = {
  Check: (value: unknown) => typeof value === 'string',
  Errors: function* errors() {
    yield { instancePath: '/x', message: 'bad' };
  },
};

// Distinct key names: the real Key values would hide a bypass.
const Key = {
  escape: 'FAKE_ESC',
  up: 'FAKE_UP',
  down: 'FAKE_DOWN',
  pageUp: 'FAKE_PGUP',
  pageDown: 'FAKE_PGDN',
};

const fakeHost = {
  pi: {
    VERSION: '1.5.0',
    getAgentDir: () => {
      log('getAgentDir');
      return agentDir;
    },
    getPackageDir: () => root,
    createEventBus: () => {
      log('createEventBus');
      return { bus: true };
    },
    resolveCliModel: (options: unknown) => {
      log('resolveCliModel', options);
      return { model: MODEL, thinkingLevel: undefined, error: undefined };
    },
    createAgentSession: async (options: unknown) => {
      log('createAgentSession', options);
      return { session: fakeSession() };
    },
    createMcpExtension: (options: unknown) => {
      log('createMcpExtension', options);
      return mcpExtension;
    },
    createCodemodeExtension: (options: unknown) => {
      log('createCodemodeExtension', options);
      return codemodeExtension;
    },
    SettingsManager: FakeSettingsManager,
    DefaultPackageManager: FakePackageManager,
    DefaultResourceLoader: FakeResourceLoader,
    ModelRuntime: FakeModelRuntime,
    SessionManager: FakeSessionManager,
    ProjectTrustStore: FakeTrustStore,
  },
  tui: {
    Key,
    matchesKey: (data: string, key: string) => {
      log('tui.matchesKey', data, key);
      return data === key;
    },
    visibleWidth: (text: string) => {
      log('tui.visibleWidth', text);
      return text.length;
    },
    truncateToWidth: (text: string, width: number) => {
      log('tui.truncateToWidth', text, width);
      return text.slice(0, width);
    },
    wrapTextWithAnsi: (text: string, width: number) => {
      log('tui.wrapTextWithAnsi', text, width);
      return [text];
    },
  },
  typebox: {
    Unsafe: (schema: unknown) => {
      log('typebox.Unsafe', schema);
      return unsafeResult;
    },
    Compile: (schema: unknown) => {
      log('typebox.Compile', schema);
      return compiled;
    },
  },
};

bindHostRuntime(fakeHost as unknown as HostRuntime);

const plain = {
  fg: (_c: string, text: string) => text,
  bold: (t: string) => t,
};

const parent = (): ParentContext =>
  ({
    events: { emit() {}, on: () => () => {} },
    ctx: {
      model: MODEL,
      thinkingLevel: 'off',
      modelRegistry: { getRegisteredProviderIds: () => [] },
      sessionManager: { getSessionId: () => 'parent-session' },
    },
  }) as unknown as ParentContext;

const spec = (over: Partial<ChildSpec> = {}): ChildSpec => ({
  cwd: root,
  systemPrompt: 'sys',
  model: 'p/m',
  extensions: 'none',
  noContextFiles: true,
  noSkills: true,
  providerExtensions: {},
  policyExtensions: [],
  parent: parent(),
  guard: { git: false, cwd: root },
  forwardAsks: false,
  ...over,
});

test('session creation runs through the injected SDK', async () => {
  const session = await createPiSessionFactory().create(spec());
  assert.equal(session.sessionId, 'fake-session');
  assert.deepEqual(
    names().filter((n) => !n.startsWith('tui.')),
    [
      'getAgentDir',
      'SettingsManager.create',
      'DefaultPackageManager',
      'createEventBus',
      'DefaultResourceLoader',
      'loader.reload',
      'ModelRuntime.create',
      'resolveCliModel',
      'SessionManager.inMemory',
      'createAgentSession',
      'session.bindExtensions',
    ],
  );
  const find = (name: string) => calls.find(([n]) => n === name);
  assert.deepEqual(find('SettingsManager.create')?.slice(1), [root, agentDir]);
  const loaderOptions = find('DefaultResourceLoader')?.[1] as Record<
    string,
    unknown
  >;
  assert.equal(loaderOptions.agentDir, agentDir);
  assert.deepEqual(loaderOptions.eventBus, { bus: true });
  const created = find('createAgentSession')?.[1] as Record<string, unknown>;
  assert.equal(created.modelRuntime, modelRuntime);
  assert.equal(created.sessionManager, SENTINEL);
  assert.ok(created.resourceLoader instanceof FakeResourceLoader);
  assert.equal(created.model, MODEL);
  await session.dispose();
  assert.ok(names().includes('session.dispose'));
});

test('a session file opens through the injected SessionManager', async () => {
  const sessionFile = path.join(root, 'child.jsonl');
  const session = await createPiSessionFactory().create(spec({ sessionFile }));
  const open = calls.find(([n]) => n === 'SessionManager.open');
  assert.deepEqual(open?.slice(1), [sessionFile, undefined, root]);
  assert.ok(!names().includes('SessionManager.inMemory'));
  await session.dispose();
});

test('the built-in MCP reads through the injected SDK', () => {
  const cwd = fs.mkdtempSync(path.join(root, 'proj-'));
  fs.mkdirSync(path.join(cwd, '.pi'));
  fs.writeFileSync(
    path.join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { files: { command: 'node' } } }),
  );
  fs.writeFileSync(
    path.join(cwd, '.pi', 'mcp.json'),
    JSON.stringify({ mcpServers: { local: { command: 'node' } } }),
  );

  trustAnswer = true;
  assert.deepEqual(
    builtinMcpServers(cwd).map((s) => s.name),
    ['files', 'local'],
  );
  assert.ok(names().includes('getAgentDir'));
  assert.deepEqual(calls.find(([n]) => n === 'ProjectTrustStore')?.slice(1), [
    agentDir,
  ]);
  assert.deepEqual(
    calls.find(([n]) => n === 'ProjectTrustStore.get')?.slice(1),
    [cwd],
  );

  trustAnswer = false;
  assert.deepEqual(
    builtinMcpServers(cwd).map((s) => s.name),
    ['files'],
  );
  assert.equal(builtinMcpDisabled(cwd), false);
});

test('the child MCP extension is built by the injected SDK', () => {
  const cwd = fs.mkdtempSync(path.join(root, 'mcp-'));
  const extension = childMcpExtension(['files']);
  assert.equal(extension, mcpExtension);
  const options = calls.find(([n]) => n === 'createMcpExtension')?.[1] as {
    loadConfig: (ctx: unknown) => {
      servers: { name: string; config: Record<string, unknown> }[];
    };
  };
  assert.equal(typeof options.loadConfig, 'function');
  const loaded = options.loadConfig({
    cwd,
    isProjectTrusted: () => false,
  });
  assert.deepEqual(
    loaded.servers.map((s) => [s.name, s.config.exposure]),
    [['files', 'direct']],
  );
  assert.ok(names().includes('getAgentDir'));
});

test('the child codemode extension is built by the injected SDK', () => {
  const base: Omit<ChildSpec, 'guard'> = {
    cwd: root,
    systemPrompt: 'sys',
    extensions: 'none',
    noContextFiles: true,
    noSkills: true,
    providerExtensions: {},
    policyExtensions: [],
    parent: {} as ParentContext,
    forwardAsks: false,
  };
  const listed = buildInlineFactories({
    ...base,
    guard: { allowedTools: ['read', 'codemode'], git: true, cwd: root },
  });
  const entry = listed.find((e) => e.name === 'pi-agent-runner:codemode');
  assert.equal(entry?.factory, codemodeExtension);
  assert.equal(entry?.replaceable, true);
  assert.ok(names().includes('createCodemodeExtension'));
});

test('result validation compiles with the injected typebox', () => {
  const schema = { type: 'string' };
  const checked = validator(schema);
  assert.equal(checked.schemaError, undefined);
  assert.deepEqual(calls.find(([n]) => n === 'typebox.Compile')?.slice(1), [
    schema,
  ]);
  assert.deepEqual(checked.validate('ok'), { ok: true });
  assert.deepEqual(checked.validate(1), { ok: false, message: '/x: bad' });
});

test('the submit_result tool schema is built by the injected Unsafe', () => {
  const schema = { type: 'string' };
  const registered: Record<string, unknown>[] = [];
  const api = {
    registerTool: (tool: Record<string, unknown>) => registered.push(tool),
  };
  submitResultTool({
    schema,
    onSubmit: () => ({ accepted: true }),
  }).factory(api as never);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].parameters, unsafeResult);
  assert.deepEqual(calls.find(([n]) => n === 'typebox.Unsafe')?.slice(1), [
    toolParameters(schema),
  ]);
});

const run = (id: string): LiveRun => ({
  id,
  name: 'agent',
  state: 'running',
  waitingForUser: false,
  turns: 0,
  toolCalls: 0,
  tokens: { input: 0, output: 0 },
  cost: 0,
  generation: 1,
  startedAt: 1000,
  lastActivityAt: 1000,
});

test('the runs view measures and clips with the injected TUI', () => {
  const lines = renderRunsView([run('r-1')], 2000, 60, plain);
  assert.ok(lines.length > 1);
  assert.ok(names().includes('tui.visibleWidth'));
  assert.ok(names().includes('tui.truncateToWidth'));
});

test('the activity view wraps and truncates with the injected TUI', () => {
  const view = renderActivity({
    run: run('r-2'),
    entries: [{ at: 1000, kind: 'text', text: 'hello there' }],
    now: 2000,
    width: 50,
    rows: 5,
    offset: 0,
    paint: plain,
  });
  assert.ok(view.lines.length > 0);
  assert.ok(names().includes('tui.wrapTextWithAnsi'));
  assert.ok(names().includes('tui.truncateToWidth'));
});

test('the activity overlay matches keys with the injected Key', async () => {
  const events = { emit() {}, on: () => () => {} };
  const tracked = trackRun({ id: 'r-3', name: 'viewer', events });
  tracked.generationStart?.();
  type Panel = {
    handleInput?(data: string): void;
    render(w: number): string[];
  };
  let panel: Panel | undefined;
  let closed = 0;
  let step = 0;
  const ctx = {
    mode: 'tui',
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        step++;
        return step === 1
          ? options.find((o) => o.includes('viewer'))
          : options.find((o) => o.startsWith('Recent activity'));
      },
      notify: () => {},
      confirm: async () => true,
      custom: async (
        factory: (...args: unknown[]) => Panel | Promise<Panel>,
      ) => {
        panel = await factory(
          { terminal: { rows: 20 }, requestRender: () => {} },
          plain,
          {},
          () => closed++,
        );
      },
    },
  };
  await pickAgent(ctx as never);
  assert.ok(panel);
  calls.length = 0;
  panel.handleInput?.('FAKE_UP');
  panel.handleInput?.('FAKE_PGDN');
  const keys = calls.filter(([n]) => n === 'tui.matchesKey').map((c) => c[2]);
  assert.ok(keys.includes(Key.escape));
  assert.ok(keys.includes(Key.up));
  assert.ok(keys.includes(Key.pageDown));
  assert.equal(closed, 0);
  panel.handleInput?.('FAKE_ESC');
  assert.equal(closed, 1);
  tracked.dispose();
});
