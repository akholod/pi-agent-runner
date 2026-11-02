// The host-owned runtime: Pi's SDK, its TUI helpers and typebox, handed to the
// runner by the extension entry through `bindHostRuntime`. The compiled runner
// never imports these packages for values, so the copy that runs is always
// the one the host loaded, not whatever sits next to the runner in
// node_modules. Design: docs/host-runtime-design.md
//
// One slot on globalThis, shared by every physical copy of this package. The
// first valid binding installs it; the same references again are a no-op;
// different ones are a conflict (restart Pi).

type PiModule = typeof import('@earendil-works/pi-coding-agent');
type TuiModule = typeof import('@earendil-works/pi-tui');

/** Exactly the SDK exports the runner uses. */
export type PiRuntime = Pick<
  PiModule,
  | 'VERSION'
  | 'getAgentDir'
  | 'getPackageDir'
  | 'SettingsManager'
  | 'DefaultPackageManager'
  | 'DefaultResourceLoader'
  | 'createEventBus'
  | 'ModelRuntime'
  | 'resolveCliModel'
  | 'createAgentSession'
  | 'SessionManager'
  | 'ProjectTrustStore'
  | 'createMcpExtension'
  | 'createCodemodeExtension'
>;

/** Exactly the TUI exports the runner uses. */
export type TuiRuntime = Pick<
  TuiModule,
  'Key' | 'matchesKey' | 'truncateToWidth' | 'visibleWidth' | 'wrapTextWithAnsi'
>;

export interface HostRuntime {
  pi: PiRuntime;
  tui: TuiRuntime;
  typebox: {
    Unsafe: typeof import('typebox').Unsafe;
    Compile: typeof import('typebox/compile').Compile;
  };
  /** Explicit executable override for SDK/binary integrations. */
  processCommand?: readonly [string, ...string[]];
}

export type HostRuntimeInfo =
  | { bound: false }
  | {
      bound: true;
      source: 'injected';
      hostVersion: string;
      testedVersions: readonly string[];
      warnings: readonly string[];
    };

/** Host versions the runner is tested against. */
export const TESTED_HOST_VERSIONS: readonly string[] = ['1.1.0', '1.5.0'];

const MINIMUM_VERSION = [1, 1, 0] as const;
const PROTOCOL = 1;
const SLOT = Symbol.for('pi-agent-runner:host-runtime:v1');

const UNBOUND_MESSAGE =
  'PI_AGENT_RUNNER_HOST_UNBOUND: Call bindHostRuntime() from the Pi ' +
  'extension entry before using the runtime.';

/** Thrown when the runtime is used before `bindHostRuntime`. */
export class HostUnboundError extends Error {
  constructor() {
    super(UNBOUND_MESSAGE);
    this.name = 'HostUnboundError';
  }
}

export const isHostUnboundError = (error: unknown): error is Error =>
  error instanceof HostUnboundError ||
  (error instanceof Error &&
    error.message.startsWith('PI_AGENT_RUNNER_HOST_UNBOUND:'));

interface Slot {
  protocol: number;
  host: HostRuntime;
  warnings: string[];
  /** Tail of the session-loading queue, shared by every runner copy. */
  loading: Promise<unknown>;
}

const globals = globalThis as Record<symbol, unknown>;

const readSlot = (): Slot | undefined => globals[SLOT] as Slot | undefined;

// What each group of members must look like. Classes list the static methods
// the runner calls.
const PI_FUNCTIONS = [
  'getAgentDir',
  'getPackageDir',
  'createEventBus',
  'resolveCliModel',
  'createAgentSession',
  'createMcpExtension',
  'createCodemodeExtension',
] as const;
const PI_CLASSES: Record<string, readonly string[]> = {
  SettingsManager: ['create'],
  DefaultPackageManager: [],
  DefaultResourceLoader: [],
  ModelRuntime: ['create'],
  SessionManager: ['open', 'inMemory'],
  ProjectTrustStore: [],
};
const PI_MEMBERS = [
  'VERSION',
  ...PI_FUNCTIONS,
  ...Object.keys(PI_CLASSES),
] as const;
const TUI_FUNCTIONS = [
  'matchesKey',
  'truncateToWidth',
  'visibleWidth',
  'wrapTextWithAnsi',
] as const;
const TUI_MEMBERS = ['Key', ...TUI_FUNCTIONS] as const;
const KEY_FIELDS = ['escape', 'up', 'down', 'pageUp', 'pageDown'] as const;
const TYPEBOX_MEMBERS = ['Unsafe', 'Compile'] as const;

