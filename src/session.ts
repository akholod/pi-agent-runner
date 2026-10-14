// The seam between `runAgent` and Pi: `ChildSessionFactory` is injectable so
// tests script a child without the Pi runtime; the real one wraps
// `createAgentSession`. Design: spiral/docs/standalone-runner-plan.md
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pi from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { Unsafe as unsafe } from 'typebox';
import { guardDecision } from './guards.ts';
import type { GuardConfig } from './guards.ts';
import { SUBMIT_RESULT_TOOL, toolParameters } from './structured.ts';
import type { Submission } from './structured.ts';
import type { ExtensionMode, ParentContext, ThinkingLevel } from './types.ts';

export const CHANNEL_SESSION_CREATED = 'subagents:child:session-created';
export const CHANNEL_BOUND = 'subagents:child:bound';
export const CHANNEL_DISPOSED = 'subagents:child:disposed';

export interface ChildEvent {
  type: string;
  [key: string]: unknown;
}

export interface ChildSpec {
  cwd: string;
  systemPrompt: string;
  tools?: string[];
  /** `provider/id`; undefined inherits the parent's model. */
  model?: string;
  thinking?: ThinkingLevel;
  extensions: ExtensionMode;
  noContextFiles: boolean;
  noSkills: boolean;
  providerExtensions: Record<string, string>;
  /** Loaded whenever installed; see RunAgentOptions.policyExtensions. */
  policyExtensions: string[];
  /** Caller inline extensions; see RunAgentOptions.extensionFactories. */
  extensionFactories?: ExtensionFactory[];
  /**
   * Caller extension modules (default export: an ExtensionFactory); see
   * RunAgentOptions.extensionPaths.
   */
  extensionPaths?: string[];
  parent: ParentContext;
  /** Nesting depth of the code starting this child; unset = 0. */
  depth?: number;
  /** Name shown for this child (`label.name`); unset = `agent`. */
  label?: string;
  /** Persist the session to this file; unset keeps it in memory. */
  sessionFile?: string;
  /** Refusals applied to every tool call, nested ones included. */
  guard: GuardConfig;
  /** Register with the parent's pi-permission-system so asks forward. */
  forwardAsks: boolean;
  /** A top-level tool call is about to run, after every permission gate. */
  onToolCall?: (call: { toolCallId: string; toolName: string }) => void;
  /** Every lifecycle event of the child, from the activity extension. */
  onActivity?: (event: ChildEvent) => void;
  /** Registers `submit_result` in the child; the run ends on a valid call. */
  resultTool?: {
    schema: Record<string, unknown>;
    onSubmit: (value: unknown) => Submission;
  };
}

export interface ChildSession {
  readonly sessionId: string;
  readonly modelId: string | undefined;
  readonly messages: readonly unknown[];
  subscribe(listener: (event: ChildEvent) => void): () => void;
  /** Resolves when the run ends, including after abort. */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  /** Queue a message for after the current tool calls; throws if refused. */
  steer(text: string): Promise<void>;
  /** Queue a message delivered once the agent has nothing else to do. */
  followUp(text: string): Promise<void>;
  /** Drops and returns the queued, undelivered messages. */
  clearQueue(): { steering: string[]; followUp: string[] };
  /** Idempotent; shuts the child's extensions down and drops the session. */
  dispose(): Promise<void>;
}

export interface ChildSessionFactory {
  create(spec: ChildSpec): Promise<ChildSession>;
}

export interface ResolvedExtension {
  path: string;
  metadata: { source: string };
}

// Never loaded into a child, even when requested: they would recurse into
// the runner's own callers.
const DENIED_PACKAGES = [
  'pi-subagents',
  'pi-spiral',
  'pi-opium',
  'pi-agent-runner',
];
const DENIED_PATH = /\/pi_sandbox\/(spiral|opium|pi-agent-runner)\//;

// Without it a child's tool calls skip the user's permission rules, and
// `permissionAsks` has nothing to act on.
export const DEFAULT_POLICY_EXTENSIONS = ['@gotgenes/pi-permission-system'];

export const DEFAULT_PROVIDER_EXTENSIONS: Record<string, string> = {
  'claude-bridge': 'pi-claude-bridge',
};

