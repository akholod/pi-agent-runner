// Live, read-only panes for running children, inside herdr or tmux. Each
// run that starts gets a pane next to the user's Pi pane running
// pane-viewer, which tails a feed file this module appends to. One owner per
// process (as in view.ts), at most `max` panes, none queued. A pane closes
// itself shortly after the run ends; the owner also closes it, and every
// feed file goes with it.
import { execFile, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  liveRuns,
  runActivity,
  type ActivityEntry,
  type LiveRegistry,
  type LiveRun,
} from './live.ts';
import {
  DEFAULT_LINGER_MS,
  createFeed,
  defaultFeedDir,
  type Feed,
} from './pane-feed.ts';

export type Multiplexer = 'herdr' | 'tmux';

/** Runs a CLI and resolves with its stdout; rejects when it fails. */
export type PaneExec = (file: string, args: string[]) => Promise<string>;

export const MAX_PANES = 3;
// the viewer exits by itself after the linger; the runner closes a pane
// that did not (herdr keeps a pane whose shell survives) this much later
const CLOSE_GRACE_MS = 1000;
const EXEC_TIMEOUT_MS = 10_000;
// state records that only move counters are written at most this often
const STATE_MS = 250;

export type PanesContext = Pick<ExtensionContext, 'mode' | 'hasUI'> & {
  cwd?: string;
  ui: Pick<ExtensionContext['ui'], 'notify'>;
};

export interface PanesOptions {
  /** `auto`: herdr inside herdr, else tmux inside tmux. Default `auto`. */
  multiplexer?: 'auto' | Multiplexer;
  /** Most panes at once, lingering ones included. Default 3. */
  max?: number;
  /** How long a pane shows the final status. Default 5000. */
  lingerMs?: number;
  /** Which runs get a pane. Default: every run. */
  filter?: (run: LiveRun) => boolean;
  registry?: LiveRegistry;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Test seams. */
  exec?: PaneExec;
  execSync?: (file: string, args: string[]) => void;
  env?: NodeJS.ProcessEnv;
  /** Is this CLI on the PATH? */
  hasBinary?: (name: string) => boolean;
  activity?: (id: string) => ActivityEntry[] | undefined;
  feedDir?: string;
  /** The viewer script; default: `pane-viewer` next to this module. */
  viewer?: string;
  /** The `node` to run it with; default: this process's. */
  node?: string;
}

export interface PanesHandle {
  dispose(): void;
}

const defaultExec: PaneExec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

const defaultExecSync = (file: string, args: string[]): void => {
  spawnSync(file, args, { stdio: 'ignore', timeout: 2000 });
};

