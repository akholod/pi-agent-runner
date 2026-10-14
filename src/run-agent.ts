import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_POLICY_EXTENSIONS,
  DEFAULT_PROVIDER_EXTENSIONS,
  createPiSessionFactory,
} from './session.ts';
import { inheritedDepth } from './child-config.ts';
import { createProcessSessionFactory } from './process-session.ts';
import {
  SUBMIT_RESULT_TOOL,
  correctionPrompt,
  createResultCollector,
  taskWithInstructions,
  validator,
} from './structured.ts';
import { humanWaitTracker } from './human-wait.ts';
import { trackRun } from './live.ts';
import type { Tracked } from './live.ts';
import { createPausableTimer } from './timer.ts';
import type { PausableTimer } from './timer.ts';
import type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
} from './session.ts';
import type {
  AgentHandle,
  GenerationResult,
  QueueDisposition,
  RunAgentOptions,
  RunAgentResult,
  RunStatus,
  RunUsage,
  StartAgentOptions,
  TurnOptions,
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

// Spiral and Opium each load their own copy of this package, so the depth
// lives on globalThis: nesting is counted across copies.
const DEPTH_KEY = Symbol.for('pi-agent-runner:depth');
const depthStore = ((globalThis as Record<symbol, unknown>)[DEPTH_KEY] ??=
  new AsyncLocalStorage<number>()) as AsyncLocalStorage<number>;

const RECENT_OUTPUT_CHARS = 200;

let defaultFactory: ChildSessionFactory | undefined;
let processFactory: ChildSessionFactory | undefined;

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

// A startAgent refusal that runAgent maps to the result it always returned.
class StartError extends Error {
  readonly status: RunStatus;
  readonly usage: RunUsage;
  constructor(status: RunStatus, message: string, usage = emptyUsage(0)) {
    super(message);
    this.status = status;
    this.usage = usage;
  }
}

interface Limits {
  timeoutMs?: number;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
}

// Timers, human-wait pausing and the first terminal reason of one
// generation (creation included, for runAgent).
const createControl = (
  events: RunAgentOptions['parent']['events'],
  { timeoutMs, toolTimeoutMs, signal }: Limits,
) => {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let reason: { why: Reason; error: string } | undefined;
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
  const tracker = humanWaitTracker(events);
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
  const onToolEnd = (toolCallId: string) => {
    toolTimers.get(toolCallId)?.clear();
    toolTimers.delete(toolCallId);
  };

  const outcome = (status: RunStatus, error: string): RunAgentResult => ({
    status,
    value: undefined,
    usage: { ...emptyUsage(elapsed()), waitedMs: waited() },
    error,
  });

  const onAbort = () => stop('cancelled', 'aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return {
    elapsed,
    waited,
    stop,
    onToolCall,
    onToolEnd,
    outcome,
    get reason() {
      return reason;
    },
    get finished() {
      return finished;
    },
    attach(target: ChildSession) {
      session = target;
    },
    stopped: () =>
      outcome(reason?.why ?? 'cancelled', reason?.error ?? 'aborted'),
    finish() {
      clearTimers();
      stopTracking();
      finished = true;
      signal?.removeEventListener('abort', onAbort);
    },
  };
};

type Control = ReturnType<typeof createControl>;
type Collector = ReturnType<typeof createResultCollector>;

const toGenerationFailure = (error: StartError) => ({
  status: error.status,
  value: undefined,
  usage: error.usage,
  error: error.message,
});

// Creates the session and returns the handle plus what runAgent needs to
// run its single generation under the limits that already cover creation.
const open = async (
  options: StartAgentOptions,
  deps: { factory?: ChildSessionFactory },
  creationLimits?: Pick<Limits, 'timeoutMs' | 'toolTimeoutMs'>,
) => {
  const { signal } = options;
  if (signal?.aborted) {
    throw new StartError('cancelled', 'aborted before start');
  }
  // A process-backend child has no store; its parent passes the depth down.
  const current = depthStore.getStore() ?? inheritedDepth();
  const max = options.maxDepth ?? 1;
  if (current >= max) {
    throw new StartError(
      'failed',
      `nesting limit reached: depth ${current} >= maxDepth ${max}`,
    );
  }
  const backend = options.backend ?? 'in-process';
  if (backend === 'process' && options.extensionFactories?.length) {
    throw new StartError(
      'failed',
      'extensionFactories cannot cross the process boundary of the ' +
        'process backend; pass extensionPaths instead',
    );
  }
  const structured =
    options.result?.kind === 'structured' ? options.result.schema : undefined;
  const checker = structured ? validator(structured) : undefined;
  if (checker?.schemaError) throw new StartError('failed', checker.schemaError);
  if (options.resumeFrom && options.transcriptPath) {
    throw new StartError(
      'failed',
      'resumeFrom and transcriptPath are mutually exclusive',
    );
  }

  let sessionFile: string | undefined;
  if (options.resumeFrom) {
    sessionFile = path.resolve(options.cwd, options.resumeFrom);
    if (!fs.existsSync(sessionFile)) {
      throw new StartError('failed', `resume file not found: ${sessionFile}`);
    }
  } else if (options.transcriptPath) {
    // An existing file would be loaded and continued as the child's history.
    sessionFile = path.resolve(options.cwd, options.transcriptPath);
    if (fs.existsSync(sessionFile)) {
      throw new StartError(
        'failed',
        `transcript already exists: ${sessionFile}`,
      );
    }
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  }

  let factory = deps.factory;
  if (!factory && backend === 'process') {
    processFactory ??= createProcessSessionFactory();
    factory = processFactory;
  } else if (!factory) {
    defaultFactory ??= createPiSessionFactory();
    factory = defaultFactory;
  }
  const creation = createControl(options.parent.events, {
    ...creationLimits,
    signal,
  });
  let generation: { control: Control; collector?: Collector } | undefined;

  let session: ChildSession;
  // Set once the session exists; activity before that is not tracked.
  const live: { run?: Tracked } = {};
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
      policyExtensions: options.policyExtensions ?? DEFAULT_POLICY_EXTENSIONS,
      extensionFactories: options.extensionFactories,
      extensionPaths: options.extensionPaths,
      parent: options.parent,
      depth: current,
      label: options.label?.name,
      sessionFile,
      guard: {
        allowedTools:
          options.tools && structured
            ? [...new Set([...options.tools, SUBMIT_RESULT_TOOL])]
            : options.tools,
        git: options.gitGuard ?? true,
        readRoots: options.readRoots,
        cwd: options.cwd,
      },
      forwardAsks: options.permissionAsks !== 'deny',
      // Bound once; both delegate to the generation running right now.
      onToolCall: (call) => generation?.control.onToolCall(call),
      onActivity: (event) => live.run?.activity(event),
      resultTool: structured
        ? {
            schema: structured,
            onSubmit: (value) => {
              const gen = generation;
              if (!gen?.collector) {
                return { accepted: false, error: 'no run in progress' };
              }
              if (gen.control.finished || gen.control.reason) {
                return { accepted: false, error: 'the run has ended' };
              }
              const submitted = gen.collector.submit(value);
              if (gen.collector.invalidCount >= MAX_INVALID) {
                gen.control.stop(
                  'structured_output_failed',
                  `invalid result: ${gen.collector.lastError}`,
                );
              }
              return submitted;
            },
          }
        : undefined,
    });
  } catch (error) {
    creation.finish();
    const { reason } = creation;
    throw new StartError(
      reason?.why ?? 'failed',
      reason?.error ?? messageOf(error),
      creation.outcome('failed', '').usage,
    );
  }
  const tracked = trackRun({
    id: session.sessionId,
    parentSessionId: options.parent.ctx.sessionManager?.getSessionId(),
    name: options.label?.name,
    context: options.label?.context,
    model: session.modelId,
    events: options.parent.events,
  });
  live.run = tracked;
  if (creation.reason) {
    creation.finish();
    tracked.generationEnd(
      creation.reason.why,
      { input: 0, output: 0, cost: 0 },
      creation.reason.error,
    );
    try {
      await session.dispose();
    } catch {
      // Cleanup failure must not change the outcome.
    }
    tracked.dispose();
    throw new StartError(
      creation.reason.why,
      creation.reason.error,
      creation.outcome('failed', '').usage,
    );
  }
  if (!creationLimits) creation.finish();

  type State = AgentHandle['state'];
  let state: State = 'idle';
  let running: Promise<unknown> | undefined;
  let disposing: Promise<void> | undefined;
  // Messages already accounted for by earlier generations or a resumed file.
  let seen = options.resumeFrom ? session.messages.length : 0;

  const generate = async (
    task: string,
    turn: TurnOptions,
    control: Control,
  ): Promise<GenerationResult> => {
    const collector =
      structured && checker
        ? createResultCollector(structured, checker.validate)
        : undefined;
    generation = { control, collector };
    control.attach(session);
    tracked.generationStart();
    const baseline = seen;
    let unsubscribe: (() => void) | undefined;

    const execute = async (): Promise<RunAgentResult> => {
      if (control.reason) return control.stopped();

      let turns = 0;
      let toolCalls = 0;
      let tokens = 0;
      let tool: string | undefined;
      let recentOutput: string | undefined;
      const notify = () => {
        if (control.finished || !turn.onUpdate) return;
        try {
          turn.onUpdate({
            turn: turns,
            tool,
            toolCalls,
            tokens,
            durationMs: control.elapsed(),
            recentOutput,
          });
        } catch {
          // A throwing listener must not break the run.
        }
      };
      let providerError: string | undefined;
      unsubscribe = session.subscribe((event: ChildEvent) => {
        if (control.finished) return;
        if (event.type === 'turn_start') {
          turns++;
          tool = undefined;
          notify();
        } else if (event.type === 'tool_execution_start') {
          toolCalls++;
          tool =
            typeof event.toolName === 'string' ? event.toolName : undefined;
          notify();
        } else if (event.type === 'tool_execution_end') {
          if (typeof event.toolCallId === 'string') {
            control.onToolEnd(event.toolCallId);
          }
          tool = undefined;
          notify();
        } else if (event.type === 'message_end' && isAssistant(event.message)) {
          const message = event.message;
          // Pi retries a provider error after dropping the error message
          // from the context; remember it until a non-empty answer arrives
          if (message.stopReason === 'error' || message.errorMessage) {
            providerError = message.errorMessage ?? 'provider error';
          } else if ((message.content ?? []).length > 0) {
            providerError = undefined;
          }
          tokens += messageTokens(event.message);
          const text = textOf(event.message);
          if (text) recentOutput = text.slice(-RECENT_OUTPUT_CHARS);
          notify();
        }
      });

      let promptError: unknown;
      const send = async (text: string) => {
        try {
          await session.prompt(text);
        } catch (error) {
          promptError = error;
        }
      };
      await send(collector ? taskWithInstructions(task) : task);
      // One correction turn, under the same run timer.
      if (
        collector &&
        !collector.hasValue &&
        !control.reason &&
        promptError === undefined
      ) {
        await send(correctionPrompt(collector.lastError));
      }

      const assistants = session.messages.slice(baseline).filter(isAssistant);
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
        usage: {
          ...usage,
          durationMs: control.elapsed(),
          waitedMs: control.waited(),
        },
        model,
        error,
        // Pi writes the file only once the conversation has a message.
        transcriptPath:
          sessionFile && fs.existsSync(sessionFile) ? sessionFile : undefined,
      });

      // Re-read: the prompts above may have set it.
      const hit = (control as Control).reason;
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
      // an empty answer after a provider error is that error, not a result
      if (providerError !== undefined && (last.content ?? []).length === 0) {
        return done('failed', undefined, providerError);
      }
      return done('completed', textOf(last));
    };

    let result: RunAgentResult;
    const dropped: string[] = [];
    try {
      result = await execute();
      tracked.generationEnd(result.status, result.usage, result.error);
    } catch (error) {
      tracked.generationEnd(
        'failed',
        { input: 0, output: 0, cost: 0 },
        messageOf(error),
      );
      throw error;
    } finally {
      control.finish();
      unsubscribe?.();
      seen = session.messages.length;
      try {
        const left = session.clearQueue();
        dropped.push(...left.steering, ...left.followUp);
      } catch {
        // The queue is best effort; the outcome stands.
      }
    }
    return { ...result, dropped };
  };

  const runWith = (task: string, turn: TurnOptions, control: Control) => {
    state = 'running';
    const pending = depthStore
      .run(current + 1, () => generate(task, turn, control))
      .finally(() => {
        if (state === 'running') state = 'idle';
      });
    running = pending;
    return pending;
  };

  const enqueue = async (
    send: () => Promise<void>,
  ): Promise<QueueDisposition> => {
    if (state === 'disposed') return 'disposed';
    if (state === 'idle') return 'idle';
    await send();
    if (state === 'running') return 'queued';
    // The generation ended meanwhile; its queue was already cleared, so the
    // text must not leak into the next one.
    try {
      session.clearQueue();
    } catch {
      // Best effort.
    }
    return state === 'disposed' ? 'disposed' : 'idle';
  };

  const handle: AgentHandle = {
    sessionId: session.sessionId,
    get transcriptPath() {
      return sessionFile && fs.existsSync(sessionFile)
        ? sessionFile
        : undefined;
    },
    get state() {
      return state;
    },
    run(task, turn = {}) {
      if (state !== 'idle') {
        return Promise.reject(new Error(`cannot run: agent is ${state}`));
      }
      return runWith(
        task,
        turn,
        createControl(options.parent.events, {
          timeoutMs: turn.timeoutMs,
          toolTimeoutMs: turn.toolTimeoutMs,
          signal: turn.signal,
        }),
      );
    },
    steer: (text) => enqueue(() => session.steer(text)),
    followUp: (text) => enqueue(() => session.followUp(text)),
    // Resolves once the generation has ended, so run() may follow at once.
    async abort() {
      if (state !== 'running') return;
      generation?.control.stop('cancelled', 'aborted');
      await running?.catch(() => {});
    },
    dispose() {
      disposing ??= (async () => {
        const wasRunning = state === 'running';
        state = 'disposed';
        if (wasRunning) {
          generation?.control.stop('cancelled', 'aborted');
          await running?.catch(() => {});
        }
        try {
          await session.dispose();
        } catch {
          // Cleanup failure must not change the outcome.
        }
        tracked.dispose();
      })();
      return disposing;
    },
  };

  return {
    handle,
    tracked,
    runFirst: (task: string, turn: TurnOptions) =>
      runWith(task, turn, creation),
  };
};

export const startAgent = async (
  options: StartAgentOptions,
  deps: { factory?: ChildSessionFactory } = {},
): Promise<AgentHandle> => {
  const { handle, tracked } = await open(options, deps);
  tracked.idle();
  return handle;
};

export const runAgent = async (
  options: RunAgentOptions,
  deps: { factory?: ChildSessionFactory } = {},
): Promise<RunAgentResult> => {
  const { task, timeoutMs, toolTimeoutMs, onUpdate, ...rest } = options;
  let opened: Awaited<ReturnType<typeof open>>;
  try {
    opened = await open(rest, deps, { timeoutMs, toolTimeoutMs });
  } catch (error) {
    if (error instanceof StartError) return toGenerationFailure(error);
    throw error;
  }
  try {
    const { dropped: _dropped, ...result } = await opened.runFirst(task, {
      onUpdate,
    });
    return result;
  } finally {
    await opened.handle.dispose();
  }
};
