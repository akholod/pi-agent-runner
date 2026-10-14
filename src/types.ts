import type {
  ExtensionContext,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

export const RUN_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'structured_output_failed',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type ThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Extensions loaded into the child. `none` still loads the extension of the
 * model's provider when that provider comes from an extension.
 */
export type ExtensionMode = 'none' | { packages: string[] };

export type ResultSpec =
  { kind: 'text' } | { kind: 'structured'; schema: Record<string, unknown> };

/** What the plugin hands over from its Pi session: `pi.events` and `ctx`. */
export interface ParentContext {
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
  ctx: Pick<
    ExtensionContext,
    'cwd' | 'model' | 'thinkingLevel' | 'modelRegistry' | 'sessionManager'
  > & {
    /**
     * Where a `backend: 'process'` child's dialogs (permission asks and the
     * like) open: pass the plugin's `ctx.ui`. Without it every dialog of a
     * process child is answered `cancelled` at once. Unused by the
     * in-process backend, whose asks forward through `events`.
     */
    ui?: Pick<
      ExtensionContext['ui'],
      'select' | 'confirm' | 'input' | 'editor' | 'notify'
    >;
  };
}

export interface RunAgentOptions {
  parent: ParentContext;
  cwd: string;
  /** Replaces Pi's system prompt entirely. */
  systemPrompt: string;
  /** User message that starts the run. */
  task: string;
  /** Tool allowlist; undefined keeps Pi's defaults. */
  tools?: string[];
  /** `provider/id`, or `inherit` for the parent's current model. */
  model?: string;
  thinking?: ThinkingLevel | 'inherit';
  extensions?: ExtensionMode;
  /** Default true: the child does not read AGENTS.md and the like. */
  noContextFiles?: boolean;
  /** Default true. */
  noSkills?: boolean;
  /** Provider id to npm package that registers it. */
  providerExtensions?: Record<string, string>;
  /**
   * Packages loaded into every child when installed, whatever `extensions`
   * says, so the user's policy also gates child tool calls. Default
   * `['@gotgenes/pi-permission-system']`; `[]` turns it off.
   */
  policyExtensions?: string[];
  /**
   * Inline extensions loaded into the child right after the runner's own
   * guards (tool allowlist, git guard, read roots, depth), before permission
   * gates and before the system-prompt freeze and tool-start hooks. They run
   * in the child's process like any extension; use them for per-call
   * policies such as loop guards. A call the runner's guards refuse never
   * reaches them.
   */
  extensionFactories?: ExtensionFactory[];
  /**
   * Extension modules (default export: an `ExtensionFactory`) loaded after
   * the runner's own guards, like `extensionFactories` but by path, so they
   * work with both backends. Relative paths resolve against `cwd`. The
   * in-process backend imports them with Node's `import()`; the process
   * backend hands them to Pi (`-e`).
   */
  extensionPaths?: string[];
  /**
   * `in-process` (default): the child is a Pi session inside this process.
   * `process`: the child is a `pi --mode rpc` subprocess in its own process
   * group, so a child wedged in a tool that ignores abort can be killed
   * with SIGKILL (timeouts and `abort()` escalate to it automatically).
   * Trade-offs of `process`: slower start (a full Pi boot, extensions
   * included), more memory, and no closures across the boundary:
   * `extensionFactories` is refused (use `extensionPaths`), and providers
   * registered only in the parent are unavailable in the child. Permission
   * asks relay to `parent.ctx.ui`.
   */
  backend?: 'in-process' | 'process';
  result?: ResultSpec;
  /**
   * Wall-clock limit, the hard cap on cost; time spent waiting for a person
   * is not counted. With `wrapUpMs` it starts a wrap-up instead of stopping.
   */
  timeoutMs?: number;
  /**
   * Grace after `timeoutMs`: the child is steered to finish and give its
   * final answer (or call `submit_result`), and is stopped
   * (`timed_out`) only if it has not ended within `wrapUpMs`. A generation
   * that ends in time keeps its normal outcome and carries
   * `wrappedUp: true`. Paused while a person is asked. Unset or 0: the run
   * stops at `timeoutMs`.
   */
  wrapUpMs?: number;
  /**
   * Stops the run (`timed_out`, `no activity for <n>ms`) when the child
   * emits no event for this long. Any child event resets it; it is paused
   * while a top-level tool runs (see `toolTimeoutMs`) and while a person is
   * asked. Unset or 0: off.
   */
  idleTimeoutMs?: number;
  /**
   * Per-tool limit, counted from the moment the tool actually runs (after
   * permission gates); paused while a person is asked.
   */
  toolTimeoutMs?: number;
  /**
   * Default true. Blocks destructive git commands (push, reset --hard,
   * clean -f, branch -D, discarding checkout/restore, stash drop/clear) in
   * the child's bash. Turn off for an agent the user explicitly lets push.
   */
  gitGuard?: boolean;
  /**
   * Paths (besides cwd) that path-taking tools may touch; anything else is
   * refused at once instead of opening a permission dialog. Unset = no
   * restriction.
   */
  readRoots?: string[];
  /**
   * How deep runAgent may nest. Default 1: a child cannot start its own
   * child.
   */
  maxDepth?: number;
  /**
   * What a permission `ask` means for this child. `forward` (default): the
   * ask opens a dialog in the parent and the timers pause until a person
   * answers. `deny`: the child is not registered with pi-permission-system
   * as a subagent, so it decides alone, has no UI and refuses at once; only
   * explicit `allow` rules pass. For runs nobody is watching.
   */
  permissionAsks?: 'deny' | 'forward';
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
  /**
   * Shown for this run in the process-wide live registry (`liveRuns()`).
   * `name` defaults to `agent`; `context` is free text such as
   * `ralph US-002`. Inherited by startAgent.
   */
  label?: { name: string; context?: string };
  /**
   * Persist the child session to this new file (Pi's session JSONL, opens
   * with `pi --session <file>`), relative to cwd. Must not exist yet; parent
   * directories are created. Kept on every outcome. Unset: the session lives
   * in memory and nothing is written.
   */
  transcriptPath?: string;
}

export interface RunUpdate {
  turn: number;
  /** Tool running now; unset between tools. */
  tool?: string;
  toolCalls: number;
  tokens: number;
  durationMs: number;
  /** Tail of the latest assistant text. */
  recentOutput?: string;
}

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  /** Time the run timer was paused by people being asked. */
  waitedMs: number;
}

