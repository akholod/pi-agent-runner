// Process-wide registry of child runs, for a shared TUI widget. Spiral and
// Opium each bundle their own copy of this package, so the data lives on
// globalThis and every copy reads and writes the same store.
import type { ChildEvent } from './session.ts';
import type { ParentContext, RunStatus } from './types.ts';

export type LiveState = 'starting' | 'running' | 'idle' | RunStatus;

export interface LiveRun {
  /** The child's sessionId. */
  id: string;
  parentSessionId?: string;
  /** `label.name`, default `agent`. */
  name: string;
  /** `label.context`, for example `ralph US-002`. */
  context?: string;
  /** `provider/id` the child actually resolved. */
  model?: string;
  /**
   * `starting` until the first generation, `running` during one, then the
   * generation's terminal status until the next generation starts. `idle`
   * is a startAgent handle that has not run yet.
   */
  state: LiveState;
  /** A forwarded permission prompt of this child is open. */
  waitingForUser: boolean;
  /** `timeoutMs` expired and the child was asked to wrap up. */
  wrappingUp?: boolean;
  /** Latest started, not yet ended top-level tool. */
  currentTool?: string;
  turns: number;
  toolCalls: number;
  /** Current generation; settled by the runner's own accounting at its end. */
  tokens: { input: number; output: number };
  cost: number;
  generation: number;
  /** Start of the current generation. */
  startedAt: number;
  lastActivityAt: number;
  /** Last turn_end or tool_execution_end. */
  lastStepAt?: number;
  /** End of the current generation. */
  endedAt?: number;
  error?: string;
}

export interface LiveRegistry {
  /** Snapshot copies, oldest first. */
  list(): LiveRun[];
  /** Called on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export const STUCK_AFTER_MS = 120_000;
/** A disposed run stays listed this long. */
export const EVICT_AFTER_MS = 10 * 60_000;
export const MAX_LIVE_RUNS = 200;
/** A prompt still open after this long is dropped (lost decision event). */
const PROMPT_CAP_MS = 30 * 60_000;

const STORE_KEY = Symbol.for('pi-agent-runner:live:v1');
const PROMPT_CHANNEL = 'permissions:ui_prompt';
const DECISION_CHANNEL = 'permissions:decision';

interface Prompt {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

// Kept minimal: another copy of the package may have created it.
interface Store {
  v: 1;
  runs: Map<string, LiveRun>;
  disposed: Set<string>;
  listeners: Set<() => void>;
  prompts: Map<string, Prompt>;
  buses: WeakSet<object>;
}

export const liveStore = (): Store => {
  const holder = globalThis as Record<symbol, unknown>;
  const store = (holder[STORE_KEY] ??= { v: 1 }) as Partial<Store>;
  store.runs ??= new Map();
  store.disposed ??= new Set();
  store.listeners ??= new Set();
  store.prompts ??= new Map();
  store.buses ??= new WeakSet();
  return store as Store;
};

const notify = (store: Store) => {
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch {
      // One broken listener must not starve the others.
    }
  }
};

export const liveRuns = (): LiveRegistry => {
  const store = liveStore();
  return {
    list: () =>
      [...store.runs.values()].map((run) => ({
        ...run,
        tokens: { ...run.tokens },
      })),
    subscribe(listener) {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
      };
    },
  };
};

export const isPossiblyStuck = (run: LiveRun, now: number) =>
  run.state === 'running' &&
  !run.waitingForUser &&
  now - (run.lastStepAt ?? run.startedAt) >= STUCK_AFTER_MS;

const idOf = (data: unknown, key: string) => {
  const id = (data as Record<string, unknown> | null)?.[key];
  return typeof id === 'string' ? id : undefined;
};

const setWaiting = (store: Store, sessionId: string) => {
  const run = store.runs.get(sessionId);
  if (!run) return;
  const waiting = [...store.prompts.values()].some(
    (p) => p.sessionId === sessionId,
  );
  if (run.waitingForUser === waiting) return;
  run.waitingForUser = waiting;
  notify(store);
};

// Once per bus process-wide (the WeakSet is shared between copies).
const watchPrompts = (store: Store, events: ParentContext['events']) => {
  if (store.buses.has(events)) return;
  store.buses.add(events);
  const close = (requestId: string) => {
    const prompt = store.prompts.get(requestId);
    if (!prompt) return;
    clearTimeout(prompt.timer);
    store.prompts.delete(requestId);
    setWaiting(store, prompt.sessionId);
  };
  events.on(PROMPT_CHANNEL, (data) => {
    const requestId = idOf(data, 'requestId');
    const forwarding = (data as { forwarding?: unknown } | null)?.forwarding;
    const sessionId = idOf(forwarding, 'requesterSessionId');
    if (requestId === undefined || sessionId === undefined) return;
    if (store.prompts.has(requestId)) return;
    const timer = setTimeout(() => close(requestId), PROMPT_CAP_MS);
    timer.unref();
    store.prompts.set(requestId, { sessionId, timer });
    setWaiting(store, sessionId);
  });
  events.on(DECISION_CHANNEL, (data) => {
    const requestId = idOf(data, 'requestId');
    if (requestId !== undefined) close(requestId);
  });
};

interface AssistantUsage {
  input?: number;
  output?: number;
  cost?: { total?: number };
}

const assistantUsage = (message: unknown) => {
  const m = message as { role?: unknown; usage?: AssistantUsage } | null;
  return m?.role === 'assistant' ? m.usage : undefined;
};

