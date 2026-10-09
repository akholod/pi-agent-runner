import type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
  ChildSpec,
} from '../src/index.ts';
import type { ParentContext } from '../src/index.ts';

/** Simple parent bus; every test gets its own so trackers stay isolated. */
export const fakeBus = (): ParentContext['events'] => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      const set = handlers.get(channel) ?? new Set();
      for (const h of [...set]) h(data);
    },
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set();
      handlers.set(channel, set);
      set.add(handler);
      return () => set.delete(handler);
    },
  };
};

export const fakeParent = (
  events = fakeBus(),
): ParentContext & { events: ParentContext['events'] } => ({
  events,
  ctx: {} as ParentContext['ctx'],
});

export const parent: ParentContext = fakeParent();

const noop = () => Promise.resolve();

export class FakeSession implements ChildSession {
  sessionId = 'child-1';
  modelId: string | undefined = 'fake/model';
  messages: unknown[] = [];
  aborts = 0;
  disposes = 0;
  disposeError: Error | undefined;
  promptError: Error | undefined;
  /** Runs inside prompt(); resolve it to end the run. */
  script: (session: FakeSession, prompt: number) => Promise<void> = noop;
  /** Every text passed to prompt(), in order. */
  prompts: string[] = [];
  /** Set by the factory helper: the spec the session was created with. */
  spec: ChildSpec | undefined;
  /** Set by the factory helper: the spec's tool-start callback. */
  onToolCall: ChildSpec['onToolCall'];
  private listeners = new Set<(e: ChildEvent) => void>();

  subscribe(listener: (e: ChildEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: ChildEvent) {
    for (const l of [...this.listeners]) l(event);
  }
  async prompt(text: string) {
    this.prompts.push(text);
    await this.script(this, this.prompts.length);
    if (this.promptError) throw this.promptError;
  }
  async abort() {
    this.aborts++;
    this.onAbort?.();
  }
  onAbort: (() => void) | undefined;
  async dispose() {
    this.disposes++;
    if (this.disposeError) throw this.disposeError;
  }
}

export const assistant = (
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 18,
    cost: { total: 0.5 },
  },
  ...extra,
});

export const factoryOf = (
  make: (spec: ChildSpec) => Promise<FakeSession>,
): ChildSessionFactory & { calls: ChildSpec[] } => {
  const calls: ChildSpec[] = [];
  return {
    calls,
    create(spec) {
      calls.push(spec);
      return make(spec).then((session) => {
        session.onToolCall = spec.onToolCall;
        session.spec = spec;
        return session;
      });
    },
  };
};

/** What the model's `submit_result` call does, as the tool would run it. */
export const submit = (session: FakeSession, value: unknown) => {
  const resultTool = session.spec?.resultTool;
  if (!resultTool) throw new Error('no resultTool in spec');
  return resultTool.onSubmit(value);
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Prompt that hangs until the fake is aborted. */
export const hangUntilAbort = (session: FakeSession) =>
  new Promise<void>((resolve) => {
    session.onAbort = resolve;
  });
