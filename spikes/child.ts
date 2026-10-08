// Spikes T01 + T02: nested child session from a command and a tool,
// models from extension-registered providers.
//
//   /spike-child [model] [runtime]   runtime: shared | inherit | fresh
//   tool spike_child { model?, runtime?, prompt? }
//
// Output is appended to /tmp/spike-child.log as JSON lines.
import * as fs from 'node:fs';
import * as pi from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const LOG = '/tmp/spike-child.log';
let parentEvents: ExtensionAPI['events'] | undefined;
const PERM_CHANNELS = [
  'permissions:ready',
  'permissions:ui_prompt',
  'permissions:decision',
];

type RuntimeMode = 'shared' | 'inherit' | 'fresh';

const log = (entry: Record<string, unknown>) => {
  fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
};

const handles = () =>
  (process as unknown as { _getActiveHandles(): object[] })
    ._getActiveHandles()
    .map((h) => h.constructor?.name ?? '?')
    .sort()
    .join(',');

const parentRuntime = (ctx: ExtensionContext) =>
  (ctx.modelRegistry as unknown as { runtime: pi.ModelRuntime }).runtime;

const copyProviders = (target: pi.ModelRuntime, ctx: ExtensionContext) => {
  const reg = ctx.modelRegistry;
  const copied: string[] = [];
  for (const id of new Set(reg.getRegisteredProviderIds())) {
    const native = reg.getRegisteredNativeProvider(id);
    if (native) target.registerNativeProvider(native);
    else {
      const config = reg.getRegisteredProviderConfig(id);
      if (!config) continue;
      target.registerProvider(id, config);
    }
    copied.push(id);
  }
  return copied;
};

const modelRuntimeFor = async (mode: RuntimeMode, ctx: ExtensionContext) => {
  if (mode === 'shared') return { runtime: parentRuntime(ctx), copied: [] };
  const runtime = await pi.ModelRuntime.create();
  if (mode === 'fresh') return { runtime, copied: [] };
  const copied = copyProviders(runtime, ctx);
  await runtime.refresh({ allowNetwork: false });
  return { runtime, copied };
};

const EXCLUDE = new RegExp(
  process.env.SPIKE_EXCLUDE ??
    '/(spiral|opium|pi-subagents|pi-agent-runner)(/|$)',
);

// Ambient extension paths as a `pi` process would load them, minus EXCLUDE.
const ambientPaths = async (
  cwd: string,
  agentDir: string,
  settingsManager: pi.SettingsManager,
) => {
  const pm = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await pm.resolve();
  const enabled = resolved.extensions
    .filter((r) => r.enabled)
    .map((r) => r.path);
  return {
    kept: enabled.filter((p) => !EXCLUDE.test(p)),
    dropped: enabled.filter((p) => EXCLUDE.test(p)),
  };
};

