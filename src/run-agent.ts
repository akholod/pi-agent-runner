import {
  DEFAULT_PROVIDER_EXTENSIONS,
  createPiSessionFactory,
} from './session.ts';
import type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
} from './session.ts';
import type {
  RunAgentOptions,
  RunAgentResult,
  RunStatus,
  RunUsage,
} from './types.ts';

interface AssistantMessage {
  role: 'assistant';
  content?: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

type Reason = 'timed_out' | 'cancelled';

let defaultFactory: ChildSessionFactory | undefined;

const emptyUsage = (durationMs: number): RunUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
  durationMs,
});

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isAssistant = (message: unknown): message is AssistantMessage =>
  typeof message === 'object' &&
  message !== null &&
  (message as { role?: unknown }).role === 'assistant';

const messageTokens = (message: AssistantMessage) => {
  const u = message.usage;
  if (!u) return 0;
  return (
    u.totalTokens ??
    (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
  );
};

const textOf = (message: AssistantMessage) =>
  (message.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('')
    .trim();

const sumUsage = (assistants: AssistantMessage[]) => {
  const usage = emptyUsage(0);
  for (const { usage: u } of assistants) {
    if (!u) continue;
    usage.input += u.input ?? 0;
    usage.output += u.output ?? 0;
    usage.cacheRead += u.cacheRead ?? 0;
    usage.cacheWrite += u.cacheWrite ?? 0;
    usage.cost += u.cost?.total ?? 0;
  }
  return usage;
};

export const runAgent = async (
  options: RunAgentOptions,
  deps: { factory?: ChildSessionFactory } = {},
): Promise<RunAgentResult> => {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const { signal, timeoutMs, onUpdate } = options;

  if (signal?.aborted) {
    return {
      status: 'cancelled',
      value: undefined,
      usage: emptyUsage(0),
      error: 'aborted before start',
    };
  }
  if (options.result?.kind === 'structured') {
    return {
      status: 'failed',
      value: undefined,
      usage: emptyUsage(0),
      error: 'structured output is not implemented yet (T08)',
    };
  }

  const factory = deps.factory ?? (defaultFactory ??= createPiSessionFactory());
  let reason: Reason | undefined;
  let session: ChildSession | undefined;
  const stop = (why: Reason) => {
    reason ??= why;
    session?.abort().catch(() => {});
  };
  const outcome = (status: RunStatus, error: string): RunAgentResult => ({
    status,
    value: undefined,
    usage: emptyUsage(elapsed()),
    error,
  });
  const stopped = () =>
    outcome(
      reason === 'timed_out' ? 'timed_out' : 'cancelled',
      reason === 'timed_out' ? `timed out after ${timeoutMs}ms` : 'aborted',
    );

  // The timer pauses while a person answers a permission prompt (T07).
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => stop('timed_out'), timeoutMs);
  const onAbort = () => stop('cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });

  let unsubscribe: (() => void) | undefined;
  let finished = false;
  try {
    try {
      const inheritModel = !options.model || options.model === 'inherit';
      const thinking = options.thinking;
      session = await factory.create({
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
        model: inheritModel ? undefined : options.model,
        thinking: !thinking || thinking === 'inherit' ? undefined : thinking,
        extensions: options.extensions ?? 'none',
        noContextFiles: options.noContextFiles ?? true,
        noSkills: options.noSkills ?? true,
        providerExtensions:
          options.providerExtensions ?? DEFAULT_PROVIDER_EXTENSIONS,
        parent: options.parent,
      });
    } catch (error) {
      if (reason) return stopped();
      return outcome('failed', messageOf(error));
    }
    if (reason) return stopped();

    let turns = 0;
    let toolCalls = 0;
    let tokens = 0;
    let tool: string | undefined;
    const notify = () => {
      if (finished || !onUpdate) return;
      try {
        onUpdate({ turn: turns, tool, tokens });
      } catch {
        // A throwing listener must not break the run.
      }
    };
    unsubscribe = session.subscribe((event: ChildEvent) => {
      if (finished) return;
      if (event.type === 'turn_start') {
        turns++;
        tool = undefined;
        notify();
      } else if (event.type === 'tool_execution_start') {
        toolCalls++;
        tool = typeof event.toolName === 'string' ? event.toolName : undefined;
        notify();
      } else if (event.type === 'message_end' && isAssistant(event.message)) {
        tokens += messageTokens(event.message);
        notify();
      }
    });

    let promptError: unknown;
    try {
      await session.prompt(options.task);
    } catch (error) {
      promptError = error;
    }

    const assistants = session.messages.filter(isAssistant);
    const last = assistants.at(-1);
    const usage = { ...sumUsage(assistants), turns, toolCalls };
    const model = session.modelId;
    const done = (
      status: RunStatus,
      value: unknown,
      error?: string,
    ): RunAgentResult => ({
      status,
      value,
      usage: { ...usage, durationMs: elapsed() },
      model,
      error,
    });

    if (reason) return done(reason, undefined, stopped().error);
    if (promptError !== undefined) {
      return done('failed', undefined, messageOf(promptError));
    }
    if (
      !last ||
      last.stopReason === 'error' ||
      last.stopReason === 'aborted' ||
      last.errorMessage
    ) {
      return done(
        'failed',
        undefined,
        last?.errorMessage ?? 'child ended without a final answer',
      );
    }
    return done('completed', textOf(last));
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    unsubscribe?.();
    try {
      await session?.dispose();
    } catch {
      // Cleanup failure must not change the outcome.
    }
  }
};
