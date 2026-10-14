import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { dangerousGitCommand, guardDecision } from '../src/guards.ts';
import type { GuardConfig } from '../src/guards.ts';

const blocked: Array<[string, string]> = [
  ['git push', 'git push'],
  ['git push --force origin main', 'git push'],
  ['cd x && git push origin main', 'git push'],
  ['FOO=1 sudo git -C repo push', 'git push'],
  ['git --no-pager -c a=b push', 'git push'],
  ['/usr/bin/git --git-dir=x push', 'git push'],
  [`bash -c 'git reset --hard'`, 'git reset --hard'],
  ['echo $(git push)', 'git push'],
  ['echo `git push`', 'git push'],
  ['eval git push', 'git push'],
  ['ls | git push', 'git push'],
  ['git reset --hard HEAD~1', 'git reset --hard'],
  ['git clean -f', 'git clean -f'],
  ['git clean -xdf', 'git clean -f'],
  ['git clean --force', 'git clean -f'],
  ['git branch -D x', 'git branch -D'],
  ['git branch --delete --force b', 'git branch -D'],
  ['git branch -df b', 'git branch -D'],
  ['git checkout -- .', 'git checkout (discarding changes)'],
  ['git checkout .', 'git checkout (discarding changes)'],
  ['git checkout -f main', 'git checkout (discarding changes)'],
  ['git restore .', 'git restore (discarding changes)'],
  ['git restore --staged --worktree x', 'git restore (discarding changes)'],
  ['git stash clear', 'git stash drop/clear'],
  ['git stash drop', 'git stash drop/clear'],
];

const allowed = [
  'git status',
  'git commit -m "git push later"',
  'git checkout -b feature',
  'git checkout main',
  'git branch -d merged',
  'git restore --staged x',
  'git reset --soft HEAD~1',
  'git reset HEAD file',
  'git clean -n',
  'echo git push',
  'grep "git push" file',
  `echo 'git reset --hard'`,
  'git stash',
  'git stash pop',
  'ls',
  '',
];

for (const [command, description] of blocked) {
  test(`blocks: ${command}`, () => {
    assert.equal(dangerousGitCommand(command), description);
  });
}

for (const command of allowed) {
  test(`allows: ${command}`, () => {
    assert.equal(dangerousGitCommand(command), undefined);
  });
}

const config = (extra: Partial<GuardConfig> = {}): GuardConfig => ({
  git: true,
  cwd: '/work/proj',
  ...extra,
});
const call = (toolName: string, input: unknown = {}) => ({ toolName, input });

test('allowlist blocks tools outside it', () => {
  const guard = config({ allowedTools: ['read', 'grep', 'find', 'ls'] });
  for (const name of ['bash', 'edit', 'write']) {
    assert.equal(
      guardDecision(guard, call(name)),
      `tool '${name}' is not allowed for this agent`,
    );
  }
  assert.equal(guardDecision(guard, call('read')), undefined);
});

test('submit_result passes when it is in the allowlist', () => {
  const guard = config({ allowedTools: ['read', 'submit_result'] });
  assert.equal(guardDecision(guard, call('submit_result')), undefined);
});

test('no allowlist allows any tool', () => {
  assert.equal(guardDecision(config(), call('whatever')), undefined);
});

test('git guard applies to bash and to any tool with a command', () => {
  const input = { command: 'git push' };
  const reason =
    'blocked by pi-agent-runner: git push is not allowed in a child agent';
  assert.equal(guardDecision(config(), call('bash', input)), reason);
  assert.equal(guardDecision(config(), call('other', input)), reason);
  assert.equal(
    guardDecision(config({ git: false }), call('bash', input)),
    undefined,
  );
  assert.equal(
    guardDecision(config(), call('bash', { command: 'git status' })),
    undefined,
  );
});

test('read roots: cwd, listed roots and ~/ roots are fine', () => {
  const guard = config({ readRoots: ['/data', '~/notes'] });
  const ok = (path: string) =>
    assert.equal(guardDecision(guard, call('read', { path })), undefined);
  ok('src/a.ts');
  ok('/work/proj/a.ts');
  ok('/data/x/y');
  ok(`${os.homedir()}/notes/a.md`);
  ok('~/notes/a.md');
  assert.equal(guardDecision(guard, call('ls')), undefined);
});

test('read roots: outside paths are refused', () => {
  const guard = config({ readRoots: ['/data'] });
  const outside = (input: unknown, shown: string) =>
    assert.equal(
      guardDecision(guard, call('read', input)),
      `path '${shown}' is outside this agent's read roots`,
    );
  outside({ path: '../x' }, '../x');
  outside({ path: '/etc/passwd' }, '/etc/passwd');
  outside({ path: '/work/proj/../other' }, '/work/proj/../other');
  outside({ paths: ['a', '/etc/hosts'] }, '/etc/hosts');
});

test('read roots unset means no restriction', () => {
  assert.equal(
    guardDecision(config(), call('read', { path: '/etc/passwd' })),
    undefined,
  );
});

const guard = (allowedTools: string[]): GuardConfig => ({
  allowedTools,
  git: true,
  cwd: '/w',
});

test('tool patterns: a trailing * admits the prefix', () => {
  const config = guard(['read', 'mcp__codegraph__*']);
  const call = (toolName: string) =>
    guardDecision(config, { toolName, input: {} });
  assert.equal(call('mcp__codegraph__explore'), undefined);
  assert.equal(call('mcp__codegraph__'), undefined);
  assert.equal(call('read'), undefined);
});

test('tool patterns: other servers and exact names stay refused', () => {
  const config = guard(['read', 'mcp__codegraph__*']);
  const reason = (toolName: string) =>
    guardDecision(config, { toolName, input: {} });
  assert.match(reason('mcp__other__explore') ?? '', /not allowed/);
  assert.match(reason('mcp__codegraph') ?? '', /not allowed/);
  assert.match(reason('xmcp__codegraph__x') ?? '', /not allowed/);
  assert.match(reason('bash') ?? '', /not allowed/);
  // An exact entry is not a prefix.
  assert.match(
    guardDecision(guard(['read']), { toolName: 'readx', input: {} }) ?? '',
    /not allowed/,
  );
});

test('tool patterns: * inside a name and regex characters', () => {
  const config = guard(['mcp__a_b__get_*', 'a.b']);
  const reason = (toolName: string) =>
    guardDecision(config, { toolName, input: {} });
  assert.equal(reason('mcp__a_b__get_x'), undefined);
  assert.notEqual(reason('mcp__a_b__set_x'), undefined);
  assert.equal(reason('a.b'), undefined);
  assert.notEqual(reason('axb'), undefined);
});

test('tool patterns: nested calls are checked the same way', () => {
  const config = guard(['codemode', 'mcp__codegraph__*']);
  const nested = (toolName: string) =>
    guardDecision(config, {
      toolName,
      input: {},
      parentToolCallId: 'call-1',
    } as { toolName: string; input: unknown });
  assert.equal(nested('mcp__codegraph__explore'), undefined);
  assert.match(nested('mcp__other__explore') ?? '', /not allowed/);
});
