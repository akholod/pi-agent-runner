import {
  DEFAULT_PROVIDER_EXTENSIONS,
  createPiSessionFactory,
} from './session.ts';
import {
  correctionPrompt,
  createResultCollector,
  taskWithInstructions,
  validator,
} from './structured.ts';
import { humanWaitTracker } from './human-wait.ts';
import { createPausableTimer } from './timer.ts';
import type { PausableTimer } from './timer.ts';
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

type Reason = 'timed_out' | 'cancelled' | 'structured_output_failed';

// Invalid submissions tolerated: the first try plus one retry.
const MAX_INVALID = 2;

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
  waitedMs: 0,
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
  const { signal, timeoutMs, toolTimeoutMs, onUpdate } = options;

  if (signal?.aborted) {
    return {
      status: 'cancelled',
      value: undefined,
      usage: emptyUsage(0),
      error: 'aborted before start',
    };
  }
  const structured =
    options.result?.kind === 'structured' ? options.result.schema : undefined;
  const checker = structured ? validator(structured) : undefined;
  if (checker?.schemaError) {
    return {
      status: 'failed',
      value: undefined,
      usage: emptyUsage(0),
      error: checker.schemaError,
    };
  }
  const collector =
    structured && checker
      ? createResultCollector(structured, checker.validate)
      : undefined;

  const factory = deps.factory ?? (defaultFactory ??= createPiSessionFactory());
  let reason: { why: Reason; error: string } | undefined;
  const stopReason = () => reason;
  let session: ChildSession | undefined;
  let finished = false;

  const toolTimers = new Map<string, PausableTimer>();
  let runTimer: PausableTimer | undefined;
  const clearTimers = () => {
    runTimer?.clear();
    for (const timer of toolTimers.values()) timer.clear();
    toolTimers.clear();
  };
  const stop = (why: Reason, error: string) => {
    if (reason) return;
    reason = { why, error };
    clearTimers();
    session?.abort().catch(() => {});
  };

  // Time the run timer was held by people being asked, closed intervals
  // plus the one still open.
  let waiting = false;
  let waitedMs = 0;
  let waitStart = 0;
  const waited = () => waitedMs + (waiting ? Date.now() - waitStart : 0);
  const setWaiting = (value: boolean) => {
    if (value === waiting || finished) return;
    waiting = value;
    if (value) {
      waitStart = Date.now();
      runTimer?.pause();
      for (const timer of toolTimers.values()) timer.pause();
    } else {
      waitedMs += Date.now() - waitStart;
      runTimer?.resume();
      for (const timer of toolTimers.values()) timer.resume();
    }
  };
  const tracker = humanWaitTracker(options.parent.events);
  const stopTracking = tracker.onChange(setWaiting);
  setWaiting(tracker.waiting);

  if (timeoutMs !== undefined) {
    runTimer = createPausableTimer(timeoutMs, () =>
      stop('timed_out', `timed out after ${timeoutMs}ms`),
    );
    if (waiting) runTimer.pause();
  }

  const onToolCall = (call: { toolCallId: string; toolName: string }) => {
    if (finished || reason || toolTimeoutMs === undefined) return;
    toolTimers.get(call.toolCallId)?.clear();
    const timer = createPausableTimer(toolTimeoutMs, () =>
      stop(
        'timed_out',
        `tool '${call.toolName}' exceeded its timeout of ${toolTimeoutMs}ms`,
      ),
    );
    if (waiting) timer.pause();
    toolTimers.set(call.toolCallId, timer);
  };

  const outcome = (status: RunStatus, error: string): RunAgentResult => ({
    status,
    value: undefined,
    usage: { ...emptyUsage(elapsed()), waitedMs: waited() },
    error,
  });
  const stopped = () =>
    outcome(reason?.why ?? 'cancelled', reason?.error ?? 'aborted');

  const onAbort = () => stop('cancelled', 'aborted');
  signal?.addEventListener('abort', onAbort, { once: true });

  let unsubscribe: (() => void) | undefined;
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
        onToolCall,
        resultTool:
          structured && collector
            ? {
                schema: structured,
                onSubmit: (value) => {
                  if (finished || reason) {
                    return { accepted: false, error: 'the run has ended' };
                  }
                  const submitted = collector.submit(value);
                  if (collector.invalidCount >= MAX_INVALID) {
                    stop(
                      'structured_output_failed',
                      `invalid result: ${collector.lastError}`,
                    );
                  }
                  return submitted;
                },
              }
            : undefined,
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
      } else if (event.type === 'tool_execution_end') {
        if (typeof event.toolCallId === 'string') {
          toolTimers.get(event.toolCallId)?.clear();
          toolTimers.delete(event.toolCallId);
        }
      } else if (event.type === 'message_end' && isAssistant(event.message)) {
        tokens += messageTokens(event.message);
        notify();
      }
    });

    let promptError: unknown;
    const send = async (text: string) => {
      try {
        await session?.prompt(text);
      } catch (error) {
        promptError = error;
      }
    };
    await send(collector ? taskWithInstructions(options.task) : options.task);
    // One correction turn, under the same run timer.
    if (
      collector &&
      !collector.hasValue &&
      !reason &&
      promptError === undefined
    ) {
      await send(correctionPrompt(collector.lastError));
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
      usage: { ...usage, durationMs: elapsed(), waitedMs: waited() },
      model,
      error,
    });

    const hit = stopReason();
    if (hit) return done(hit.why, undefined, hit.error);
    if (promptError !== undefined) {
      return done('failed', undefined, messageOf(promptError));
    }
    if (collector) {
      // A trailing error message after a valid submit does not matter: the
      // result is already in hand.
      if (collector.hasValue) return done('completed', collector.value);
      const detail = collector.lastError ? `: ${collector.lastError}` : '';
      return done(
        'structured_output_failed',
        undefined,
        `no valid submit_result call${detail}`,
      );
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
    clearTimers();
    stopTracking();
    finished = true;
    signal?.removeEventListener('abort', onAbort);
    unsubscribe?.();
    try {
      await session?.dispose();
    } catch {
      // Cleanup failure must not change the outcome.
    }
  }
};
