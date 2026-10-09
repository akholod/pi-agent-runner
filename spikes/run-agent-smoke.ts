// Live smoke for T06: `/runner-smoke <model|-> [packages,csv|-] [timeoutMs|-] [cancelMs|-]`
// Appends one JSON line per run to /tmp/runner-smoke.log.
import * as fs from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runAgent } from '../src/index.ts';

const LOG = '/tmp/runner-smoke.log';

const handles = () =>
  (process as unknown as { _getActiveHandles(): object[] })
    ._getActiveHandles()
    .map((h) => h.constructor?.name ?? '?')
    .sort()
    .join(',');

export default function (api: ExtensionAPI) {
  const disposed: string[] = [];
  api.events.on('subagents:child:disposed', (d) =>
    disposed.push((d as { sessionId: string }).sessionId),
  );
  api.registerCommand('runner-smoke', {
    description: 'Smoke test for runAgent',
    handler: async (args, ctx) => {
      const [model, packages, timeout, cancel] = (args ?? '')
        .trim()
        .split(/\s+/)
        .map((a) => (a === '-' || a === '' ? undefined : a));
      const controller = new AbortController();
      if (cancel) setTimeout(() => controller.abort(), Number(cancel));
      const before = handles();
      const updates: unknown[] = [];
      const result = await runAgent({
        parent: { events: api.events, ctx },
        cwd: ctx.cwd,
        systemPrompt: 'You are a terse test agent. Answer in one short line.',
        task:
          process.env.SMOKE_TASK ??
          'Use the ls tool on the current directory once, then reply: RUNNER_OK <number of entries>',
        tools: process.env.SMOKE_TOOLS?.split(',') ?? ['read', 'ls'],
        model,
        extensions: packages ? { packages: packages.split(',') } : 'none',
        result: process.env.SMOKE_SCHEMA
          ? { kind: 'structured', schema: JSON.parse(process.env.SMOKE_SCHEMA) }
          : { kind: 'text' },
        timeoutMs: timeout ? Number(timeout) : undefined,
        toolTimeoutMs: process.env.SMOKE_TOOL_TIMEOUT
          ? Number(process.env.SMOKE_TOOL_TIMEOUT)
          : undefined,
        readRoots: process.env.SMOKE_READ_ROOTS?.split(','),
        gitGuard: process.env.SMOKE_GIT_GUARD !== '0',
        permissionAsks: process.env.SMOKE_ASKS === 'deny' ? 'deny' : 'forward',
        signal: controller.signal,
        onUpdate: (u) => updates.push(u),
      });
      await new Promise((r) => setTimeout(r, 300));
      const entry = {
        args,
        ...result,
        updates: updates.length,
        lastUpdate: updates.at(-1),
        disposedEvents: disposed.length,
        handlesBefore: before,
        handlesAfter: handles(),
      };
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
      ctx.ui.notify(JSON.stringify(entry), 'info');
    },
  });
}
