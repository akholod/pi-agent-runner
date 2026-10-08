// Public contract of the runner. `runAgent` itself lands in T06; see
// ~/pi_sandbox/spiral/docs/standalone-runner-plan.md for the design.

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

export interface RunAgentOptions {
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
  result?: ResultSpec;
  /** Wall-clock limit; time spent waiting for a person is not counted. */
  timeoutMs?: number;
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
}

export interface RunAgentResult {
  status: RunStatus;
  /** Final text, or the validated `submit_result` payload. */
  value: unknown;
  usage: RunUsage;
  error?: string;
  transcriptPath?: string;
}
