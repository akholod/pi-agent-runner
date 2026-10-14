// Loaded into a `backend: 'process'` child with `-e` when it gets built-in MCP
// servers: Pi's MCP extension restricted to the servers in the child config.
// `-e builtin:mcp` would connect every enabled server of the user instead.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readChildConfig } from './child-config.ts';
import { childMcpExtension } from './mcp.ts';

export default (api: ExtensionAPI) => {
  const { mcpServers } = readChildConfig();
  if (mcpServers?.length) childMcpExtension(mcpServers)(api);
};