const GUARD_NAME = 'pi-agent-runner:guard';
const GUARD_PATH = `<inline:${GUARD_NAME}>`;
const ACTIVE_AGENT_NAME = 'pi-agent-runner:active-agent';
const ACTIVE_AGENT_PATH = `<inline:${ACTIVE_AGENT_NAME}>`;
const CALLER_NAME = 'caller-extension';
const CALLER_PREFIX = `<inline:${CALLER_NAME}-`;
const TAIL_NAMES = [
  'pi-agent-runner:freeze-prompt',
  'pi-agent-runner:tool-start',
  'pi-agent-runner:activity',
  'pi-agent-runner:submit-result',
];

/**
 * Handlers run in extension order and the first block wins. The guard goes
 * first, then the caller's extensions, so both refuse before permission
 * gates can ask a person about a call that would be refused anyway. The
 * freeze and tool-start hooks go last:
 * freeze must have the final word on the prompt, and tool-start must fire
 * only after every gate passed.
 */
export const orderRunnerExtensions = <T extends { path: string }>(
  extensions: T[],
): T[] => {
  const tail = TAIL_NAMES.map((name) => `<inline:${name}>`);
  const guard = extensions.filter(
    (e) => e.path === GUARD_PATH || e.path === ACTIVE_AGENT_PATH,
  );
  const callers = extensions.filter((e) => e.path.startsWith(CALLER_PREFIX));
  const last = tail.flatMap((path) =>
    extensions.filter((e) => e.path === path),
  );
  const others = extensions.filter(
    (e) =>
      e.path !== GUARD_PATH &&
      e.path !== ACTIVE_AGENT_PATH &&
      !e.path.startsWith(CALLER_PREFIX) &&
      !tail.includes(e.path),
  );
  return [...guard, ...callers, ...others, ...last];
};

export const isFromPackage = (resource: ResolvedExtension, name: string) => {
  const { source } = resource.metadata;
  return (
    source === `npm:${name}` ||
    source.startsWith(`npm:${name}@`) ||
    resource.path.includes(`/node_modules/${name}/`)
  );
};

export const isDenied = (resource: ResolvedExtension) =>
  DENIED_PATH.test(resource.path) ||
  DENIED_PACKAGES.some((name) => isFromPackage(resource, name));

export const providerOf = (model: string | undefined) => {
  const slash = model?.indexOf('/') ?? -1;
  return model && slash > 0 ? model.slice(0, slash) : undefined;
};

/**
 * Paths to load: requested packages, the model provider's package and the
 * policy packages.
 */
export const selectExtensionPaths = (
  resources: ResolvedExtension[],
  extensions: ExtensionMode,
  providerExtensions: Record<string, string>,
  provider: string | undefined,
  policyExtensions: string[] = [],
) => {
  const wanted = new Set(extensions === 'none' ? [] : extensions.packages);
  for (const name of policyExtensions) wanted.add(name);
  const providerPackage = provider ? providerExtensions[provider] : undefined;
  if (providerPackage) wanted.add(providerPackage);
  const paths: string[] = [];
  for (const resource of resources) {
    if (isDenied(resource)) continue;
    for (const name of wanted) {
      if (!isFromPackage(resource, name)) continue;
      if (!paths.includes(resource.path)) paths.push(resource.path);
    }
  }
  return paths;
};

// Refuses calls the child must not make (see guards.ts). It is ordered
// before every other extension, so a refused call never reaches a
// permission gate and never opens a dialog.
export const guardHook = (
  spec: Pick<ChildSpec, 'guard'>,
): { name: string; factory: ExtensionFactory } => ({
  name: GUARD_NAME,
  factory: (api: ExtensionAPI) => {
    api.on('tool_call', (event) => {
      const reason = guardDecision(spec.guard, event);
      return reason ? { block: true, reason } : undefined;
    });
  },
});

/** Session entry type pi-permission-system reads the child's name from. */
export const ACTIVE_AGENT_ENTRY = 'active_agent';

/** Name in the newest `active_agent` entry, as pi-permission-system reads. */
export const latestActiveAgent = (
  entries: readonly { type: string; customType?: string; data?: unknown }[],
) => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== 'custom' || entry.customType !== ACTIVE_AGENT_ENTRY) {
      continue;
    }
    const { name } = (entry.data ?? {}) as { name?: unknown };
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
};

