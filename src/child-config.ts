// What the process backend and its child extensions agree on: the config
// file, the depth variable and the two in-band markers that ride on Pi's
// RPC extension-UI sub-protocol.
import * as fs from 'node:fs';
import type { GuardConfig } from './guards.ts';

/** Env var holding the path of the child's JSON config file. */
export const CONFIG_ENV = 'PI_AGENT_RUNNER_CHILD_CONFIG';
/** Env var holding the nesting depth of the child (parent depth + 1). */
export const DEPTH_ENV = 'PI_AGENT_RUNNER_DEPTH';

/** `notify` message prefix: a top-level tool is about to run (JSON after). */
export const TOOL_START_PREFIX = 'pi-agent-runner:tool-start ';
/** `input` dialog title: the placeholder carries a submit_result value. */
export const SUBMIT_TITLE = 'pi-agent-runner:submit';

/**
 * Marker commands the two child extensions register; the parent refuses to
 * run a child where either is missing (Pi would carry on without a guard
 * whose extension failed to load).
 */
export const GUARD_COMMAND = 'pi-agent-runner-guard';
export const TAIL_COMMAND = 'pi-agent-runner-tail';

export interface ChildConfig {
  guard: GuardConfig;
  /** `label.name`; announced as the child's active agent when set. */
  label?: string;
  /** JSON schema of `submit_result`; unset = the tool is not registered. */
  resultSchema?: Record<string, unknown>;
  /** Built-in MCP servers the child connects; unset = none. */
  mcpServers?: string[];
}

export const readChildConfig = (): ChildConfig => {
  const file = process.env[CONFIG_ENV];
  if (!file) throw new Error(`${CONFIG_ENV} is not set`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ChildConfig;
};

/** Nesting depth inherited from a process-backend parent; 0 when unset. */
export const inheritedDepth = () => {
  const depth = Number(process.env[DEPTH_ENV]);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
};
