// The user's built-in MCP servers (Pi's `builtin:mcp`, configured with
// `pi mcp add`) for a child: which servers exist, whether the user turned the
// built-in off, and the config a child's MCP extension loads so it connects
// only the servers it was given, with their tools declared directly.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pi from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type LoadedMcpConfig = ReturnType<
  NonNullable<pi.McpExtensionOptions['loadConfig']>
>;
type McpServerEntry = LoadedMcpConfig['servers'][number];

type Raw = Record<string, unknown>;

export interface BuiltinMcpServer {
  name: string;
  /** False when the config says `enabled: false`. */
  enabled: boolean;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const BUILTIN_MCP = 'builtin:mcp';
// Only these may be set by a project entry that overrides a user server.
const OVERRIDE_KEYS = ['enabled', 'exposure', 'toolExposure'];

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Prefix of a server's tool names: `mcp__<server>__`, as Pi names them. */
export const mcpToolPrefix = (server: string) =>
  `mcp__${server}__`.replace(/[^A-Za-z0-9_]/g, '_');

/** The allowlist pattern admitting every tool of a server. */
export const mcpToolPattern = (server: string) => `${mcpToolPrefix(server)}*`;

// Pi treats names differing only in `-` and `_` as one server.
const namespaceOf = (server: string) => server.replace(/-/g, '_');

/** `tools` plus the patterns of `servers`; undefined stays unrestricted. */
export const withMcpTools = (
  tools: string[] | undefined,
  servers: string[] | undefined,
) => {
  if (!tools || !servers?.length) return tools;
  return [...new Set([...tools, ...servers.map(mcpToolPattern)])];
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const isOverride = (value: Raw) =>
  value.command === undefined &&
  value.url === undefined &&
  value.type === undefined;

const usable = (value: unknown): value is Raw =>
  isRecord(value) &&
  (typeof value.command === 'string' || typeof value.url === 'string');

// A trimmed copy of Pi's config reading: global servers, then the project's
// (replacing, or overriding enabled/exposure/toolExposure of, a global one).
// Invalid entries are skipped.
interface Found {
  config: Raw;
  scope: 'global' | 'project';
  source: string;
}

const readServers = (
  agentDir: string,
  cwd: string,
  projectTrusted: boolean,
) => {
  const servers = new Map<string, Found>();
  const files: { scope: Found['scope']; file: string }[] = [
    { scope: 'global', file: path.join(agentDir, 'mcp.json') },
  ];
  if (projectTrusted) {
    files.push({ scope: 'project', file: path.join(cwd, '.pi', 'mcp.json') });
  }
  for (const { scope, file } of files) {
    const parsed = readJson(file);
    const entries = isRecord(parsed) ? parsed.mcpServers : undefined;
    if (!isRecord(entries)) continue;
    for (const [name, value] of Object.entries(entries)) {
      if (!SERVER_NAME.test(name) || !isRecord(value)) continue;
      const base = servers.get(name);
      if (scope === 'project' && isOverride(value)) {
        const extra = Object.keys(value).filter(
          (key) => !OVERRIDE_KEYS.includes(key),
        );
        if (base && extra.length === 0) {
          servers.set(name, {
            config: { ...base.config, ...value },
            scope: base.scope,
            source: base.source,
          });
        }
        continue;
      }
      if (!usable(value) || value.type === 'sse') continue;
      const clash = [...servers.keys()].find(
        (other) => other !== name && namespaceOf(other) === namespaceOf(name),
      );
      if (clash) continue;
      servers.set(name, { config: value, scope, source: file });
    }
  }
  return servers;
};

/** Whether Pi's trust store trusts the project, as `.pi/mcp.json` needs. */
const projectTrusted = (agentDir: string, cwd: string) => {
  // No project config: skip the store (it takes a lock file).
  if (!fs.existsSync(path.join(cwd, '.pi'))) return false;
  try {
    return new pi.ProjectTrustStore(agentDir).get(cwd) === true;
  } catch {
    return false;
  }
};

/**
 * Servers configured for Pi's built-in MCP: `~/.pi/agent/mcp.json` (the
 * agent dir), plus `<cwd>/.pi/mcp.json` when `cwd` is given and Pi's trust
 * store trusts that project. A project entry replaces a user entry of the
 * same name.
 */
export const builtinMcpServers = (cwd?: string): BuiltinMcpServer[] => {
  const agentDir = pi.getAgentDir();
  const trusted = cwd !== undefined && projectTrusted(agentDir, cwd);
  const servers = readServers(agentDir, cwd ?? process.cwd(), trusted);
  return [...servers].map(([name, { config }]) => ({
    name,
    enabled: config.enabled !== false,
  }));
};

const globPattern = (glob: string) =>
  new RegExp(
    `^${glob
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );

// Pi's rules for an `extensions` list: `!glob` excludes, `+name` includes
// again, `-name` excludes for good.
const enabledByList = (entries: string[]) => {
  let enabled = true;
  const named = (prefix: string) =>
    entries.filter((e) => e.startsWith(prefix)).map((e) => e.slice(1));
  if (named('!').some((glob) => globPattern(glob).test(BUILTIN_MCP))) {
    enabled = false;
  }
  if (named('+').includes(BUILTIN_MCP)) enabled = true;
  if (named('-').includes(BUILTIN_MCP)) enabled = false;
  return enabled;
};

const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

/**
 * True when the user's settings turn Pi's built-in MCP off
 * (`"extensions": ["-builtin:mcp"]`), typically because an MCP extension such
 * as pi-mcp-adapter replaces it. Reads `<agentDir>/settings.json`; with
 * `cwd`, a trusted project's `.pi/settings.json` can override it.
 */
export const builtinMcpDisabled = (cwd?: string): boolean => {
  const agentDir = pi.getAgentDir();
  const user = readJson(path.join(agentDir, 'settings.json'));
  let enabled = enabledByList(stringsOf(isRecord(user) ? user.extensions : []));
  if (cwd !== undefined && projectTrusted(agentDir, cwd)) {
    const project = readJson(path.join(cwd, '.pi', 'settings.json'));
    // Later entries win; entries that do not name the built-in are ignored.
    for (const entry of stringsOf(
      isRecord(project) ? project.extensions : [],
    )) {
      const sign = entry[0];
      if (!'+-!'.includes(sign)) continue;
      const target = entry.slice(1);
      const hit =
        sign === '!'
          ? globPattern(target).test(BUILTIN_MCP)
          : target === BUILTIN_MCP;
      if (hit) enabled = sign === '+';
    }
  }
  return !enabled;
};

/**
 * Servers the child should get: the requested names, unless the user turned
 * the built-in MCP off (then none; the caller's own MCP extension, if any,
 * serves the child).
 */
export const activeMcpServers = (
  requested: string[] | undefined,
  cwd: string,
): string[] =>
  requested?.length && !builtinMcpDisabled(cwd) ? [...new Set(requested)] : [];

const hiddenOrDirect = (toolExposure: unknown) =>
  Object.fromEntries(
    Object.entries(isRecord(toolExposure) ? toolExposure : {}).filter(
      ([, exposure]) => exposure === 'hidden' || exposure === 'direct',
    ),
  );

const asDirect = (config: Raw): Raw => {
  const { exposure, toolExposure, ...rest } = config;
  return {
    ...rest,
    // A server the user hid stays hidden (its `direct` tools still show).
    exposure: exposure === 'hidden' ? 'hidden' : 'direct',
    toolExposure: hiddenOrDirect(toolExposure),
  };
};

/**
 * The `loadConfig` of a child's MCP extension: only `servers`, enabled ones,
 * every tool declared to the model (`direct`) so no codemode or tool_search
 * is needed. Tools the user marked `hidden` stay hidden. The project's
 * `.pi/mcp.json` counts only for a project both this session and Pi's trust
 * store trust.
 */
export const childMcpConfig =
  (servers: string[]) =>
  (
    ctx: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
  ): LoadedMcpConfig => {
    const agentDir = pi.getAgentDir();
    const trusted = ctx.isProjectTrusted() && projectTrusted(agentDir, ctx.cwd);
    const found = readServers(agentDir, ctx.cwd, trusted);
    const wanted = new Set(servers.map(namespaceOf));
    const entries: McpServerEntry[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const [name, { config, scope, source }] of found) {
      if (!wanted.has(namespaceOf(name))) continue;
      seen.add(namespaceOf(name));
      if (config.enabled === false) continue;
      entries.push({
        name,
        config: asDirect(config) as unknown as McpServerEntry['config'],
        source,
        scope,
      });
    }
    for (const name of servers) {
      if (!seen.has(namespaceOf(name))) {
        errors.push(`MCP server "${name}" is not configured`);
      }
    }
    return { servers: entries, autoEnableCodemode: false, errors };
  };

/** The child's MCP extension: Pi's built-in one, restricted to `servers`. */
export const childMcpExtension = (servers: string[]) =>
  pi.createMcpExtension({ loadConfig: childMcpConfig(servers) });
