// The `process` backend: a ChildSessionFactory that runs the child as
// `pi --mode rpc` in its own process group, so a child wedged in a tool
// that ignores abort can be killed with SIGKILL.
// Protocol: node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_ENV,
  DEPTH_ENV,
  GUARD_COMMAND,
  SUBMIT_TITLE,
  TAIL_COMMAND,
} from './child-config.ts';
import { TOOL_START_PREFIX } from './child-config.ts';
import type { ChildConfig } from './child-config.ts';
import {
  PERMISSION_DECISION_CHANNEL,
  PERMISSION_PROMPT_CHANNEL,
} from './human-wait.ts';
import {
  ACTIVITY_EVENTS,
  absoluteExtensionPaths,
  resolveExtensionPaths,
} from './session.ts';
import type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
  ChildSpec,
} from './session.ts';
import type { Submission } from './structured.ts';

export interface ProcessSessionOptions {
  /** Command that starts Pi; tests point it at a fake. Default `['pi']`. */
  command?: string[];
  /** Extra environment for the child. */
  env?: NodeJS.ProcessEnv;
  /** Extension paths for a spec; default: the installed packages asked for. */
  resolveExtensions?: (spec: ChildSpec) => Promise<string[]>;
  /** Wait for the first get_state answer. Default 30000. */
  startTimeoutMs?: number;
  /** dispose(): wait after closing stdin before SIGTERM. Default 2000. */
  shutdownGraceMs?: number;
  /** dispose(): wait after SIGTERM before SIGKILL. Default 2000. */
  termGraceMs?: number;
  /** abort(): wait for the run to end before SIGKILL. Default 5000. */
  abortGraceMs?: number;
}

// Above this a system prompt goes through a file (Pi reads a path given to
// --system-prompt) instead of one argv entry.
const MAX_INLINE_PROMPT = 32_000;
const STDERR_TAIL = 2000;
const MESSAGES_TIMEOUT_MS = 2000;

interface ArgsInput {
  /** Resolved `provider/id`. */
  model: string | undefined;
  thinking: string | undefined;
  /** Extension paths in load order, the runner's own included. */
  extensionPaths: string[];
  /** Text, or the path of a file holding it. */
  systemPrompt: string;
}

/** The `pi` arguments for a spec; pure, so it is unit-tested. */
export const buildProcessArgs = (spec: ChildSpec, input: ArgsInput) => {
  const args = ['--mode', 'rpc'];
  if (input.model) args.push('--model', input.model);
  if (input.thinking) args.push('--thinking', input.thinking);
  args.push('--system-prompt', input.systemPrompt);
  const tools = spec.guard.allowedTools;
  if (tools?.length === 0) args.push('--no-tools');
  else if (tools) args.push('--tools', tools.join(','));
  if (spec.noSkills) args.push('--no-skills');
  if (spec.noContextFiles) args.push('--no-context-files');
  args.push('--no-prompt-templates', '--no-themes');
  if (spec.sessionFile) args.push('--session', spec.sessionFile);
  else args.push('--no-session');
  args.push('--no-extensions');
  for (const file of input.extensionPaths) args.push('-e', file);
  return args;
};

const killGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
};

// Best effort for a parent that exits without disposing its children.
const livePids = new Set<number>();
let exitHooked = false;
const trackPid = (pid: number) => {
  livePids.add(pid);
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const live of livePids) killGroup(live, 'SIGKILL');
  });
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

// The runner's own extensions sit next to this module, `.ts` or `.js`.
const siblingExtension = (name: string) => {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `${name}${path.extname(self)}`);
};

