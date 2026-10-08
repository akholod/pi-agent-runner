import type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
  ChildSpec,
} from '../src/index.ts';
import type { ParentContext } from '../src/index.ts';

export const parent: ParentContext = {
  events: { emit: () => {}, on: () => () => {} },
  ctx: {} as ParentContext['ctx'],
};

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
  script: (session: FakeSession) => Promise<void> = noop;
  private listeners = new Set<(e: ChildEvent) => void>();

  subscribe(listener: (e: ChildEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: ChildEvent) {
    for (const l of [...this.listeners]) l(event);
  }
  async prompt() {
    await this.script(this);
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
      return make(spec);
    },
  };
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
