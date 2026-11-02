# Design: host-owned runtime for pi-agent-runner

Status: accepted, in implementation (runner 0.11.0, Opium 0.5.0, Spiral 0.3.0).

**Decision:** explicit dependency injection via `bindHostRuntime(...)`, called
from the `.ts` entry point of every consuming Pi extension. Existing
`runAgent`, `startAgent`, UI and MCP APIs stay. The runtime lives in a small
process-wide registry compatible with several physical runner copies. **No
fallback to the runner's own `import('@earendil-works/...')`.**

## 0. Problem

Pi loads extension `.ts` files through jiti with aliases / virtual modules that
map `@earendil-works/*`, `typebox` and `typebox/compile` to the host copies.
That mapping applies only to the extension's own source; files inside
`node_modules` are imported natively. Verified on Pi 1.5.0 with a probe
extension: the extension source saw `VERSION=1.5.0`, a module in
`opium/node_modules` importing `@earendil-works/pi-coding-agent` saw `1.1.0`
(the consumer's local devDependency).

So every value import in the compiled runner resolves to whatever copy sits
next to it. All in-process children (Opium specialists, council, vision; Spiral
planner/architect/critic/ralph) ran on the stale engine: stale model catalog,
missing host fixes, child extensions loaded by a stale loader, and host objects
(parent ctx, theme, TUI) mixed with stale classes.

## 1. Findings

### Runtime imports to remove

| Runner file                   | Use                                |
| ----------------------------- | ---------------------------------- |
| `src/session.ts:7,13`         | SDK, `Unsafe`                      |
| `src/mcp.ts:7`                | MCP factory, trust store, agentDir |
| `src/view.ts:12–17`           | TUI formatting                     |
| `src/agents-command.ts:23–31` | keys, wrapping, truncation         |
| `src/pane-viewer.ts:11`       | truncation                         |
| `src/structured.ts:3`         | `Compile` from `typebox/compile`   |

`src/types.ts` already uses `import type`.

### Process backend is not tied to the host installation

`src/process-session.ts:169–174` defaults to `['pi']` and `spawn()` resolves it
through `PATH` (global `pi`, local `node_modules/.bin/pi` or anything else).

### Several runner copies are already anticipated

Shared via `Symbol.for(...)`: live registry (`src/live.ts`), nesting depth
(`src/run-agent.ts`), widget ownership (`src/view.ts`), pane ownership
(`src/panes.ts`), `/agents` ownership (`src/agents-command.ts`). But
`humanWaitTracker` caches in a module-local WeakMap (`src/human-wait.ts`), and
the session-loading queue is module-local despite its "process-wide" comment
(`src/session.ts:478–480`) — this matters once both copies use one host loader.

### npm peers

Host 1.5.0 suppresses automatic peer installation for Pi-managed npm/git
installs (host `docs/packages.md`, `docs/extensions.md`). Auto-installed peers
remain a risk for plain `npm install` and local development. Peer metadata
never redirects native ESM imports to host virtual modules.

## 2. Alternatives

| Option                       | Verdict                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Explicit DI + registry**   | **Chosen.** Keeps the compiled ESM package and almost every consumer import.                                                            |
| `createRunner(host)` closure | Clean isolation, but the instance would have to be threaded through Opium modules and UI helpers. Unneeded migration now.               |
| Publish/export `.ts`         | No guarantee of jiti transformation inside `node_modules` (Node 24 strips types natively); ties the npm API to a loader implementation. |
| Extension re-export/alias    | Re-exporting in the extension does not rewrite native imports of the compiled runner.                                                   |
| `ExtensionAPI` / `ctx`       | No session factory exposed; `ctx.newSession()` replaces the interactive session, not a background child.                                |
| Packaging-only               | Hygiene, not a module-identity fix.                                                                                                     |

The host loader maps SDK, TUI, `typebox` and `typebox/compile`
(`dist/core/extensions/loader.js`, `virtual-modules.js`); `docs/sdk.md`
documents `createAgentSession`, `ModelRuntime`, `DefaultResourceLoader`. The
official `examples/extensions/subagent` spawns a subprocess with the current
executable. Importing the SDK in extension `.ts` and handing it to the library
is the right integration boundary.

## 3. Public API

```ts
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

export function bindHostRuntime(host: HostRuntime): void;
export function getHostRuntimeInfo(): HostRuntimeInfo;

type PiRuntime = Pick<
  typeof import('@earendil-works/pi-coding-agent'),
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
>;

type TuiRuntime = Pick<
  typeof import('@earendil-works/pi-tui'),
  'Key' | 'matchesKey' | 'truncateToWidth' | 'visibleWidth' | 'wrapTextWithAnsi'
>;
```

The exact `Pick` lists follow what the runner really uses. `pi-ai` is not
injected: host `ModelRuntime` and `createAgentSession` already close over the
host AI implementation. Add a concrete capability later only if needed.

Binding in a consumer (illustrative):

```ts
import * as hostPi from '@earendil-works/pi-coding-agent';
import * as hostTui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from 'pi-agent-runner';

export default function extension(api: hostPi.ExtensionAPI) {
  bindHostRuntime({ pi: hostPi, tui: hostTui, typebox: { Unsafe, Compile } });
  // existing initialization follows
}
```

Opium binds before `createOpium(api)`; Spiral before any runner UI
registration or delegation.

## 4. Registry, reload, errors

- One slot: `Symbol.for('pi-agent-runner:host-runtime:v1')` holding protocol
  version, validated runtime references, compatibility warnings and the shared
  session-loading promise. No parent ctx, extension API, events or per-run
  settings.
- First valid binding installs the runtime; rebinding the same capabilities is
  a no-op; different implementations throw `HOST_CONFLICT`. Compare references
  of the used functions/classes, not namespace objects (jiti may return
  different wrappers). Equal `VERSION` does not prove identity.
- Keep the protocol small and append-only.
- No unbind on `session_shutdown`; `/reload` rebinds idempotently. A changed
  runtime inside a live process is an error recommending a Pi restart.
- Importing the runner works without binding; nothing reads the host at module
  evaluation. The internal accessor throws
  `PI_AGENT_RUNNER_HOST_UNBOUND: Call bindHostRuntime() from the Pi extension
entry before using the runtime.`
- `bindHostRuntime`: synchronous error on incompatibility/conflict.
  `createPiSessionFactory`: fail fast before creating resources. `startAgent`:
  rejected initialization. `runAgent`: `status: 'failed'` with diagnostics.
  Pure helpers and `liveRuns()` need no host. An injected fake session factory
  keeps working without binding. Check binding before creating transcript
  directories, timers or live-run entries.

## 5. Runner internals

- `session.ts`, `mcp.ts`: `const { pi } = requireHostRuntime();` at call time;
  SDK types via `import type`. Session policy unchanged: each child still gets
  its own ModelRuntime, SessionManager, resources and provider inheritance.
- `structured.ts`: `Unsafe` and `Compile` from the host, fetched outside the
  `try/catch` that maps compile errors to `invalid result schema`.
- `view.ts`, `agents-command.ts`: injected TUI functions, no top-level
  constants from runtime lookups. No home-grown ANSI wrapping.
- Move the session-loading queue into the shared slot so two runner copies'
  `loader.reload()` calls do not interleave. Do not extend the lock to child
  lifetime or prompting.

## 6. Process boundaries

### 6.1 Process sessions

A. Launch the concrete host CLI: use injected `pi.getPackageDir()`, read that
installation's manifest, check package name and that its version matches the
injected `VERSION`, take `bin.pi`, run `[process.execPath, absoluteHostBin]`.
Precedence: factory `command` → bound `processCommand` → verified host CLI. No
silent fallback to `['pi']`; if the installation cannot be determined, require
an explicit command.

B. Binding inside the child: in the existing temp directory generate small
`.ts` extension wrappers outside `node_modules` for guard/MCP/tail. Each
wrapper imports SDK, TUI, `Unsafe`, `Compile` through the child host loader,
checks the child `VERSION` against the parent's, calls `bindHostRuntime`, and
delegates to the compiled child extension by absolute file URL. One wrapper
template. Order stays guard → caller extensions → installed extensions → MCP →
tail. Keep the `GUARD_COMMAND` / `TAIL_COMMAND` check; the runner must detect a
missing binding/guard and stop the child before the first prompt.

### 6.2 Pane viewer

The viewer is a separate `node` process (`src/panes.ts`) without the parent
registry. Renderer helpers that need wrapping/truncation take a small
`TextRuntime`; the main runner passes host TUI; the standalone viewer receives
an explicit host-owned TUI module URL via argv, resolved relative to the host
installation, imports it and passes the functions in. If no filesystem TUI
entry exists, disable panes with a clear warning; never pick another copy.

## 7. Shared state between Opium and Spiral

| State                           | Decision                                                                    |
| ------------------------------- | --------------------------------------------------------------------------- |
| Host capabilities               | One process-wide binding with identity checks                               |
| Live runs / activity / controls | Keep the existing `live:v1` store                                           |
| Nesting depth                   | Keep the shared AsyncLocalStorage                                           |
| Widget / pane ownership         | Keep the shared stores                                                      |
| `/agents` registration          | Keep the ownership/release mechanism                                        |
| Session loading                 | Make it truly process-wide                                                  |
| Human wait                      | Per events facade; Spiral also calls `humanWaitTracker(api.events)` at init |

Host 1.5 gives each extension its own `api.events` facade and drops
subscriptions on invalidation, so a global WeakMap would not unify them. An old
0.10.x runner copy will not start using the host because a new copy is bound:
both consumers must upgrade.

## 8. Compatibility, packaging, doctor

- At binding, check required exports and static methods (`ModelRuntime.create`,
  `SettingsManager.create`, `SessionManager.open/inMemory`, ResourceLoader /
  PackageManager constructors, session factory, TUI functions, `Unsafe`,
  `Compile`). Errors name the missing capability and host version.
- Below documented minimum → fail; missing capability → fail; newer untested
  version → warning; same version, different identities → fail; unparseable
  version → warning (capability checks still run). Tested: 1.1.0 baseline and
  1.5.0.
- `getHostRuntimeInfo()` returns
  `{ bound: false } | { bound: true; source: 'injected'; hostVersion; testedVersions; warnings }`.
- Packaging: keep compiled `dist/` and the `"."` export; host packages stay
  peers, never dependencies or bundled; add `peerDependenciesMeta.optional`;
  dev baseline 1.5.0. Stale local copies become harmless.
- Semver: runner 0.11.0 (mandatory init is breaking for 0.x), Opium 0.5.0,
  Spiral 0.3.0; consumers depend on `^0.11.0`. No automatic legacy fallback.
- Opium doctor reports host version, binding status/source, effective runner
  runtime version, warnings, and optionally the native candidate found by
  metadata-only resolution (never imported):

  ```text
  Host Pi:               1.5.0
  Runner runtime:        1.5.0 — injected host
  Native Pi candidate:   1.1.0 — installed, not used
  ```

  Legacy runner without the diagnostic export → `runtime unverified`. Update
  `RUNNER_EXPORTS` in `opium/src/doctor.ts` and its test.

## 9. Verification

Unit: import without host packages; poison local Pi packages that throw on
evaluation; fake host spies for SDK/MCP/`Unsafe`/`Compile`/TUI; unbound errors
before side effects; rebinding through different namespace wrappers; conflict
with same `VERSION`; two physical package trees sharing one binding, live runs,
UI ownership and serialized loading; reload; process backend ignores a hostile
`PATH` and blocks the prompt on version mismatch or failed bootstrap; pane
viewer without the parent registry. Run tests with different fake hosts in
separate processes; no public reset helper.

Live on real Pi 1.5.0 with a stale 1.1.0 copy left beside it: extension source
sees 1.5.0; a native probe still finds 1.1.0; runner diagnostics report injected
1.5.0; a child extension loaded by the host ResourceLoader reports 1.5.0; a
model present in the host catalog but absent from 1.1.0 is selectable;
structured output, permissions, MCP, cancellation, UI and panes work; Opium and
Spiral together in both load orders and after `/reload`. The existing
`test/live.test.ts` imports the local SDK and does not exercise this boundary.

Release: runner build, typecheck, lint, unit, packed-package integration;
consumers typecheck, lint, unit, live acceptance. AST-check emitted `dist/*.js`
for executable bare imports of host packages (generated wrappers excepted).

## 10. Plan

| Phase                     | Files                                                                                                                                  |                 Size |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------: |
| 1. DI core                | runner: new `src/host-runtime.ts`; `index.ts`, `session.ts`, `mcp.ts`, `structured.ts`, `view.ts`, `agents-command.ts`, `run-agent.ts` |              200–350 |
| 2. Process boundaries     | runner: `process-session.ts`, `child-config.ts`, wrapper template; `pane-viewer.ts`, `panes.ts`, text-rendering seam                   |              150–300 |
| 3. Consumers              | Opium `extensions/opium.ts`, `src/doctor-env.ts`, `src/doctor.ts`; Spiral `extensions/spiral.ts`                                       |               80–150 |
| 4. Verification / release | tests, manifests, README, `docs/reference.md`                                                                                          | 350–650 tests + docs |

Risks: cross-copy `instanceof`; TypeBox identity (inject factory and compiler);
TUI identity; AI registries (no separate `pi-ai` import); loader internals on
1.5; third-party compiled extensions with their own runtime imports remain a
separate problem (native `importExtensionFactories()` in `session.ts` gives no
host-aliasing guarantee for arbitrary caller modules).

Acceptance: any Pi version installed next to the runner — or none — no longer
affects the runtime the runner uses; its only source of in-process SDK
capabilities is the explicit host binding.
