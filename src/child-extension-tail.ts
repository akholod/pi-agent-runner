// Loaded into a `backend: 'process'` child with `-e`, last among the
// extensions: the prompt freeze, the tool-start signal (after every gate
// passed) and `submit_result`. The parent learns about the last two through
// Pi's RPC extension-UI sub-protocol (see child-config.ts).
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  SUBMIT_TITLE,
  TAIL_COMMAND,
  TOOL_START_PREFIX,
  readChildConfig,
} from './child-config.ts';
import { freezeHook, submitResultTool } from './session.ts';
import type { Submission } from './structured.ts';

export default (api: ExtensionAPI) => {
  const { resultSchema } = readChildConfig();
  freezeHook.factory(api);
  api.registerCommand(TAIL_COMMAND, {
    description: 'Marker: the pi-agent-runner tail hooks are loaded',
    handler: () => Promise.resolve(),
  });
  api.on('tool_call', (event, ctx) => {
    if (!event.parentToolCallId) {
      const call = { toolCallId: event.toolCallId, toolName: event.toolName };
      ctx.ui.notify(`${TOOL_START_PREFIX}${JSON.stringify(call)}`, 'info');
    }
    return undefined;
  });
  if (!resultSchema) return;
  // The parent validates and counts; the answer is its Submission as JSON.
  submitResultTool({
    schema: resultSchema,
    async onSubmit(value, ctx): Promise<Submission> {
      const answer = await ctx.ui.input(
        SUBMIT_TITLE,
        JSON.stringify(value) ?? 'null',
      );
      if (answer === undefined) {
        return { accepted: false, error: 'the parent did not answer' };
      }
      return JSON.parse(answer) as Submission;
    },
  }).factory(api);
};
