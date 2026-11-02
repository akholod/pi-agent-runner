# Changelog

## [0.11.0]

### Breaking

- The host runtime must be bound. Call `bindHostRuntime({ pi, tui, typebox })`
  from the `.ts` entry of every extension that uses the runner, before any
  other runner API. Without it, `runAgent` returns `failed`, `startAgent`
  rejects and `createPiSessionFactory()` throws, with
  `PI_AGENT_RUNNER_HOST_UNBOUND`. The runner no longer imports Pi's SDK,
  `@earendil-works/pi-tui` or `typebox` for values, so it uses the copy the host
  loaded instead of one installed beside it in `node_modules`.
- The process backend no longer runs `pi` from `PATH` by default. The command
  is now the factory's `command`, then the bound `processCommand`, then the CLI
  of the bound host (`[process.execPath, <bin.pi>]` from `pi.getPackageDir()`,
  checked against the bound `VERSION`). If none can be determined, the run
  fails or `startAgent` rejects and asks for an explicit command.

### Added

- `bindHostRuntime`, `getHostRuntimeInfo` and the `HostRuntime` type, with
  optional `processCommand`.
- `HOST_CONFLICT` error when a different host runtime is bound in the same
  process. Several copies of the runner share one binding.
- Version policy: hosts below Pi 1.1.0 are refused; untested versions bind with
  a warning (tested: 1.1.0, 1.5.0).
- Generated child entry points for the process backend: they bind the host
  runtime inside the child and fail if the child's Pi version differs from the
  parent's.
- The pane viewer imports the host's own pi-tui module, passed as a `file:` URL
  (`tuiModule` option on `mountPanes` overrides it).

### Changed

- The host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`, `typebox`) are optional peer dependencies.
- Development baseline is Pi 1.5.
- Panes are disabled with a warning when no host TUI module can be found.
- `CHANGELOG.md` is included in the published package.

### Fixed

- Process backend startup: one `startTimeoutMs` deadline now covers the whole
  handshake (state, marker check, first message list), so a child that answers
  some requests and stalls on the rest can no longer hang the start.
- The session-loading queue is shared by all runner copies in a process, so two
  copies no longer load child extensions at the same time.

## [0.10.1]

Previous release.
