// Where the host installation lives, derived from the injected runtime: the
// CLI a process-backed child runs and the TUI module a pane viewer imports.
// Nothing here looks at PATH or at copies of Pi next to the runner.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireHostRuntime } from './host-runtime.ts';
import type { PiRuntime } from './host-runtime.ts';

export const HOST_PACKAGE = '@earendil-works/pi-coding-agent';
export const TUI_PACKAGE = '@earendil-works/pi-tui';

type Command = readonly [string, ...string[]];

const ASK_FOR_COMMAND =
  'pass an explicit command: createProcessSessionFactory({ command }) or ' +
  'bindHostRuntime({ ..., processCommand })';

const readJson = (file: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('not a JSON object');
  }
  return parsed as Record<string, unknown>;
};

const inside = (dir: string, file: string) => {
  const relative = path.relative(dir, file);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
};

/**
 * `[node, <bin.pi of the host installation>]`: the package that
 * `getPackageDir()` names must be Pi itself, at the injected `VERSION`.
 * Throws an error asking for an explicit command when it cannot be proven.
 */
export const hostCliCommand = (
  pi: Pick<PiRuntime, 'getPackageDir' | 'VERSION'>,
): [string, string] => {
  const fail = (reason: string): never => {
    throw new Error(
      `cannot determine the host Pi CLI: ${reason}; ${ASK_FOR_COMMAND}`,
    );
  };
  if ('bun' in process.versions) fail('the host runs as a compiled binary');
  let dir: string;
  let manifest: Record<string, unknown>;
  try {
    dir = path.resolve(pi.getPackageDir());
    manifest = readJson(path.join(dir, 'package.json'));
  } catch (error) {
    return fail(
      `the host package manifest is unreadable (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (manifest.name !== HOST_PACKAGE) {
    fail(`${dir} is package ${String(manifest.name)}, not ${HOST_PACKAGE}`);
  }
  if (manifest.version !== pi.VERSION) {
    fail(
      `${dir} is version ${String(manifest.version)} but the bound host ` +
        `VERSION is ${pi.VERSION}`,
    );
  }
  const { bin } = manifest;
  const relative =
    typeof bin === 'string'
      ? bin
      : (bin as Record<string, unknown> | undefined)?.pi;
  if (typeof relative !== 'string' || !relative) {
    return fail(`${dir}/package.json has no bin.pi`);
  }
  const file = path.resolve(dir, relative);
  if (!inside(dir, file) || !fs.existsSync(file)) {
    return fail(`${file} is not a file of the host installation`);
  }
  return [process.execPath, file];
};

/**
 * Process command for a child: the explicit one, else the bound
 * `processCommand`, else the verified host CLI. Never `pi` from PATH.
 */
export const resolveProcessCommand = (
  explicit?: readonly string[],
): Command => {
  if (explicit !== undefined) {
    const [first, ...rest] = explicit;
    if (!first) throw new Error('process backend: `command` is empty');
    return [first, ...rest];
  }
  const host = requireHostRuntime();
  return host.processCommand ?? hostCliCommand(host.pi);
};

// The file a package's "exports" "." entry (or main) points at, as the
// `import` condition sees it.
const entryOf = (manifest: Record<string, unknown>): string | undefined => {
  const pick = (value: unknown): string | undefined => {
    let found: string | undefined;
    if (typeof value === 'string') {
      found = value;
    } else if (typeof value === 'object' && value !== null) {
      const conditions = value as Record<string, unknown>;
      found = pick(conditions.import) ?? pick(conditions.default);
    }
    return found;
  };
  const { exports } = manifest;
  const root =
    typeof exports === 'object' && exports !== null && '.' in exports
      ? (exports as Record<string, unknown>)['.']
      : exports;
  const main = manifest.module ?? manifest.main;
  return (
    pick(root) ?? (typeof main === 'string' ? main : undefined) ?? 'index.js'
  );
};

/**
 * `file:` URL of the pi-tui entry that Node would resolve from the host
 * installation's package directory (its own node_modules, then every
 * ancestor's). Throws when no filesystem entry exists.
 */
export const tuiModuleUrlFrom = (packageDir: string): string => {
  let dir = path.resolve(packageDir);
  for (;;) {
    const root = path.join(dir, 'node_modules', ...TUI_PACKAGE.split('/'));
    const manifestFile = path.join(root, 'package.json');
    if (fs.existsSync(manifestFile)) {
      const entry = entryOf(readJson(manifestFile));
      const file = entry ? path.resolve(root, entry) : undefined;
      if (file && inside(root, file) && fs.existsSync(file)) {
        return pathToFileURL(file).href;
      }
      throw new Error(`${root} has no usable entry file`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`${TUI_PACKAGE} not found from ${packageDir}`);
};

/** The host's own TUI module, for a process that has no binding. */
export const hostTuiModuleUrl = (): string =>
  tuiModuleUrlFrom(requireHostRuntime().pi.getPackageDir());