type Members = Record<string, unknown>;

const isObjectLike = (value: unknown): value is Members =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const parseVersion = (version: unknown): number[] | undefined => {
  const match =
    typeof version === 'string'
      ? /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
      : null;
  return match ? match.slice(1, 4).map(Number) : undefined;
};

const compareVersions = (a: number[], b: readonly number[]) => {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const describeVersion = (host: unknown) => {
  const version =
    isObjectLike(host) && isObjectLike(host.pi) ? host.pi.VERSION : undefined;
  return typeof version === 'string' ? version : 'unknown';
};

const missing = (host: unknown, capability: string): never => {
  throw new Error(
    `bindHostRuntime: host is missing ${capability} ` +
      `(host VERSION ${describeVersion(host)})`,
  );
};

const checkGroup = (
  host: unknown,
  group: string,
  members: unknown,
  functions: readonly string[],
) => {
  if (!isObjectLike(members)) missing(host, group);
  const source = members as Members;
  for (const name of functions) {
    if (typeof source[name] !== 'function') {
      missing(host, `${group}.${name} (function)`);
    }
  }
  return source;
};

/** Throws on a missing capability or a version below the minimum. */
const validate = (host: unknown): string[] => {
  const warnings: string[] = [];
  if (!isObjectLike(host)) {
    throw new TypeError('bindHostRuntime: expected a HostRuntime object');
  }
  const pi = checkGroup(host, 'pi', host.pi, PI_FUNCTIONS);
  const version = pi.VERSION;
  const parsed = parseVersion(version);
  if (parsed && compareVersions(parsed, MINIMUM_VERSION) < 0) {
    throw new Error(
      `bindHostRuntime: host VERSION ${String(version)} is below the ` +
        `minimum ${MINIMUM_VERSION.join('.')}`,
    );
  }
  if (typeof version !== 'string' || !version) {
    missing(host, 'pi.VERSION (string)');
  }
  if (!parsed) {
    warnings.push(
      `host VERSION "${String(version)}" is not a recognizable version; ` +
        'capability checks passed',
    );
  } else if (!TESTED_HOST_VERSIONS.includes(String(version))) {
    warnings.push(
      `host VERSION ${String(version)} is not among the tested versions ` +
        `(${TESTED_HOST_VERSIONS.join(', ')})`,
    );
  }
  for (const [name, statics] of Object.entries(PI_CLASSES)) {
    const cls = pi[name];
    if (typeof cls !== 'function') missing(host, `pi.${name} (class)`);
    for (const method of statics) {
      const member = (cls as Members)[method];
      if (typeof member !== 'function') {
        missing(host, `pi.${name}.${method} (static method)`);
      }
    }
  }
  const tui = checkGroup(host, 'tui', host.tui, TUI_FUNCTIONS);
  if (!isObjectLike(tui.Key)) missing(host, 'tui.Key');
  for (const field of KEY_FIELDS) {
    const value = (tui.Key as Members)[field];
    if (typeof value !== 'string') {
      missing(host, `tui.Key.${field}`);
    }
  }
  const typebox = checkGroup(host, 'typebox', host.typebox, TYPEBOX_MEMBERS);
  void typebox;
  const command = host.processCommand;
  if (
    command !== undefined &&
    !(
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((part) => typeof part === 'string' && part)
    )
  ) {
    throw new TypeError(
      'bindHostRuntime: processCommand must be a non-empty string array',
    );
  }
  return warnings;
};

// SAFETY: the callers pass module-like objects; members are read by name and
// validated by `validate` before any snapshot is taken.
const pick = <T>(source: object, names: readonly string[]): T =>
  Object.fromEntries(
    names.map((name) => [name, (source as Members)[name]]),
  ) as T;

// A plain copy of just the used members: later changes to the namespace
// object (or a different wrapper around the same module) cannot alter it.
const snapshot = (host: HostRuntime): HostRuntime => {
  const copy: HostRuntime = {
    pi: pick<PiRuntime>(host.pi, PI_MEMBERS),
    tui: pick<TuiRuntime>(host.tui, TUI_MEMBERS),
    typebox: pick<HostRuntime['typebox']>(host.typebox, TYPEBOX_MEMBERS),
  };
  const [first, ...rest] = host.processCommand ?? [];
  if (first !== undefined) {
    copy.processCommand = Object.freeze([first, ...rest]);
  }
  return copy;
};

const commandKey = (host: HostRuntime) =>
  (host.processCommand ?? []).join('\0');

const differences = (a: HostRuntime, b: HostRuntime) => {
  const diff: string[] = [];
  const groups: [string, object, object, readonly string[]][] = [
    ['pi', a.pi, b.pi, PI_MEMBERS],
    ['tui', a.tui, b.tui, TUI_MEMBERS],
    ['typebox', a.typebox, b.typebox, TYPEBOX_MEMBERS],
  ];
  for (const [group, left, right, names] of groups) {
    for (const name of names) {
      const same = Object.is((left as Members)[name], (right as Members)[name]);
      if (!same) diff.push(`${group}.${name}`);
    }
  }
  if (commandKey(a) !== commandKey(b)) diff.push('processCommand');
  return diff;
};

/**
 * Hands the runner the host's SDK, TUI helpers and typebox. Call it from the
 * `.ts` entry of every consuming extension, before any other runner API.
 * Binding the same references again is a no-op; different ones throw
 * `HOST_CONFLICT` (restart Pi). A missing capability or a host older than
 * the minimum throws synchronously.
 */
export const bindHostRuntime = (host: HostRuntime): void => {
  const warnings = validate(host);
  const next = snapshot(host);
  const current = readSlot();
  if (current) {
    const diff = differences(current.host, next);
    if (diff.length === 0) return;
    throw new Error(
      `HOST_CONFLICT: a different host runtime is already bound ` +
        `(bound VERSION ${current.host.pi.VERSION}, new VERSION ` +
        `${next.pi.VERSION}; differing: ${diff.join(', ')}). ` +
        'Restart Pi to switch runtimes.',
    );
  }
  const slot: Slot = {
    protocol: PROTOCOL,
    host: next,
    warnings,
    loading: Promise.resolve(),
  };
  globals[SLOT] = slot;
};

/** Whether and how the host runtime is bound, for diagnostics. */
export const getHostRuntimeInfo = (): HostRuntimeInfo => {
  const slot = readSlot();
  if (!slot) return { bound: false };
  return {
    bound: true,
    source: 'injected',
    hostVersion: slot.host.pi.VERSION,
    testedVersions: [...TESTED_HOST_VERSIONS],
    warnings: [...slot.warnings],
  };
};

/** Cheap check for callers that have a fallback. */
export const isHostBound = (): boolean => readSlot() !== undefined;

/** The bound runtime; throws `PI_AGENT_RUNNER_HOST_UNBOUND:` when unbound. */
export const requireHostRuntime = (): HostRuntime => {
  const slot = readSlot();
  if (!slot) throw new HostUnboundError();
  return slot.host;
};

/**
 * Runs `task` after every earlier loading task of any runner copy settled, so
 * concurrent children never interleave extension loading. The lock covers the
 * task only.
 */
export const serializeLoading = <T>(task: () => Promise<T>): Promise<T> => {
  const slot = readSlot();
  if (!slot) return Promise.reject(new HostUnboundError());
  const run = slot.loading.catch(() => {}).then(task);
  slot.loading = run;
  return run;
};