// pi-permission-system names a child from an `active_agent` entry in the
// child's own session: the requester shown in forwarded prompts and the
// per-agent policy file both come from it. Written at session_start, ahead
// of the first prompt or tool call; a resumed session already holding the
// same name gets no duplicate.
export const activeAgentHook = (
  spec: Pick<ChildSpec, 'label'>,
): { name: string; factory: ExtensionFactory } => ({
  name: ACTIVE_AGENT_NAME,
  factory: (api: ExtensionAPI) => {
    const name = spec.label?.trim();
    if (!name) return undefined;
    api.on('session_start', (_event, ctx) => {
      if (latestActiveAgent(ctx.sessionManager.getEntries()) === name) return;
      api.appendEntry(ACTIVE_AGENT_ENTRY, { name });
    });
  },
});

// A returned prompt is frozen for the run, so claude-bridge's prompt capture
// matches the request. Inline factories load after path extensions, which
// is what makes this the last word.
export const freezeHook: { name: string; factory: ExtensionFactory } = {
  name: 'pi-agent-runner:freeze-prompt',
  factory: (api: ExtensionAPI) => {
    api.on('before_agent_start', (event) => ({
      systemPrompt: event.systemPrompt,
    }));
  },
};

// Pi emits `tool_execution_start` before extension `tool_call` handlers
// (permission gates) run. This inline factory loads after every path
// extension, so its handler fires only once all gates have passed: the real
// start of the tool. Nested calls are covered by their parent call's timer.
export const toolStartHook = (
  spec: Pick<ChildSpec, 'onToolCall'>,
): { name: string; factory: ExtensionFactory } => ({
  name: 'pi-agent-runner:tool-start',
  factory: (api: ExtensionAPI) => {
    api.on('tool_call', (event) => {
      if (!event.parentToolCallId) {
        spec.onToolCall?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        });
      }
      return undefined;
    });
  },
});

// Events that show the child is alive. Streaming `message_update` counts as
// activity; provider_stream_event and the provider hooks are the only live
// signals some providers give before their first message ends.
export const ACTIVITY_EVENTS = [
  'agent_start',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_call',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'tool_result',
  'before_provider_request',
  'after_provider_response',
  'provider_stream_event',
] as const;

const activityHook = (
  spec: ChildSpec,
): { name: string; factory: ExtensionFactory } => ({
  name: 'pi-agent-runner:activity',
  factory: (api: ExtensionAPI) => {
    for (const type of ACTIVITY_EVENTS) {
      (api as unknown as ActivitySubscriber).on(type, (event) => {
        try {
          spec.onActivity?.({ ...(event as object), type } as ChildEvent);
        } catch {
          // A broken listener must not break the child.
        }
        return undefined;
      });
    }
  },
});

type ActivitySubscriber = {
  on(type: string, handler: (event: unknown) => unknown): void;
};

export const submitResultTool = (resultTool: {
  schema: Record<string, unknown>;
  onSubmit: (
    value: unknown,
    ctx: ExtensionContext,
  ) => Submission | Promise<Submission>;
}): { name: string; factory: ExtensionFactory } => ({
  name: 'pi-agent-runner:submit-result',
  factory: (api: ExtensionAPI) => {
    api.registerTool({
      name: SUBMIT_RESULT_TOOL,
      label: 'Submit result',
      description: 'Submit the final structured result. This ends the run.',
      exposure: 'model-only',
      parameters: unsafe<{ value: unknown }>(toolParameters(resultTool.schema)),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const submitted = await resultTool.onSubmit(params.value, ctx);
        if (!submitted.accepted) throw new Error(submitted.error);
        // No `terminate: true`: ending the loop inside the tool leaves
        // pi-claude-bridge's Claude Code query open, and its process keeps
        // the parent alive. One short closing reply ends the turn normally.
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'Result recorded. Do not call more tools; ' +
                'reply with one word: done.',
            },
          ],
          details: {},
        };
      },
    });
  },
});

// Guard and active agent first, then the caller's extensions, then the
// freeze, tool-start and activity hooks (see orderRunnerExtensions).
export const buildInlineFactories = (spec: ChildSpec) => {
  const factories = [
    guardHook(spec),
    activeAgentHook(spec),
    ...(spec.extensionFactories ?? []).map((factory, index) => ({
      name: `${CALLER_NAME}-${index}`,
      factory,
    })),
    freezeHook,
    toolStartHook(spec),
    activityHook(spec),
  ];
  if (spec.resultTool) factories.push(submitResultTool(spec.resultTool));
  return factories;
};

interface ModelTarget {
  model: pi.AgentSession['model'];
  setModel(model: NonNullable<pi.AgentSession['model']>): Promise<void>;
  setThinkingLevel(level: never): void;
}

/**
 * A resumed session file restores the model and thinking level saved in it.
 * The requested ones (explicit, or the parent's when inheriting) win.
 */