const runChild = async (
  ctx: ExtensionContext,
  opts: { model?: string; runtime?: RuntimeMode; prompt?: string },
) => {
  const mode = opts.runtime ?? 'shared';
  const before = handles();
  const started = Date.now();
  const { runtime, copied } = await modelRuntimeFor(mode, ctx);
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(ctx.cwd, agentDir);
  const ambient = process.env.SPIKE_AMBIENT;
  const extra = (process.env.SPIKE_EXT ?? '').split(',').filter(Boolean);
  let dropped: string[] = [];
  if (ambient === 'paths') {
    const a = await ambientPaths(ctx.cwd, agentDir, settingsManager);
    extra.push(...a.kept);
    const order = process.env.SPIKE_BRIDGE; // first | last
    const i = extra.findIndex((p) => p.includes('pi-claude-bridge'));
    if (order && i >= 0) {
      const [b] = extra.splice(i, 1);
      if (order === 'first') extra.unshift(b);
      else extra.push(b);
    }
    dropped = a.dropped;
  }
  const childEvents = pi.createEventBus();
  const t0 = Date.now();
  const trace: unknown[] = [];
  const mark = (what: string, data?: unknown) =>
    trace.push([Date.now() - t0, what, data]);
  const unsubs: Array<() => void> = [];
  for (const ch of PERM_CHANNELS) {
    unsubs.push(childEvents.on(ch, (d) => mark(`child-bus ${ch}`, d)));
    if (parentEvents)
      unsubs.push(parentEvents.on(ch, (d) => mark(`parent-bus ${ch}`, d)));
  }
  const loader = new pi.DefaultResourceLoader({
    eventBus: childEvents,
    extensionFactories: [
      {
        name: 'spike-trace',
        factory: (cpi: ExtensionAPI) => {
          cpi.on('tool_call', (e) => mark('tool_call', e.toolName));
          cpi.on('tool_result', (e) => mark('tool_result', e.toolName));
          // Freeze the assembled prompt for the run (pi-subagents' boundary hook
          // does this as a side effect); loads last, after every path extension.
          if (process.env.SPIKE_FREEZE === '1')
            cpi.on('before_agent_start', (e) => ({
              systemPrompt: String(e.systemPrompt),
            }));
          let n = 0;
          const dump = (tag: string, text: string) =>
            fs.writeFileSync(`/tmp/spike-prompt-${n++}-${tag}.txt`, text);
          cpi.on('before_agent_start', (e) =>
            dump('bas', String(e.systemPrompt)),
          );
          cpi.on('agent_start', (_e, c) => dump('as', c.getSystemPrompt()));
          cpi.on('turn_start', (_e, c) => dump('ts', c.getSystemPrompt()));
          cpi.on('context_with_system', (e) =>
            dump('cws', JSON.stringify(e.messages.slice(0, 1), null, 1)),
          );
        },
      },
    ],
    cwd: ctx.cwd,
    agentDir,
    settingsManager,
    noExtensions: ambient !== 'override',
    ...(ambient === 'override'
      ? {
          extensionsOverride: (base: pi.LoadExtensionsResult) => {
            dropped = base.extensions
              .map((e) => e.path)
              .filter((p) => EXCLUDE.test(p));
            return {
              ...base,
              extensions: base.extensions.filter((e) => !EXCLUDE.test(e.path)),
            };
          },
        }
      : {}),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: extra,
    systemPrompt: 'You are a terse test agent. Answer in one short line.',
  });
  // Private flag: makes the first reload clear pi's extension module cache,
  // so the child gets its own extension instances (pi-subagents does this).
  if (process.env.SPIKE_RESET !== '0')
    (loader as unknown as { loaded: boolean }).loaded = true;
  await loader.reload();
  const loaded = loader.getExtensions();
  const providerOwners = [
    ...loaded.runtime.pendingProviderRegistrations.map((r) => [
      r.name,
      r.extensionPath,
    ]),
    ...loaded.runtime.pendingNativeProviderRegistrations.map((r) => [
      r.provider.id,
      r.extensionPath,
    ]),
  ];
  let model: unknown;
  let thinkingLevel: unknown;
  if (opts.model) {
    const resolved = pi.resolveCliModel({
      cliModel: opts.model,
      modelRuntime: runtime,
    });
    if (resolved.error) throw new Error(resolved.error);
    model = resolved.model;
    thinkingLevel = resolved.thinkingLevel;
  } else {
    model = ctx.model;
    thinkingLevel = ctx.thinkingLevel;
  }
  const { session } = await pi.createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    modelRuntime: runtime,
    ...(model ? { model: model as never } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as never } : {}),
    ...(process.env.SPIKE_TOOLS
      ? { tools: process.env.SPIKE_TOOLS.split(',') }
      : ambient
        ? {}
        : { tools: ['read', 'ls'] }),
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(ctx.cwd),
    settingsManager,
    sessionStartEvent: { type: 'session_start', reason: 'startup' },
  });
  const childId = session.sessionId;
  const parentSessionId = ctx.sessionManager.getSessionId();
  const lifecycle = process.env.SPIKE_LIFECYCLE === '1';
  if (process.env.SPIKE_LIFECYCLE === 'env')
    process.env.PI_SUBAGENT_PARENT_SESSION = parentSessionId;
  if (lifecycle)
    parentEvents?.emit('subagents:child:session-created', {
      sessionId: childId,
      parentSessionId,
    });
  unsubs.push(
    session.subscribe((e) => {
      if (e.type === 'tool_execution_start' || e.type === 'tool_execution_end')
        mark(e.type, (e as { toolName?: string }).toolName);
    }),
  );
  let text = '';
  let error: string | undefined;
  let toolInfo: Record<string, unknown> = {};
  try {
    await session.bindExtensions({
      mode: 'print',
      onError: (e) =>
        log({
          extError: e.extensionPath,
          event: e.event,
          error: String(e.error),
        }),
    });
    if (lifecycle)
      parentEvents?.emit('subagents:child:bound', {
        sessionId: childId,
        parentSessionId,
      });
    const sp = session.systemPrompt ?? '';
    toolInfo = {
      extensions: loaded.extensions.map((e) => e.path),
      loadErrors: loaded.errors,
      dropped,
      providerOwners,
      allTools: session.getAllTools().map((t) => t.name),
      activeTools: session.getActiveToolNames(),
      promptChars: sp.length,
      promptHasOpium: /orchestrator|<Role>/i.test(sp),
    };
    await session.prompt(
      opts.prompt ??
        process.env.SPIKE_PROMPT ??
        'Reply with exactly: CHILD_OK <your model id>',
    );
    const last = [...session.messages]
      .reverse()
      .find((m) => (m as { role?: string }).role === 'assistant') as
      | {
          content?: Array<{ type: string; text?: string }>;
          errorMessage?: string;
        }
      | undefined;
    text = (last?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    error = last?.errorMessage;
  } finally {
    const runner = session.extensionRunner;
    if (runner.hasHandlers('session_shutdown')) {
      await Promise.race([
        runner.emit({ type: 'session_shutdown', reason: 'quit' }),
        new Promise((r) => setTimeout(r, 5000).unref()),
      ]);
    }
    session.dispose();
    if (lifecycle)
      parentEvents?.emit('subagents:child:disposed', { sessionId: childId });
    for (const u of unsubs) u();
  }
  await new Promise((r) => setTimeout(r, 200));
  const result = {
    mode,
    requested: opts.model ?? 'inherit',
    resolved: session.model
      ? `${session.model.provider}/${session.model.id}`
      : undefined,
    copied,
    text,
    error,
    ms: Date.now() - started,
    handlesBefore: before,
    handlesAfter: handles(),
    trace,
    ...toolInfo,
  };
  log(result);
  return result;
};

export default function (api: ExtensionAPI) {
  parentEvents = api.events;
  api.registerCommand('spike-child', {
    description: 'Spike: run a nested child session',
    handler: async (args, ctx) => {
      const [model, runtime] = (args ?? '').trim().split(/\s+/);
      try {
        const r = await runChild(ctx, {
          model: model && model !== '-' ? model : undefined,
          runtime: (runtime as RuntimeMode) || undefined,
        });
        ctx.ui.notify(JSON.stringify(r), 'info');
      } catch (e) {
        log({ source: 'command', fail: String(e) });
        ctx.ui.notify(String(e), 'error');
      }
    },
  });

  api.registerTool({
    name: 'spike_child',
    label: 'Spike child',
    description: 'Spike: run a nested child session and return its answer.',
    parameters: Type.Object({
      model: Type.Optional(Type.String()),
      runtime: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const r = await runChild(ctx, {
          model: params.model,
          runtime: params.runtime as RuntimeMode | undefined,
          prompt: params.prompt,
        });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ source: 'tool', ...r }) },
          ],
          details: {},
        };
      } catch (e) {
        log({ source: 'tool', fail: String(e) });
        throw e;
      }
    },
  });
}
