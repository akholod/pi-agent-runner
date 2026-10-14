// A tiny stdio MCP server for tests: newline-delimited JSON-RPC, one tool
// `echo` that returns `echo:<text>`. MCP_ECHO_PIDFILE receives its pid.
import * as fs from 'node:fs';
import * as readline from 'node:readline';

if (process.env.MCP_ECHO_PIDFILE) {
  fs.writeFileSync(process.env.MCP_ECHO_PIDFILE, String(process.pid));
}

const send = (record) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...record })}\n`);

const tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
];

const handle = (message) => {
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-echo', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ id, result: { tools } });
  } else if (method === 'tools/call') {
    const text = `echo:${params?.arguments?.text ?? ''}`;
    send({ id, result: { content: [{ type: 'text', text }] } });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `unknown ${method}` } });
  }
};

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    handle(JSON.parse(line));
  } catch {
    // Ignore malformed input.
  }
});
process.stdin.on('end', () => process.exit(0));
