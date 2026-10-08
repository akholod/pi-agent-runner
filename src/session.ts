// The seam between `runAgent` and Pi: `ChildSessionFactory` is injectable so
// tests script a child without the Pi runtime; the real one wraps
// `createAgentSession`. Design: spiral/docs/standalone-runner-plan.md
import * as pi from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
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
  parent: ParentContext;
  /** A top-level tool call is about to run, after every permission gate. */
  onToolCall?: (call: { toolCallId: string; toolName: string }) => void;
}

export interface ChildSession {
  readonly sessionId: string;
  readonly modelId: string | undefined;
  readonly messages: readonly unknown[];
  subscribe(listener: (event: ChildEvent) => void): () => void;
  /** Resolves when the run ends, including after abort. */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
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

export const DEFAULT_PROVIDER_EXTENSIONS: Record<string, string> = {
  'claude-bridge': 'pi-claude-bridge',
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

/** Paths to load: requested packages plus the model provider's package. */
export const selectExtensionPaths = (
  resources: ResolvedExtension[],
  extensions: ExtensionMode,
  providerExtensions: Record<string, string>,
  provider: string | undefined,
) => {
  const wanted = new Set(extensions === 'none' ? [] : extensions.packages);
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

// A returned prompt is frozen for the run, so claude-bridge's prompt capture
// matches the request. Inline factories load after path extensions, which
// is what makes this the last word.
const freezeHook: { name: string; factory: ExtensionFactory } = {
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
const toolStartHook = (
  spec: ChildSpec,
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

const openSession = async (
  spec: ChildSpec,
  shutdownTimeoutMs: number,
): Promise<ChildSession> => {
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
  const extensionPaths = selectExtensionPaths(
    enabled,
    spec.extensions,
    spec.providerExtensions,
    provider,
  );

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
    extensionFactories: [freezeHook, toolStartHook(spec)],
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

  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    tools: spec.tools,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(cwd),
    settingsManager,
    sessionStartEvent: { type: 'session_start', reason: 'startup' },
  });

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
        parent.events.emit(CHANNEL_DISPOSED, { sessionId });
      }
    })();
    return disposing;
  };

  // The parent's permission forwarder needs to know the child before its
  // extensions start asking for things.
  parent.events.emit(CHANNEL_SESSION_CREATED, registration);
  try {
    await session.bindExtensions({ mode: 'print' });
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
  parent.events.emit(CHANNEL_BOUND, registration);

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
