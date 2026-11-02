// Binds the local devDependency packages as the host runtime. Import it for
// its side effect from every test that touches the runtime; each test file
// runs in its own process, so nothing leaks between files.
import * as pi from '@earendil-works/pi-coding-agent';
import * as tui from '@earendil-works/pi-tui';
import { Unsafe } from 'typebox';
import { Compile } from 'typebox/compile';
import { bindHostRuntime } from '../src/host-runtime.ts';
import type { HostRuntime } from '../src/host-runtime.ts';

export const localHost: HostRuntime = { pi, tui, typebox: { Unsafe, Compile } };

bindHostRuntime(localHost);
