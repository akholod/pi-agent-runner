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
  /** `currentTool` with its short argument summary, for example `read a.ts`. */
  currentAction?: string;
  /** First line of the latest thinking block, when the model exposes it. */
  lastThought?: string;
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
  /** Absolute path of the child's session file; it may not exist yet. */
  transcriptPath?: string;
}

/** One line of a run's recent activity. */
export interface ActivityEntry {
  at: number;
  kind: 'tool' | 'error' | 'text' | 'thought' | 'generation';
  /** A single line. */
  text: string;
}

/** What the runner can do to a run that is in progress. */
export interface RunControl {
  /** Aborts the current generation; resolves once it has ended. */
  cancel(): Promise<void>;
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
/** Entries kept per run in the activity buffer. */
export const MAX_ACTIVITY = 50;
const TEXT_CHARS = 200;
const THOUGHT_CHARS = 120;
const ARG_CHARS = 200;
const JSON_ARG_CHARS = 80;
/** A prompt still open after this long is dropped (lost decision event). */
const PROMPT_CAP_MS = 30 * 60_000;

const STORE_KEY = Symbol.for('pi-agent-runner:live:v1');
const PROMPT_CHANNEL = 'permissions:ui_prompt';
const DECISION_CHANNEL = 'permissions:decision';

interface Prompt {
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

// Kept minimal: another copy of the package may have created it. A store
// from an older copy lacks `activity` and `controls`, and runs it tracked
// have neither.
interface Store {
  v: 1;
  runs: Map<string, LiveRun>;
  disposed: Set<string>;
  listeners: Set<() => void>;
  prompts: Map<string, Prompt>;
  buses: WeakSet<object>;
  activity: Map<string, ActivityEntry[]>;
  controls: Map<string, RunControl>;
}

export const liveStore = (): Store => {
  const holder = globalThis as Record<symbol, unknown>;
  const store = (holder[STORE_KEY] ??= { v: 1 }) as Partial<Store>;
  store.runs ??= new Map();
  store.disposed ??= new Set();
  store.listeners ??= new Set();
  store.prompts ??= new Map();
  store.buses ??= new WeakSet();
  store.activity ??= new Map();
  store.controls ??= new Map();
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

/** Snapshot, oldest first; undefined for a run tracked by an older copy. */
export const runActivity = (id: string): ActivityEntry[] | undefined => {
  const store = liveStore();
  const buffer = store.runs.has(id) ? store.activity.get(id) : undefined;
  return buffer && buffer.map((entry) => ({ ...entry }));
};

/** Undefined once the run is disposed, or for one an older copy tracked. */
export const runControl = (id: string): RunControl | undefined => {
  const store = liveStore();
  return store.runs.has(id) ? store.controls.get(id) : undefined;
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
  transcriptPath?: string;
  events: ParentContext['events'];
}

export interface Tracked {
  /** What the activity view may do to this run, until `dispose`. */
  control(control: RunControl): void;
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
  store.activity.delete(id);
  store.controls.delete(id);
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

// control characters would break a terminal line
const flat = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();

const clipTo = (text: string, max: number) => {
  const line = flat(text);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// 'bash' shows its command, file tools their path, the rest their arguments
const argSummary = (toolName: string, args: unknown) => {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  const file = a.path ?? a.file_path;
  const key = toolName === 'bash' ? a.command : file;
  const short = ['bash', 'read', 'edit', 'write'].includes(toolName);
  if (short && typeof key === 'string') return clipTo(key, ARG_CHARS);
  try {
    return clipTo(JSON.stringify(args) ?? '', JSON_ARG_CHARS);
  } catch {
    return '';
  }
};

const contentText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .map((item) => (item as { text?: unknown } | null)?.text)
        .filter((text): text is string => typeof text === 'string')
        .join(' ')
    : '';

const errorText = (result: unknown) => {
  if (typeof result === 'string') return result;
  const r = result as { message?: unknown; content?: unknown } | null;
  if (typeof r?.message === 'string') return r.message;
  return contentText(r?.content);
};

const assistantText = (message: unknown) => {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (m?.role !== 'assistant') return '';
  const text = flat(contentText(m.content));
  return text.length > TEXT_CHARS ? `…${text.slice(-TEXT_CHARS)}` : text;
};

// '**Planning the fix**' and '## Plan' read as plain text
const thoughtLine = (raw: string) => {
  for (const line of raw.split('\n')) {
    const plain = flat(
      line
        .replace(/^\s*(?:#{1,6}|>|[-*+])\s+/, '')
        .replace(/(\*\*|__|`)/g, '')
        .replace(/^[*_]+|[*_]+$/g, ''),
    );
    if (plain) return plain;
  }
  return '';
};

// first line of every non-empty thinking block, oldest first; redacted and
// empty blocks, and providers without thinking, give nothing
const thoughtsOf = (message: unknown) => {
  const m = message as { role?: unknown; content?: unknown } | null;
  if (m?.role !== 'assistant' || !Array.isArray(m.content)) return [];
  return m.content
    .map((block) => {
      const b = block as { type?: unknown; thinking?: unknown } | null;
      return b?.type === 'thinking' && typeof b.thinking === 'string'
        ? thoughtLine(b.thinking)
        : '';
    })
    .filter(Boolean);
};

const clipLine = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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
    transcriptPath: spec.transcriptPath,
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
  const buffer: ActivityEntry[] = [];
  store.activity.set(spec.id, buffer);
  store.controls.delete(spec.id);
  enforceBound(store);
  setWaiting(store, spec.id);
  notify(store);

  const tools = new Map<string, { name: string; action: string }>();
  const record = (kind: ActivityEntry['kind'], text: string, at: number) => {
    buffer.push({ at, kind, text });
    if (buffer.length > MAX_ACTIVITY) buffer.shift();
  };
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
  const showTool = () => {
    const latest = [...tools.values()].at(-1);
    run.currentTool = latest?.name;
    run.currentAction = latest?.action;
  };
  const totalsOf = (usage: AssistantUsage) => ({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cost: usage.cost?.total ?? 0,
  });

  return {
    control(control) {
      if (store.runs.get(spec.id) === run) store.controls.set(spec.id, control);
    },
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
      run.currentAction = undefined;
      run.lastThought = undefined;
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
      record('generation', `generation ${run.generation} started`, at);
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
          const args = argSummary(name, event.args);
          const action = args ? `${name || 'tool'} ${args}` : name || 'tool';
          tools.set(event.toolCallId, { name: name || 'tool', action });
          record('tool', action, at);
          run.toolCalls++;
          showTool();
        }
      } else if (type === 'tool_execution_end') {
        const id = event.toolCallId;
        const name = typeof id === 'string' ? tools.get(id)?.name : undefined;
        if (typeof id === 'string' && tools.delete(id)) {
          if (event.isError === true) {
            const reason = clipTo(errorText(event.result), TEXT_CHARS);
            record(
              'error',
              reason ? `${name}: ${reason}` : `${name} failed`,
              at,
            );
          }
          showTool();
          run.lastStepAt = at;
        }
      } else if (type === 'message_update') {
        const usage = assistantUsage(event.message);
        if (usage) {
          partial = totalsOf(usage);
          showTokens();
        }
        const thought = thoughtsOf(event.message).at(-1);
        if (thought) run.lastThought = clipLine(thought, THOUGHT_CHARS);
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
        const text = assistantText(event.message);
        const thoughts = thoughtsOf(event.message);
        for (const thought of thoughts) {
          record('thought', clipLine(thought, TEXT_CHARS), at);
        }
        const last = thoughts.at(-1);
        if (last) run.lastThought = clipLine(last, THOUGHT_CHARS);
        if (text) record('text', text, at);
      }
      notify(store);
    },
    generationEnd(status, usage, error) {
      const at = Date.now();
      tools.clear();
      run.currentTool = undefined;
      run.currentAction = undefined;
      run.wrappingUp = undefined;
      run.state = status;
      run.error = error;
      run.endedAt = at;
      run.lastActivityAt = at;
      run.tokens = { input: usage.input, output: usage.output };
      run.cost = usage.cost;
      const reason = error ? `: ${clipTo(error, TEXT_CHARS)}` : '';
      record(
        'generation',
        `generation ${run.generation} ${status}${reason}`,
        at,
      );
      notify(store);
    },
    dispose() {
      if (store.runs.get(spec.id) !== run) return;
      store.controls.delete(spec.id);
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