interface Response {
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

interface Run {
  done: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

const openProcessSession = async (
  spec: ChildSpec,
  options: ProcessSessionOptions,
): Promise<ChildSession> => {
  const {
    command = ['pi'],
    startTimeoutMs = 30_000,
    shutdownGraceMs = 2000,
    termGraceMs = 2000,
    abortGraceMs = 5000,
  } = options;
  const { parent } = spec;

  const inherited = parent.ctx.model;
  const model =
    spec.model ?? (inherited ? `${inherited.provider}/${inherited.id}` : '');
  if (!model) throw new Error('Parent has no model to inherit');

  const resolve =
    options.resolveExtensions ??
    (async (s: ChildSpec) => (await resolveExtensionPaths(s)).paths);
  const installed = await resolve(spec);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-runner-'));
  const cleanupDir = () => fs.rmSync(dir, { recursive: true, force: true });
  let proc: ChildProcess;
  try {
    const config: ChildConfig = {
      guard: spec.guard,
      resultSchema: spec.resultTool?.schema,
    };
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    let systemPrompt = spec.systemPrompt;
    if (systemPrompt.length > MAX_INLINE_PROMPT) {
      systemPrompt = path.join(dir, 'system-prompt.md');
      fs.writeFileSync(systemPrompt, spec.systemPrompt);
    }
    const args = buildProcessArgs(spec, {
      model,
      thinking: spec.thinking ?? parent.ctx.thinkingLevel,
      systemPrompt,
      extensionPaths: [
        siblingExtension('child-extension'),
        ...absoluteExtensionPaths(spec),
        ...installed,
        siblingExtension('child-extension-tail'),
      ],
    });
    proc = spawn(command[0], [...command.slice(1), ...args], {
      cwd: spec.cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...options.env,
        [CONFIG_ENV]: configFile,
        [DEPTH_ENV]: String((spec.depth ?? 0) + 1),
      },
    });
  } catch (error) {
    cleanupDir();
    throw error;
  }
  const pid = proc.pid;
  if (pid !== undefined) trackPid(pid);

  let dead = false;
  let killedByUs = false;
  let exitText = 'child process has not started';
  let stderrTail = '';
  let mirror: unknown[] = [];
  let queue = { steering: [] as string[], followUp: [] as string[] };
  let run: Run | undefined;
  let sessionId = '';
  let modelId: string | undefined;
  const listeners = new Set<(event: ChildEvent) => void>();
  const pending = new Map<
    string,
    { resolve(r: Response): void; reject(e: Error): void }
  >();
  const dialogs = new AbortController();
  let exitResolve: () => void = () => {};
  const exited = new Promise<void>((done) => {
    exitResolve = done;
  });

