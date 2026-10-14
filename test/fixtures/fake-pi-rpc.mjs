// A stand-in for `pi --mode rpc` that speaks just enough of the protocol.
// The prompt text picks the scenario; env tunes the misbehaviour:
//   FAKE_PIDFILE         where {pid, grandchild} is written (stuck scenario)
//   FAKE_LOG             appended with `term` on SIGTERM
//   FAKE_IGNORE_SHUTDOWN stdin close does not end the process
//   FAKE_IGNORE_TERM     SIGTERM is ignored
//   FAKE_CONFIG_COPY     receives a copy of the child config file
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const messages = [];

if (process.env.FAKE_IGNORE_TERM) {
  process.on('SIGTERM', () => {
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, 'term\n');
  });
}

if (process.env.FAKE_CONFIG_COPY) {
  fs.copyFileSync(
    process.env.PI_AGENT_RUNNER_CHILD_CONFIG,
    process.env.FAKE_CONFIG_COPY,
  );
}

const assistant = (text, extra = {}) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: 0.5 },
  },
  ...extra,
});

const answer = (text) => {
  const message = assistant(text);
  messages.push(message);
  out({ type: 'message_end', message });
  out({ type: 'turn_end', message, toolResults: [] });
  out({ type: 'agent_end', messages: [message], willRetry: false });
  out({ type: 'agent_settled', aborted: false });
};

const begin = (text) => {
  const user = { role: 'user', content: text };
  messages.push(user);
  out({ type: 'agent_start' });
  out({ type: 'turn_start' });
  out({ type: 'message_end', message: user });
};

const callTool = (toolName) => {
  const call = { toolCallId: 'call-1', toolName };
  out({
    type: 'extension_ui_request',
    id: 'ts-1',
    method: 'notify',
    message: `pi-agent-runner:tool-start ${JSON.stringify(call)}`,
  });
  out({ type: 'tool_execution_start', ...call, args: {} });
};

const waiting = new Map();
const ask = (request) =>
  new Promise((resolve) => {
    waiting.set(request.id, resolve);
    out({ type: 'extension_ui_request', ...request });
  });

const scenarios = {
  normal: () => answer('hello'),
  stuck: () => {
    callTool('bash');
    // Same process group; ignores everything.
    const grandchild = spawn('sleep', ['1000'], { stdio: 'ignore' });
    fs.writeFileSync(
      process.env.FAKE_PIDFILE,
      JSON.stringify({ pid: process.pid, grandchild: grandchild.pid }),
    );
  },
  exit: () => process.exit(3),
  ask: async () => {
    const reply = await ask({
      id: 'ui-1',
      method: 'select',
      title: 'Allow it?',
      options: ['Yes', 'No'],
    });
    answer(`answer:${reply.cancelled ? 'cancelled' : reply.value}`);
  },
  submit: async () => {
    const reply = await ask({
      id: 'sub-1',
      method: 'input',
      title: 'pi-agent-runner:submit',
      placeholder: JSON.stringify({ n: 7 }),
    });
    answer(`submitted:${reply.value}`);
  },
  slow: () => {
    // Ends only when aborted.
  },
  wrap: () => {
    // Ends when steered, answering with the steer text; or when aborted.
  },
};

let slowActive = false;
let wrapActive = false;

const handle = (command) => {
  const reply = (data) =>
    out({
      id: command.id,
      type: 'response',
      command: command.type,
      success: true,
      data,
    });
  switch (command.type) {
    case 'get_state':
      reply({
        sessionId: 'fake-session',
        model: { provider: 'fake', id: 'model' },
      });
      break;
    case 'get_commands':
      reply({
        commands: process.env.FAKE_NO_MARKERS
          ? []
          : [
              { name: 'pi-agent-runner-guard' },
              { name: 'pi-agent-runner-tail' },
            ],
      });
      break;
    case 'get_messages':
      reply({ messages });
      break;
    case 'prompt': {
      reply({ disposition: 'started' });
      const name = command.message.match(/scenario:(\w+)/)?.[1] ?? 'normal';
      begin(command.message);
      slowActive = name === 'slow' || name === 'wrap';
      wrapActive = name === 'wrap';
      scenarios[name]();
      break;
    }
    case 'abort':
      if (slowActive) {
        slowActive = false;
        out({ type: 'agent_settled', aborted: true });
      }
      // `stuck` ignores abort and never answers.
      break;
    case 'steer':
      reply({});
      if (wrapActive) {
        wrapActive = false;
        slowActive = false;
        answer(`steered:${command.message}`);
      }
      break;
    case 'clear_queue':
      reply({ steering: [], followUp: [] });
      break;
    default:
      reply({});
  }
};

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const record = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (record.type === 'extension_ui_response') {
      waiting.get(record.id)?.(record);
      waiting.delete(record.id);
    } else {
      handle(record);
    }
  }
});
process.stdin.on('end', () => {
  if (process.env.FAKE_IGNORE_SHUTDOWN) {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
