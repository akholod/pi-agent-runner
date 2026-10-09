import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

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
  >;
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
  result?: ResultSpec;
  /** Wall-clock limit; time spent waiting for a person is not counted. */
  timeoutMs?: number;
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
}