  const write = (record: object) => {
    const { stdin } = proc;
    if (dead || !stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(record)}\n`);
  };
  proc.stdin?.on('error', () => {});

  let seq = 0;
  const request = (command_: object) =>
    new Promise<Response>((done, fail) => {
      if (dead) {
        fail(new Error(exitText));
        return;
      }
      const id = `r${++seq}`;
      pending.set(id, { resolve: done, reject: fail });
      write({ ...command_, id });
    });

  const endRun = () => {
    const current = run;
    run = undefined;
    current?.resolve();
  };

  const emit = (event: ChildEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break the child.
      }
    }
    if ((ACTIVITY_EVENTS as readonly string[]).includes(event.type)) {
      try {
        spec.onActivity?.(event);
      } catch {
        // Likewise.
      }
    }
  };

  const respond = (id: unknown, body: object) =>
    write({ type: 'extension_ui_response', id, ...body });

  const submitted = (request_: Record<string, unknown>): Submission => {
    if (!spec.resultTool) {
      return { accepted: false, error: 'no result tool in this run' };
    }
    try {
      const value = JSON.parse(String(request_.placeholder ?? 'null'));
      return spec.resultTool.onSubmit(value);
    } catch (error) {
      return {
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  // A dialog of the child opens in the parent's UI; the parent's timers
  // pause meanwhile, exactly as for a forwarded permission ask.
  const relay = async (message: Record<string, unknown>) => {
    const { id, method } = message;
    const ui = parent.ctx.ui;
    if (!spec.forwardAsks || !ui) {
      respond(id, { cancelled: true });
      return;
    }
    const requestId = `process:${sessionId}:${String(id)}`;
    parent.events.emit(PERMISSION_PROMPT_CHANNEL, {
      requestId,
      forwarding: { requesterSessionId: sessionId },
    });
    const title = String(message.title ?? '');
    const dialog = {
      signal: dialogs.signal,
      timeout:
        typeof message.timeout === 'number' ? message.timeout : undefined,
    };
    try {
      if (method === 'confirm') {
        const confirmed = await ui.confirm(
          title,
          String(message.message ?? ''),
          dialog,
        );
        respond(id, { confirmed });
        return;
      }
      let value: string | undefined;
      if (method === 'select') {
        value = await ui.select(title, stringsOf(message.options), dialog);
      } else if (method === 'input') {
        const placeholder = message.placeholder;
        value = await ui.input(
          title,
          typeof placeholder === 'string' ? placeholder : undefined,
          dialog,
        );
      } else {
        const prefill = message.prefill;
        value = await ui.editor(
          title,
          typeof prefill === 'string' ? prefill : undefined,
        );
      }
      respond(id, value === undefined ? { cancelled: true } : { value });
    } catch {
      respond(id, { cancelled: true });
    } finally {
      parent.events.emit(PERMISSION_DECISION_CHANNEL, { requestId });
    }
  };

  const uiRequest = (message: Record<string, unknown>) => {
    const { method } = message;
    if (method === 'notify') {
      const text = String(message.message ?? '');
      if (text.startsWith(TOOL_START_PREFIX)) {
        try {
          const call = JSON.parse(text.slice(TOOL_START_PREFIX.length));
          spec.onToolCall?.(call);
        } catch {
          // A malformed signal only costs the tool timer.
        }
        return;
      }
      const type = message.notifyType;
      parent.ctx.ui?.notify(
        `[${spec.label ?? 'agent'}] ${text}`,
        type === 'warning' || type === 'error' ? type : 'info',
      );
    } else if (method === 'input' && message.title === SUBMIT_TITLE) {
      respond(message.id, { value: JSON.stringify(submitted(message)) });
    } else if (
      ['select', 'confirm', 'input', 'editor'].includes(String(method))
    ) {
      void relay(message);
    }
  };

  const onRecord = (record: Record<string, unknown>) => {
    const { type } = record;
    if (type === 'response') {
      const waiter = pending.get(String(record.id));
      if (!waiter) return;
      pending.delete(String(record.id));
      if (record.success === false) {
        waiter.reject(new Error(String(record.error ?? 'command failed')));
      } else {
        waiter.resolve(record as unknown as Response);
      }
    } else if (type === 'extension_ui_request') {
      uiRequest(record);
    } else if (typeof type === 'string') {
      if (type === 'message_end' && record.message !== undefined) {
        mirror.push(record.message);
      } else if (type === 'queue_update') {
        queue = {
          steering: stringsOf(record.steering),
          followUp: stringsOf(record.followUp),
        };
      }
      emit(record as ChildEvent);
      if (type === 'agent_settled') endRun();
    }
  };

  let buffer = Buffer.alloc(0);
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10)) {
      const line = buffer.subarray(0, end).toString('utf8').trim();
      buffer = buffer.subarray(end + 1);
      if (!line) continue;
      try {
        const record: unknown = JSON.parse(line);
        if (isRecord(record)) onRecord(record);
      } catch {
        // Not protocol data.
      }
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });

  // Everything still waiting on the child learns it is gone.
  const finalize = () => {
    if (dead) return;
    dead = true;
    if (pid !== undefined) livePids.delete(pid);
    dialogs.abort();
    for (const waiter of pending.values()) waiter.reject(new Error(exitText));
    pending.clear();
    const current = run;
    run = undefined;
    if (killedByUs) current?.resolve();
    else current?.reject(new Error(exitText));
    exitResolve();
  };
  proc.once('error', (error) => {
    exitText = `could not start the child process: ${error.message}`;
    finalize();
  });
  proc.once('exit', (code, signal) => {
    exitText = `child process exited with code ${code} / signal ${signal}`;
    // Whatever the leader left running goes with it.
    killGroup(pid, 'SIGKILL');
    // 'close' follows once the pipes drain; do not wait on a stray holder.
    setTimeout(() => {
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      finalize();
    }, 500).unref();
  });
  proc.once('close', finalize);

  const stop = () => {
    killedByUs = true;
    // once the group is reaped its id may be reused by an unrelated process
    if (!dead) killGroup(pid, 'SIGKILL');
  };
  const startFailed = async (error: Error) => {
    stop();
    await Promise.race([exited, delay(termGraceMs)]);
    cleanupDir();
    const tail = stderrTail.trim();
    return new Error(tail ? `${error.message}: ${tail}` : error.message);
  };

  try {
    const timeout = new Promise<never>((_, fail) => {
      setTimeout(() => {
        fail(new Error(`child process did not start in ${startTimeoutMs}ms`));
      }, startTimeoutMs).unref();
    });
    const state = await Promise.race([request({ type: 'get_state' }), timeout]);
    const data = state.data ?? {};
    sessionId = String(data.sessionId ?? '');
    const modelInfo = data.model;
    if (isRecord(modelInfo)) {
      modelId = `${String(modelInfo.provider)}/${String(modelInfo.id)}`;
    }
    // Pi carries on when an extension fails to load; without the guard that
    // would be a child with no tool allowlist.
    const commands = await request({ type: 'get_commands' });
    const names = Array.isArray(commands.data?.commands)
      ? commands.data.commands.map((c) =>
          String((c as { name?: unknown }).name),
        )
      : [];
    for (const marker of [GUARD_COMMAND, TAIL_COMMAND]) {
      if (!names.some((name) => name.startsWith(marker))) {
        throw new Error(
          `the runner's child extension did not load (${marker})`,
        );
      }
    }
    const listed = await request({ type: 'get_messages' });
    mirror = Array.isArray(listed.data?.messages) ? listed.data.messages : [];
  } catch (error) {
    throw await startFailed(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  // Replaces the mirror with Pi's own list: it drops the error messages of
  // retried attempts, which the event stream cannot show.
  const refreshMessages = async () => {
    try {
      const listed = await Promise.race([
        request({ type: 'get_messages' }),
        delay(MESSAGES_TIMEOUT_MS).then(() => undefined),
      ]);
      if (listed && Array.isArray(listed.data?.messages)) {
        mirror = listed.data.messages;
      }
    } catch {
      // Keep the mirror built from the events.
    }
  };

  const waitExit = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((done) => {
      timer = setTimeout(() => done(false), ms);
    });
    const result = await Promise.race([exited.then(() => true), timedOut]);
    clearTimeout(timer);
    return result;
  };

  let disposing: Promise<void> | undefined;
  return {
    sessionId,
    modelId,
    get messages() {
      return mirror;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async prompt(text) {
      if (dead) throw new Error(exitText);
      let current!: Run;
      const done = new Promise<void>((resolveRun, rejectRun) => {
        current = {
          done: undefined as never,
          resolve: resolveRun,
          reject: rejectRun,
        };
      });
      current.done = done;
      done.catch(() => {});
      run = current;
      try {
        const sent = await request({ type: 'prompt', message: text });
        if (sent.data?.disposition === 'handled') endRun();
      } catch (error) {
        if (run === current) run = undefined;
        throw error;
      }
      await done;
      if (!dead) await refreshMessages();
    },
    async abort() {
      if (dead) return;
      const current = run;
      request({ type: 'abort' }).catch(() => {});
      if (!current) return;
      const ended = await Promise.race([
        current.done.then(
          () => true,
          () => true,
        ),
        delay(abortGraceMs).then(() => false),
      ]);
      if (ended || dead || run !== current) return;
      // Cooperative abort did not work: the whole group goes.
      stop();
      await Promise.race([exited, delay(termGraceMs)]);
    },
    async steer(text) {
      await request({ type: 'steer', message: text });
    },
    async followUp(text) {
      await request({ type: 'follow_up', message: text });
    },
    clearQueue() {
      const left = queue;
      queue = { steering: [], followUp: [] };
      request({ type: 'clear_queue' }).catch(() => {});
      return left;
    },
    dispose() {
      disposing ??= (async () => {
        killedByUs = true;
        try {
          if (!dead) {
            proc.stdin?.end();
            const closed = await waitExit(shutdownGraceMs);
            if (!closed) {
              killGroup(pid, 'SIGTERM');
              const terminated = await waitExit(termGraceMs);
              if (!terminated) {
                killGroup(pid, 'SIGKILL');
                await waitExit(termGraceMs);
              }
            }
          }
        } finally {
          finalize();
          cleanupDir();
        }
      })();
      return disposing;
    },
  };
};

export const createProcessSessionFactory = (
  options: ProcessSessionOptions = {},
): ChildSessionFactory => ({
  create: (spec) => openProcessSession(spec, options),
});