export interface TrackSpec {
  id: string;
  parentSessionId?: string;
  name?: string;
  context?: string;
  model?: string;
  events: ParentContext['events'];
}

export interface Tracked {
  /** startAgent handle created, nothing run yet. */
  idle(): void;
  generationStart(): void;
  /** The generation's time limit expired; the child is wrapping up. */
  wrappingUp(): void;
  /** Child event from the activity extension (or a fake in tests). */
  activity(event: ChildEvent): void;
  /** The runner's own accounting settles the counters. */
  generationEnd(
    status: RunStatus,
    usage: { input: number; output: number; cost: number },
    error?: string,
  ): void;
  /** The session is gone; the entry is dropped after EVICT_AFTER_MS. */
  dispose(): void;
}

const evict = (store: Store, id: string) => {
  store.runs.delete(id);
  store.disposed.delete(id);
};

const enforceBound = (store: Store) => {
  while (store.runs.size > MAX_LIVE_RUNS) {
    const oldest =
      [...store.runs.keys()].find((id) => store.disposed.has(id)) ??
      store.runs.keys().next().value;
    if (oldest === undefined) return;
    evict(store, oldest);
  }
};

const zero = () => ({ input: 0, output: 0, cost: 0 });

export const trackRun = (spec: TrackSpec): Tracked => {
  const store = liveStore();
  watchPrompts(store, spec.events);
  const now = Date.now();
  const run: LiveRun = {
    id: spec.id,
    parentSessionId: spec.parentSessionId,
    name: spec.name ?? 'agent',
    context: spec.context,
    model: spec.model,
    state: 'starting',
    waitingForUser: false,
    turns: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0 },
    cost: 0,
    generation: 0,
    startedAt: now,
    lastActivityAt: now,
  };
  // A reused id replaces the older entry and moves to the end.
  store.runs.delete(spec.id);
  store.disposed.delete(spec.id);
  store.runs.set(spec.id, run);
  enforceBound(store);
  setWaiting(store, spec.id);
  notify(store);

  const tools = new Map<string, string>();
  // Settled assistant messages of this generation, plus the message being
  // streamed: providers that report usage while streaming (claude-bridge)
  // show tokens before message_end.
  let settled = zero();
  let partial = zero();
  let evictTimer: ReturnType<typeof setTimeout> | undefined;

  const showTokens = () => {
    run.tokens = {
      input: settled.input + partial.input,
      output: settled.output + partial.output,
    };
    run.cost = settled.cost + partial.cost;
  };
  const latestTool = () => [...tools.values()].at(-1);
  const totalsOf = (usage: AssistantUsage) => ({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cost: usage.cost?.total ?? 0,
  });

  return {
    idle() {
      if (run.generation === 0 && run.state === 'starting') {
        run.state = 'idle';
        run.lastActivityAt = Date.now();
        notify(store);
      }
    },
    generationStart() {
      const at = Date.now();
      tools.clear();
      settled = zero();
      partial = zero();
      run.generation++;
      run.state = 'running';
      run.currentTool = undefined;
      run.wrappingUp = undefined;
      run.turns = 0;
      run.toolCalls = 0;
      run.tokens = { input: 0, output: 0 };
      run.cost = 0;
      run.startedAt = at;
      run.lastActivityAt = at;
      run.lastStepAt = undefined;
      run.endedAt = undefined;
      run.error = undefined;
      notify(store);
    },
    wrappingUp() {
      if (run.state !== 'running' || run.wrappingUp) return;
      run.wrappingUp = true;
      notify(store);
    },
    activity(event) {
      if (run.state !== 'running') return;
      const at = Date.now();
      run.lastActivityAt = at;
      const { type } = event;
      if (type === 'turn_start') {
        run.turns++;
      } else if (type === 'turn_end') {
        run.lastStepAt = at;
      } else if (type === 'tool_execution_start') {
        if (!event.parentToolCallId && typeof event.toolCallId === 'string') {
          const name = typeof event.toolName === 'string' ? event.toolName : '';
          tools.set(event.toolCallId, name || 'tool');
          run.toolCalls++;
          run.currentTool = latestTool();
        }
      } else if (type === 'tool_execution_end') {
        const id = event.toolCallId;
        if (typeof id === 'string' && tools.delete(id)) {
          run.currentTool = latestTool();
          run.lastStepAt = at;
        }
      } else if (type === 'message_update') {
        const usage = assistantUsage(event.message);
        if (usage) {
          partial = totalsOf(usage);
          showTokens();
        }
      } else if (type === 'message_end') {
        const usage = assistantUsage(event.message);
        if (usage) {
          const totals = totalsOf(usage);
          settled = {
            input: settled.input + totals.input,
            output: settled.output + totals.output,
            cost: settled.cost + totals.cost,
          };
        }
        partial = zero();
        showTokens();
      }
      notify(store);
    },
    generationEnd(status, usage, error) {
      const at = Date.now();
      tools.clear();
      run.currentTool = undefined;
      run.wrappingUp = undefined;
      run.state = status;
      run.error = error;
      run.endedAt = at;
      run.lastActivityAt = at;
      run.tokens = { input: usage.input, output: usage.output };
      run.cost = usage.cost;
      notify(store);
    },
    dispose() {
      if (store.runs.get(spec.id) !== run) return;
      store.disposed.add(spec.id);
      clearTimeout(evictTimer);
      evictTimer = setTimeout(() => {
        if (store.runs.get(spec.id) !== run) return;
        evict(store, spec.id);
        notify(store);
      }, EVICT_AFTER_MS);
      evictTimer.unref();
      notify(store);
    },
  };
};