export const applyRequestedModel = async (
  session: ModelTarget,
  model: NonNullable<pi.AgentSession['model']>,
  thinkingLevel: ThinkingLevel | undefined,
) => {
  const same =
    session.model?.provider === model.provider && session.model.id === model.id;
  if (!same) await session.setModel(model);
  if (thinkingLevel !== undefined) {
    session.setThinkingLevel(thinkingLevel as never);
  }
};

type ModelRuntime = Awaited<ReturnType<typeof pi.ModelRuntime.create>>;

// Registers what the loaded extensions queued; returns the claimed ids.
const flushQueuedProviders = (
  modelRuntime: ModelRuntime,
  loader: pi.DefaultResourceLoader,
) => {
  const claimed = new Set<string>();
  const { runtime } = loader.getExtensions();
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    claimed.add(name);
    modelRuntime.registerProvider(name, config);
  }
  runtime.pendingProviderRegistrations = [];
  for (const { provider } of runtime.pendingNativeProviderRegistrations) {
    claimed.add(provider.id);
    modelRuntime.registerNativeProvider(provider);
  }
  runtime.pendingNativeProviderRegistrations = [];
  return claimed;
};

const inheritParentProviders = (
  modelRuntime: ModelRuntime,
  registry: ParentContext['ctx']['modelRegistry'],
  claimed: ReadonlySet<string>,
) => {
  let count = 0;
  for (const id of new Set(registry.getRegisteredProviderIds())) {
    if (claimed.has(id)) continue;
    const native = registry.getRegisteredNativeProvider(id);
    if (native) {
      modelRuntime.registerNativeProvider(native);
    } else {
      const config = registry.getRegisteredProviderConfig(id);
      if (!config) throw new Error(`Parent provider '${id}' has no config`);
      modelRuntime.registerProvider(id, config);
    }
    count++;
  }
  return count;
};

// Pi clears its extension module cache only when a loader reloads a second
// time; marking the loader as loaded gives each child its own instances.
const resetExtensionCacheOnReload = (loader: object) => {
  if ('loaded' in loader) (loader as { loaded: boolean }).loaded = true;
};

// One creation at a time process-wide, so concurrent children never
// interleave extension loading.
let loading: Promise<unknown> = Promise.resolve();

/**
 * Paths of the installed extensions a child loads: the requested packages,
 * the model provider's package and the policy packages. Shared by both
 * backends.
 */
export const resolveExtensionPaths = async (spec: ChildSpec) => {
  const { cwd, parent } = spec;
  const agentDir = pi.getAgentDir();
  const settingsManager = pi.SettingsManager.create(cwd, agentDir);
  const packageManager = new pi.DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve();
  const enabled = resolved.extensions.filter((r) => r.enabled);
  const provider = spec.model
    ? providerOf(spec.model)
    : parent.ctx.model?.provider;
  return {
    agentDir,
    settingsManager,
    paths: selectExtensionPaths(
      enabled,
      spec.extensions,
      spec.providerExtensions,
      provider,
      spec.policyExtensions,
    ),
  };
};

/** Absolute module paths of `extensionPaths`, relative ones against cwd. */
export const absoluteExtensionPaths = (spec: ChildSpec) =>
  (spec.extensionPaths ?? []).map((p) => path.resolve(spec.cwd, p));

const importExtensionFactories = async (spec: ChildSpec) => {
  const factories: ExtensionFactory[] = [];
  for (const file of absoluteExtensionPaths(spec)) {
    const loaded = (await import(pathToFileURL(file).href)) as {
      default?: unknown;
    };
    if (typeof loaded.default !== 'function') {
      throw new Error(`extension module ${file} has no default factory`);
    }
    factories.push(loaded.default as ExtensionFactory);
  }
  return factories;
};

