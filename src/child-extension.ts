// Loaded into a `backend: 'process'` child with `-e`, first among the
// extensions: the runner's guard, so a refused call never reaches a
// permission gate. The last-word hooks live in child-extension-tail.ts.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { GUARD_COMMAND, readChildConfig } from './child-config.ts';
import { guardHook } from './session.ts';

export default (api: ExtensionAPI) => {
  const { guard } = readChildConfig();
  guardHook({ guard }).factory(api);
  api.registerCommand(GUARD_COMMAND, {
    description: 'Marker: the pi-agent-runner guard is loaded',
    handler: () => Promise.resolve(),
  });
};