const onPath = (name: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

export const detectMultiplexer = (
  wanted: PanesOptions['multiplexer'] = 'auto',
  env: NodeJS.ProcessEnv = process.env,
  hasBinary: (name: string) => boolean = (name) => onPath(name, env),
): Multiplexer | undefined => {
  const herdr = env.HERDR_ENV === '1' && hasBinary('herdr');
  const tmux = Boolean(env.TMUX) && hasBinary('tmux');
  if (wanted === 'herdr') return herdr ? 'herdr' : undefined;
  if (wanted === 'tmux') return tmux ? 'tmux' : undefined;
  if (herdr) return 'herdr';
  return tmux ? 'tmux' : undefined;
};

const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

type Direction = 'right' | 'down';

interface OpenSpec {
  /** A viewer pane to split; the user's own pane when undefined. */
  target?: string;
  direction: Direction;
  cwd: string;
  /** argv of the viewer. */
  command: string[];
}

interface Backend {
  /** Opens a pane running the command, without taking focus. */
  open(exec: PaneExec, spec: OpenSpec): Promise<string>;
  closeArgs(paneId: string): [string, string[]];
}

const herdrBackend: Backend = {
  async open(exec, spec) {
    const where = spec.target ? ['--pane', spec.target] : ['--current'];
    const split = await exec('herdr', [
      'pane',
      'split',
      ...where,
      '--direction',
      spec.direction,
      '--cwd',
      spec.cwd,
      '--no-focus',
    ]);
    const parsed = JSON.parse(split) as {
      result?: { pane?: { pane_id?: unknown } };
    };
    const paneId = parsed.result?.pane?.pane_id;
    if (typeof paneId !== 'string') throw new Error('herdr: no pane id');
    // exec: the pane closes with the viewer instead of keeping its shell
    const line = `exec ${spec.command.map(quote).join(' ')}`;
    try {
      await exec('herdr', ['pane', 'run', paneId, line]);
    } catch (error) {
      await exec('herdr', ['pane', 'close', paneId]).catch(() => undefined);
      throw error;
    }
    return paneId;
  },
  closeArgs: (paneId) => ['herdr', ['pane', 'close', paneId]],
};

const tmuxBackend = (env: NodeJS.ProcessEnv): Backend => ({
  async open(exec, spec) {
    const target = spec.target ?? env.TMUX_PANE;
    const at = target ? ['-t', target] : [];
    const out = await exec('tmux', [
      'split-window',
      '-d',
      spec.direction === 'right' ? '-h' : '-v',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      spec.cwd,
      ...at,
      spec.command.map(quote).join(' '),
    ]);
    const paneId = out.trim();
    if (!paneId) throw new Error('tmux: no pane id');
    return paneId;
  },
  closeArgs: (paneId) => ['tmux', ['kill-pane', '-t', paneId]],
});

interface Pane {
  key: string;
  runId: string;
  generation: number;
  feed: Feed;
  paneId?: string;
  /** The feed got its end record. */
  ended: boolean;
  /** The pane is closed, or was never opened. */
  closed: boolean;
  closeTimer?: unknown;
  lastEntry?: ActivityEntry;
  lastState?: StateKey;
  lastStateAt: number;
  /** Everything of the run that the end record needs. */
  last: LiveRun;
}

interface StateKey {
  state: string;
  waiting: boolean;
  wrappingUp: boolean;
  turns: number;
  toolCalls: number;
  tokens: string;
  cost: number;
}

const stateKeyOf = (run: LiveRun): StateKey => ({
  state: run.state,
  waiting: run.waitingForUser,
  wrappingUp: run.wrappingUp === true,
  turns: run.turns,
  toolCalls: run.toolCalls,
  tokens: `${run.tokens.input}/${run.tokens.output}`,
  cost: run.cost,
});

const sameEntry = (a: ActivityEntry, b: ActivityEntry): boolean =>
  a.at === b.at && a.kind === b.kind && a.text === b.text;

const lastIndex = <T>(items: T[], test: (item: T) => boolean): number => {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
};

const keyOf = (run: LiveRun): string => `${run.id}#${run.generation}`;

const defaultViewer = (): string => {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `pane-viewer${path.extname(self)}`);
};

interface Running {
  stop(): void;
  /** Synchronous, for the process exit. */
  exit(): void;
}

