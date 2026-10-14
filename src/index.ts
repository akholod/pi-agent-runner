export * from './types.ts';
export {
  runAgent,
  startAgent,
  WRAP_UP_MESSAGE,
  wrapUpMessage,
} from './run-agent.ts';
export { SUBMIT_RESULT_TOOL } from './structured.ts';
export {
  createPiSessionFactory,
  CHANNEL_SESSION_CREATED,
  CHANNEL_BOUND,
  CHANNEL_DISPOSED,
} from './session.ts';
export type {
  ChildEvent,
  ChildSession,
  ChildSessionFactory,
  ChildSpec,
} from './session.ts';
export { createProcessSessionFactory } from './process-session.ts';
export type { ProcessSessionOptions } from './process-session.ts';
// Call `humanWaitTracker(pi.events)` at extension load so a dialog opened
// before the first run is also seen.
export { humanWaitTracker } from './human-wait.ts';
export type { HumanWaitTracker } from './human-wait.ts';
export { dangerousGitCommand, guardDecision } from './guards.ts';
export type { GuardConfig } from './guards.ts';
export { liveRuns, isPossiblyStuck, STUCK_AFTER_MS } from './live.ts';
export type {
  ActivityEntry,
  LiveRegistry,
  LiveRun,
  LiveState,
  RunControl,
} from './live.ts';
export { mountRunsView, renderRunsView } from './view.ts';
export type { MountOptions, RunsView } from './view.ts';
// `/agents`: pick a child run, see its recent activity, cancel or take it over.
// Call `registerAgentsCommand(pi)` at extension load; copies of this package
// in other extensions share one registration.
export { registerAgentsCommand } from './agents-command.ts';
export type { AgentsCommandOptions } from './agents-command.ts';
