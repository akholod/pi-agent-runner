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
  // Not implemented yet: toolTimeoutMs is T07, transcriptPath is T10.
  /** Per-tool limit, counted from the moment the tool actually runs. */
  toolTimeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (update: RunUpdate) => void;
  /** Save the child transcript as JSONL. */
  transcriptPath?: string;
}

export interface RunUpdate {
  turn: number;
  tool?: string;
  tokens: number;
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
}

export interface RunAgentResult {
  status: RunStatus;
  /** Final text, or the validated `submit_result` payload. */
  value: unknown;
  usage: RunUsage;
  /** Resolved `provider/id`. */
  model?: string;
  error?: string;
  transcriptPath?: string;
}