export interface RunAgentResult {
  status: RunStatus;
  /** Final text, or the validated `submit_result` payload. */
  value: unknown;
  usage: RunUsage;
  /** Resolved `provider/id`. */
  model?: string;
  error?: string;
  /** Absolute path, set when the transcript file was written. */
  transcriptPath?: string;
  /** Set when `timeoutMs` expired and the child was asked to wrap up. */
  wrappedUp?: boolean;
}

export interface StartAgentOptions extends Omit<
  RunAgentOptions,
  | 'task'
  | 'timeoutMs'
  | 'wrapUpMs'
  | 'idleTimeoutMs'
  | 'toolTimeoutMs'
  | 'signal'
  | 'onUpdate'
  | 'transcriptPath'
> {
  /** New session file, relative to cwd; must not exist (as in runAgent). */
  transcriptPath?: string;
  /**
   * Existing session file, relative to cwd, continued in place. Exclusive
   * with `transcriptPath`; a missing file is refused before any session.
   */
  resumeFrom?: string;
  /** Cancels creation only. */
  signal?: AbortSignal;
}

/** Limits and listeners of one generation. */
export interface TurnOptions {
  timeoutMs?: number;
  wrapUpMs?: number;
  idleTimeoutMs?: number;
  toolTimeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
}

export interface GenerationResult extends RunAgentResult {
  /** steer/followUp texts accepted but never delivered (queue cleared). */
  dropped: string[];
}

export type QueueDisposition = 'queued' | 'idle' | 'disposed';

export interface AgentHandle {
  readonly sessionId: string;
  /** Absolute; for `resumeFrom`, the resumed file. Set once it exists. */
  readonly transcriptPath?: string;
  readonly state: 'idle' | 'running' | 'disposed';
  /** One generation. Rejects when running or disposed, never otherwise. */
  run(task: string, options?: TurnOptions): Promise<GenerationResult>;
  /** Rejects when Pi refuses the text (for example an extension command). */
  steer(text: string): Promise<QueueDisposition>;
  followUp(text: string): Promise<QueueDisposition>;
  /** Current generation ends `cancelled`; the session stays usable. */
  abort(): Promise<void>;
  /** Idempotent; aborts a running generation first. */
  dispose(): Promise<void>;
}