const startPanes = (
  ctx: PanesContext,
  options: PanesOptions,
  kind: Multiplexer,
): Running => {
  const env = options.env ?? process.env;
  const registry = options.registry ?? liveRuns();
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): unknown => setTimeout(fn, ms).unref());
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown): void =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const exec = options.exec ?? defaultExec;
  const execSync = options.execSync ?? defaultExecSync;
  const activityOf = options.activity ?? runActivity;
  const max = Math.max(1, options.max ?? MAX_PANES);
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  const filter = options.filter ?? (() => true);
  const feedDir = options.feedDir ?? defaultFeedDir();
  const viewer = options.viewer ?? defaultViewer();
  const node = options.node ?? process.execPath;
  const backend = kind === 'herdr' ? herdrBackend : tmuxBackend(env);
  const cwd = ctx.cwd ?? process.cwd();
  // a .ts viewer (run from source) needs Node to strip the types
  const nodeArgs = viewer.endsWith('.ts') ? ['--experimental-strip-types'] : [];

  const panes = new Map<string, Pane>();
  const skipped = new Set<string>();
  let stopped = false;
  let failed = false;
  // splits and closes run one at a time: a split targets the pane before it
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task).catch(() => undefined);
  };

  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      ctx.ui.notify(`Agent panes disabled (${kind}): ${reason}`, 'warning');
    } catch {
      // a ctx from a session that already shut down
    }
  };

  const forget = (pane: Pane): void => {
    pane.closed = true;
    if (pane.closeTimer !== undefined) clearTimer(pane.closeTimer);
    pane.closeTimer = undefined;
    try {
      pane.feed.remove();
    } catch {
      // already gone
    }
    if (panes.get(pane.key) === pane) panes.delete(pane.key);
  };

  const close = async (pane: Pane): Promise<void> => {
    if (pane.closed) return;
    const { paneId } = pane;
    forget(pane);
    if (paneId === undefined) return;
    const [file, args] = backend.closeArgs(paneId);
    // the viewer usually closed it already
    await exec(file, args).catch(() => undefined);
  };

  const scheduleClose = (pane: Pane): void => {
    if (pane.closed || pane.closeTimer !== undefined) return;
    if (pane.paneId === undefined) return;
    pane.closeTimer = setTimer(() => {
      pane.closeTimer = undefined;
      enqueue(() => close(pane));
    }, lingerMs + CLOSE_GRACE_MS);
  };

  const flushEntries = (pane: Pane, run: LiveRun): void => {
    const buffer = activityOf(run.id) ?? [];
    const last = pane.lastEntry;
    const text = `generation ${run.generation} started`;
    const from = last
      ? lastIndex(buffer, (entry) => sameEntry(entry, last)) + 1
      : Math.max(
          0,
          lastIndex(
            buffer,
            (entry) => entry.kind === 'generation' && entry.text === text,
          ),
        );
    for (const entry of buffer.slice(from)) {
      pane.feed.write({ t: 'entry', ...entry });
      pane.lastEntry = entry;
    }
  };

  const flushState = (pane: Pane, run: LiveRun): void => {
    const key = stateKeyOf(run);
    const before = pane.lastState;
    const at = now();
    if (before) {
      const same = JSON.stringify(before) === JSON.stringify(key);
      if (same) return;
      const major =
        before.state !== key.state ||
        before.waiting !== key.waiting ||
        before.wrappingUp !== key.wrappingUp ||
        before.turns !== key.turns ||
        before.toolCalls !== key.toolCalls;
      if (!major && at - pane.lastStateAt < STATE_MS) return;
    }
    pane.lastState = key;
    pane.lastStateAt = at;
    pane.feed.write({
      t: 'state',
      at,
      state: run.state,
      turns: run.turns,
      toolCalls: run.toolCalls,
      tokens: { ...run.tokens },
      cost: run.cost,
      waiting: run.waitingForUser,
      wrappingUp: run.wrappingUp === true,
    });
  };

  const finish = (pane: Pane, run: LiveRun | undefined): void => {
    // a run that left the registry, or moved on to a later generation
    const same = run?.generation === pane.generation;
    const final = same && run ? run : pane.last;
    if (same && run) flushEntries(pane, run);
    pane.ended = true;
    const settled = same && run && run.state !== 'running';
    pane.feed.write({
      t: 'end',
      at: now(),
      status: settled ? final.state : 'ended',
      error: settled ? final.error : 'the run left the live list',
      turns: final.turns,
      tokens: { ...final.tokens },
      cost: final.cost,
      startedAt: final.startedAt,
    });
    scheduleClose(pane);
  };

  const sync = (pane: Pane, run: LiveRun | undefined): void => {
    if (!run || run.generation !== pane.generation || run.state !== 'running') {
      finish(pane, run);
      return;
    }
    pane.last = run;
    flushEntries(pane, run);
    flushState(pane, run);
  };

  const spawn = async (pane: Pane): Promise<void> => {
    if (stopped || failed || pane.closed) {
      forget(pane);
      return;
    }
    const command = [node, ...nodeArgs, viewer, pane.feed.file, `${lingerMs}`];
    // the first pane splits the user's to the right, later ones stack
    // down from the newest viewer pane
    const live = [...panes.values()].filter(
      (other) => other !== pane && other.paneId !== undefined && !other.closed,
    );
    let target = live.at(-1);
    try {
      for (;;) {
        try {
          pane.paneId = await backend.open(exec, {
            target: target?.paneId,
            direction: target ? 'down' : 'right',
            cwd,
            command,
          });
          break;
        } catch (error) {
          // the pane to split is gone (closed by hand): start a new column
          if (!target) throw error;
          skipped.add(target.key);
          forget(target);
          target = undefined;
        }
      }
    } catch (error) {
      fail(error);
      forget(pane);
      return;
    }
    if (stopped || pane.closed) {
      const [file, args] = backend.closeArgs(pane.paneId);
      await exec(file, args).catch(() => undefined);
      forget(pane);
      return;
    }
    if (pane.ended) scheduleClose(pane);
  };

  const open = (run: LiveRun): void => {
    let feed: Feed;
    try {
      feed = createFeed(feedDir, run.id, run.generation);
    } catch (error) {
      fail(error);
      return;
    }
    const pane: Pane = {
      key: keyOf(run),
      runId: run.id,
      generation: run.generation,
      feed,
      ended: false,
      closed: false,
      lastStateAt: 0,
      last: run,
    };
    panes.set(pane.key, pane);
    feed.write({
      t: 'start',
      at: now(),
      pid: process.pid,
      id: run.id,
      name: run.name,
      context: run.context,
      model: run.model,
      generation: run.generation,
      startedAt: run.startedAt,
    });
    sync(pane, run);
    enqueue(() => spawn(pane));
  };

  const refresh = (): void => {
    if (stopped) return;
    const runs = new Map(registry.list().map((run) => [run.id, run]));
    for (const pane of [...panes.values()]) {
      if (!pane.ended && !pane.closed) sync(pane, runs.get(pane.runId));
    }
    if (failed) return;
    // a run that found no room or no filter's favour never gets a pane
    for (const key of [...skipped]) {
      if (![...runs.values()].some((run) => keyOf(run) === key)) {
        skipped.delete(key);
      }
    }
    for (const run of runs.values()) {
      const key = keyOf(run);
      if (run.state !== 'running' || panes.has(key) || skipped.has(key)) {
        continue;
      }
      let wanted = false;
      try {
        wanted = filter(run);
      } catch {
        // a broken filter gives no pane
      }
      if (wanted && panes.size < max) open(run);
      else skipped.add(key);
    }
  };

  const unsubscribe = registry.subscribe(refresh);
  refresh();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      for (const pane of [...panes.values()]) {
        const { paneId } = pane;
        forget(pane);
        if (paneId === undefined) continue;
        const [file, args] = backend.closeArgs(paneId);
        void exec(file, args).catch(() => undefined);
      }
    },
    exit() {
      for (const pane of [...panes.values()]) {
        const { paneId } = pane;
        forget(pane);
        if (paneId === undefined) continue;
        const [file, args] = backend.closeArgs(paneId);
        try {
          execSync(file, args);
        } catch {
          // best effort
        }
      }
    },
  };
};

