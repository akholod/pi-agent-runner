// Opt-in live smoke test against real models: `npm run test:live`.
// RUNNER_LIVE_MODELS (comma-separated `provider/id`) picks the models;
// every case runs once per model. Uses the operator's ~/.pi/agent auth.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as pi from '@earendil-works/pi-coding-agent';
import { runAgent } from '../src/index.ts';
import type { ParentContext, RunAgentOptions } from '../src/index.ts';

const LIVE = process.env.RUNNER_LIVE === '1';
const MODELS = (
  process.env.RUNNER_LIVE_MODELS ??
  'openai-codex/gpt-6-luna,claude-bridge/claude-sonnet-5-5'
).split(',');
const TIMEOUT = { timeout: 180_000 };

// A parent without a Pi process: providers come from auth/models.json only,
// extension providers (claude-bridge) load inside the child.
const parentContext = async (cwd: string): Promise<ParentContext> => {
  const runtime = await pi.ModelRuntime.create();
  return {
    events: pi.createEventBus(),
    ctx: {
      cwd,
      model: undefined,
      thinkingLevel: undefined,
      modelRegistry: new pi.ModelRegistry(runtime),
      sessionManager: pi.SessionManager.inMemory(cwd),
    },
  };
};

const workspace = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-live-'));
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
    fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  }
  return cwd;
};

describe('live runAgent', { skip: !LIVE && 'set RUNNER_LIVE=1' }, () => {
  for (const model of MODELS) {
    const options = async (
      extra: Partial<RunAgentOptions>,
    ): Promise<RunAgentOptions> => {
      const cwd = workspace();
      return {
        parent: await parentContext(cwd),
        cwd,
        model,
        systemPrompt: 'You are a terse test agent. Answer in one line.',
        task: '',
        tools: ['read', 'ls'],
        timeoutMs: 120_000,
        ...extra,
      };
    };

    test(`${model}: text child uses a tool`, TIMEOUT, async () => {
      // Outside cwd: the file appears with the first message, before `ls`.
      const transcript = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'runner-live-log-')),
        'child.jsonl',
      );
      const result = await runAgent(
        await options({
          task: 'Use ls once, then reply exactly: LIVE_OK <number of files>',
          transcriptPath: transcript,
        }),
      );
      assert.equal(result.status, 'completed', result.error);
      assert.match(String(result.value), /LIVE_OK 3/);
      assert.equal(result.model, model);
      assert.ok(result.usage.toolCalls >= 1);
      assert.ok(result.usage.output > 0);
      assert.equal(result.transcriptPath, transcript);
    });

    test(`${model}: structured child`, TIMEOUT, async () => {
      const result = await runAgent(
        await options({
          task: 'List the files with ls, then submit them sorted.',
          result: {
            kind: 'structured',
            schema: {
              type: 'object',
              properties: {
                files: { type: 'array', items: { type: 'string' } },
              },
              required: ['files'],
              additionalProperties: false,
            },
          },
        }),
      );
      assert.equal(result.status, 'completed', result.error);
      assert.deepEqual(result.value, {
        files: ['alpha.txt', 'beta.txt', 'gamma.txt'],
      });
    });

    test(`${model}: cancelled child`, TIMEOUT, async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1_500);
      const result = await runAgent(
        await options({
          task: 'Read each file one at a time, then write a long essay.',
          signal: controller.signal,
        }),
      );
      assert.equal(result.status, 'cancelled');
    });

    test(`${model}: guard refuses git push`, TIMEOUT, async () => {
      const result = await runAgent(
        await options({
          tools: ['bash'],
          task:
            'Run exactly this bash command once: git push origin HEAD. ' +
            'Then reply with the exact error text you got.',
        }),
      );
      assert.equal(result.status, 'completed', result.error);
      assert.match(String(result.value), /git push is not allowed/);
    });
  }
});

describe('live process backend', { skip: !LIVE && 'set RUNNER_LIVE=1' }, () => {
  test('openai-codex/gpt-6-luna answers a trivial task', TIMEOUT, async () => {
    const cwd = workspace();
    const result = await runAgent({
      parent: await parentContext(cwd),
      cwd,
      model: 'openai-codex/gpt-6-luna',
      backend: 'process',
      systemPrompt: 'You are a terse test agent. Answer in one line.',
      task: 'Reply exactly: PROCESS_OK',
      tools: ['read', 'ls'],
      timeoutMs: 120_000,
    });
    assert.equal(result.status, 'completed', result.error);
    assert.match(String(result.value), /PROCESS_OK/);
    assert.equal(result.model, 'openai-codex/gpt-6-luna');
  });
});

// Built-in MCP in a child: an agent dir of its own (the operator's auth
// linked in) configures the echo server, so no real MCP setup is touched.
describe('live MCP', { skip: !LIVE && 'set RUNNER_LIVE=1' }, () => {
  const model = 'openai-codex/gpt-6-luna';
  const echo = path.join(import.meta.dirname, 'fixtures', 'mcp-echo.mjs');

  const withMcpAgentDir = async (body: (cwd: string) => Promise<void>) => {
    const real = pi.getAgentDir();
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mcp-'));
    for (const name of ['auth.json', 'models.json', 'models-store.json']) {
      if (fs.existsSync(path.join(real, name))) {
        fs.symlinkSync(path.join(real, name), path.join(agentDir, name));
      }
    }
    fs.writeFileSync(
      path.join(agentDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [echo] } },
      }),
    );
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      await body(workspace());
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  };

  for (const backend of ['in-process', 'process'] as const) {
    test(`${backend}: child calls an MCP tool`, TIMEOUT, async () => {
      await withMcpAgentDir(async (cwd) => {
        const result = await runAgent({
          parent: await parentContext(cwd),
          cwd,
          model,
          backend,
          systemPrompt: 'You are a terse test agent. Answer in one line.',
          task:
            'Call the mcp__echo__echo tool with text "ping", then reply ' +
            'exactly: MCP_OK followed by the tool result.',
          tools: ['read'],
          mcpServers: ['echo'],
          timeoutMs: 120_000,
        });
        assert.equal(result.status, 'completed', result.error);
        assert.match(String(result.value), /MCP_OK.*echo:ping/);
        assert.ok(result.usage.toolCalls >= 1);
      });
    });
  }
});