const openSession = async (
  spec: ChildSpec,
  shutdownTimeoutMs: number,
): Promise<ChildSession> => {
  const { cwd, parent } = spec;
  const {
    agentDir,
    settingsManager,
    paths: extensionPaths,
  } = await resolveExtensionPaths(spec);

  const imported = await importExtensionFactories(spec);
  const callerFactories = spec.extensionFactories ?? [];
  const inlineFactories = buildInlineFactories({
    ...spec,
    extensionFactories: [...callerFactories, ...imported],
  });

  const loader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    eventBus: pi.createEventBus(),
    noExtensions: true,
    additionalExtensionPaths: extensionPaths,
    noSkills: spec.noSkills,
    // Extensions can add skills through resources_discover despite noSkills.
    skillsOverride: spec.noSkills
      ? () => ({ skills: [], diagnostics: [] })
      : undefined,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: spec.noContextFiles,
    systemPrompt: spec.systemPrompt,
    extensionFactories: inlineFactories,
    extensionsOverride: (base) => ({
      ...base,
      extensions: orderRunnerExtensions(base.extensions),
    }),
  });
  resetExtensionCacheOnReload(loader);
  await loader.reload();

  const modelRuntime = await pi.ModelRuntime.create();
  const claimed = flushQueuedProviders(modelRuntime, loader);
  const inherited = inheritParentProviders(
    modelRuntime,
    parent.ctx.modelRegistry,
    claimed,
  );
  if (claimed.size > 0 || inherited > 0) {
    await modelRuntime.refresh({ allowNetwork: false });
  }

  let model: ReturnType<ModelRuntime['getModel']>;
  let resolvedThinking: ThinkingLevel | undefined;
  if (spec.model) {
    const cli = pi.resolveCliModel({ cliModel: spec.model, modelRuntime });
    if (cli.error) throw new Error(cli.error);
    model = cli.model;
    resolvedThinking = cli.thinkingLevel;
  } else {
    const inheritedModel = parent.ctx.model;
    if (!inheritedModel) throw new Error('Parent has no model to inherit');
    model = modelRuntime.getModel(inheritedModel.provider, inheritedModel.id);
    if (!model) {
      throw new Error(
        `Parent model ${inheritedModel.provider}/${inheritedModel.id} ` +
          'is not available in the child',
      );
    }
  }
  const thinkingLevel =
    spec.thinking ?? resolvedThinking ?? parent.ctx.thinkingLevel;

  const resumed = Boolean(spec.sessionFile && fs.existsSync(spec.sessionFile));
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    tools: spec.guard.allowedTools,
    resourceLoader: loader,
    sessionManager: spec.sessionFile
      ? pi.SessionManager.open(spec.sessionFile, undefined, cwd)
      : pi.SessionManager.inMemory(cwd),
    settingsManager,
    sessionStartEvent: { type: 'session_start', reason: 'startup' },
  });

  if (resumed && model) {
    await applyRequestedModel(session, model, thinkingLevel);
  }

  const sessionId = session.sessionId;
  const registration = {
    sessionId,
    parentSessionId: parent.ctx.sessionManager.getSessionId(),
  };
  let disposing: Promise<void> | undefined;
  const dispose = () => {
    disposing ??= (async () => {
      try {
        const runner = session.extensionRunner;
        if (runner.hasHandlers('session_shutdown')) {
          await Promise.race([
            runner.emit({ type: 'session_shutdown', reason: 'quit' }),
            new Promise((resolve) => {
              setTimeout(resolve, shutdownTimeoutMs).unref();
            }),
          ]);
        }
      } finally {
        session.dispose();
        if (spec.forwardAsks) {
          parent.events.emit(CHANNEL_DISPOSED, { sessionId });
        }
      }
    })();
    return disposing;
  };

  // The parent's permission forwarder needs to know the child before its
  // extensions start asking for things. An unregistered child decides
  // alone, and without a UI every ask becomes an immediate refusal.
  if (spec.forwardAsks) {
    parent.events.emit(CHANNEL_SESSION_CREATED, registration);
  }
  try {
    await session.bindExtensions({ mode: 'print' });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
  if (spec.forwardAsks) parent.events.emit(CHANNEL_BOUND, registration);

  return {
    sessionId,
    get modelId() {
      return session.model
        ? `${session.model.provider}/${session.model.id}`
        : undefined;
    },
    get messages() {
      return session.messages;
    },
    subscribe: (listener) =>
      session.subscribe((event) => listener(event as unknown as ChildEvent)),
    prompt: (text) => session.prompt(text),
    abort: () => session.abort(),
    steer: async (text) => {
      await session.steer(text);
    },
    followUp: async (text) => {
      await session.followUp(text);
    },
    clearQueue: () => session.clearQueue(),
    dispose,
  };
};

export const createPiSessionFactory = (
  options: { shutdownTimeoutMs?: number } = {},
): ChildSessionFactory => {
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5000;
  return {
    create(spec) {
      const opened = loading
        .catch(() => {})
        .then(() => openSession(spec, shutdownTimeoutMs));
      loading = opened;
      return opened;
    },
  };
};