// Shared across every copy of this library in the process, so Opium and
// Spiral mounting for the same session open one pane per run, not two.
interface Mount {
  start(): Running;
}

interface Store {
  mounts: Mount[];
  owner?: Mount;
  running?: Running;
  hooked?: boolean;
}

const STORE = Symbol.for('pi-agent-runner:panes:v1');

const store = (): Store => {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[STORE] ??= { mounts: [] });
};

const hookExit = (shared: Store): void => {
  if (shared.hooked) return;
  shared.hooked = true;
  process.on('exit', () => shared.running?.exit());
};

/**
 * Opens a read-only pane for each running child inside herdr or tmux, and
 * closes it shortly after the run ends. Does nothing without a TUI or a
 * multiplexer. Dispose it on `session_shutdown`.
 */
export const mountPanes = (
  ctx: PanesContext,
  options: PanesOptions = {},
): PanesHandle => {
  const nothing: PanesHandle = { dispose: () => undefined };
  if (ctx.mode !== 'tui' || !ctx.hasUI) return nothing;
  const kind = detectMultiplexer(
    options.multiplexer,
    options.env ?? process.env,
    options.hasBinary,
  );
  if (!kind) return nothing;
  const shared = store();
  hookExit(shared);
  const mount: Mount = { start: () => startPanes(ctx, options, kind) };
  shared.mounts.push(mount);
  if (!shared.owner) {
    shared.owner = mount;
    shared.running = mount.start();
  }
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      shared.mounts = shared.mounts.filter((m) => m !== mount);
      if (shared.owner !== mount) return;
      const running = shared.running;
      shared.owner = undefined;
      shared.running = undefined;
      running?.stop();
      const next = shared.mounts.at(-1);
      if (next) {
        shared.owner = next;
        shared.running = next.start();
      }
    },
  };
};
