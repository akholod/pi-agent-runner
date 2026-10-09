// Pure policy for what a child may do. A guardrail against a model's
// mistakes, not a sandbox: pi-permission-system is the real enforcement.
// The guards only refuse early, so a call that would be denied anyway never
// opens a permission dialog.
import os from 'node:os';
import path from 'node:path';

export interface GuardConfig {
  /** Tool names the child may call; undefined = no restriction. */
  allowedTools?: string[];
  /** Block destructive git commands. */
  git: boolean;
  /** Extra roots for path-taking tools; undefined = no restriction. */
  readRoots?: string[];
  cwd: string;
}

const SQ = String.fromCharCode(39);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_ARG_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
]);

interface Parsed {
  commands: string[][];
  nested: string[];
}

// Index of the `)` closing a `$(` whose body starts at `from`, or the end.
const closingParen = (text: string, from: number) => {
  let depth = 1;
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '\\') {
      i++;
    } else if (ch === SQ || ch === '"') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && --depth === 0) {
      return i;
    }
  }
  return text.length;
};

// Simple commands as word lists (quotes removed), plus the bodies of command
// substitutions, which are parsed on their own.
const parse = (script: string): Parsed => {
  const commands: string[][] = [];
  const nested: string[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote = '';
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (quote === SQ) {
      if (ch === SQ) quote = '';
      else word += ch;
      continue;
    }
    if (ch === '\\') {
      word = (word ?? '') + (script[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '$' && script[i + 1] === '(') {
      const end = closingParen(script, i + 2);
      nested.push(script.slice(i + 2, end));
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = script.indexOf('`', i + 1);
      const stop = end === -1 ? script.length : end;
      nested.push(script.slice(i + 1, stop));
      i = stop;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else word += ch;
      continue;
    }
    if (ch === SQ || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch) && ch !== '\n') {
      endWord();
    } else if (';&|\n()'.includes(ch)) {
      endCommand();
    } else {
      word = (word ?? '') + ch;
    }
  }
  endCommand();
  return { commands, nested };
};

const hasShort = (args: string[], letter: string) =>
  args.some((a) => /^-[^-]/.test(a) && a.slice(1).includes(letter));

// Internals return '' for "nothing found".
const gitSubcommandBlocked = (sub: string, args: string[]) => {
  const has = (...flags: string[]) => args.some((a) => flags.includes(a));
  const force = has('--force') || hasShort(args, 'f');
  const checks: Record<string, [boolean, string]> = {
    push: [true, 'git push'],
    reset: [has('--hard'), 'git reset --hard'],
    clean: [force, 'git clean -f'],
    branch: [
      hasShort(args, 'D') ||
        ((has('--delete') || hasShort(args, 'd')) && force),
      'git branch -D',
    ],
    checkout: [
      has('--', '.', '-f', '--force'),
      'git checkout (discarding changes)',
    ],
    restore: [
      !has('--staged', '-S') || has('--worktree', '-W'),
      'git restore (discarding changes)',
    ],
    stash: [args[0] === 'drop' || args[0] === 'clear', 'git stash drop/clear'],
  };
  const [blocked, description] = checks[sub] ?? [false, ''];
  return blocked ? description : '';
};

const checkWords = (
  words: string[],
  scan: (script: string) => string,
): string => {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return '';
    if (ASSIGNMENT.test(w)) {
      i++;
    } else if (WRAPPERS.has(w)) {
      i++;
      while (words[i]?.startsWith('-')) i++;
    } else {
      break;
    }
  }
  const name = path.basename(words[i]);
  const rest = words.slice(i + 1);
  if (SHELLS.has(name)) {
    const flag = rest.findIndex((a) => /^-[a-z]*c$/.test(a));
    return flag === -1 ? '' : scan(rest[flag + 1] ?? '');
  }
  if (name === 'eval') return scan(rest.join(' '));
  if (name !== 'git') return '';
  let j = 0;
  for (;;) {
    const w = rest[j];
    if (w === undefined) return '';
    if (GIT_ARG_OPTIONS.has(w)) j += 2;
    else if (w.startsWith('--') || w === '-P' || w === '-p') j++;
    else break;
  }
  return gitSubcommandBlocked(rest[j], rest.slice(j + 1));
};

const scanScript = (script: string): string => {
  const { commands, nested } = parse(script);
  for (const words of commands) {
    const found = checkWords(words, scanScript);
    if (found) return found;
  }
  for (const inner of nested) {
    const found = scanScript(inner);
    if (found) return found;
  }
  return '';
};

/** A description of the destructive git command in `command`, if any. */
export const dangerousGitCommand = (command: string) =>
  scanScript(command) || undefined;

const expand = (p: string, cwd: string) => {
  const home = os.homedir();
  if (p === '~') return home;
  const expanded = p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
  return path.resolve(cwd, expanded);
};

/** True when `p` is inside `cwd` or one of `roots` (lexical, no realpath). */
export const isInsideRoots = (p: string, roots: string[], cwd: string) => {
  const target = expand(p, cwd);
  return [cwd, ...roots].some((root) => {
    const rel = path.relative(expand(root, cwd), target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
};

const pathsOf = (input: Record<string, unknown>) => {
  const found: string[] = [];
  if (typeof input.path === 'string') found.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) if (typeof p === 'string') found.push(p);
  }
  return found;
};

const blockReason = (
  config: GuardConfig,
  call: { toolName: string; input: unknown },
): string => {
  const { allowedTools, git, readRoots, cwd } = config;
  if (allowedTools && !allowedTools.includes(call.toolName)) {
    return `tool '${call.toolName}' is not allowed for this agent`;
  }
  const input =
    typeof call.input === 'object' && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {};
  if (git && typeof input.command === 'string') {
    const found = dangerousGitCommand(input.command);
    if (found) {
      return (
        `blocked by pi-agent-runner: ${found} ` +
        'is not allowed in a child agent'
      );
    }
  }
  if (readRoots) {
    for (const p of pathsOf(input)) {
      if (!isInsideRoots(p, readRoots, cwd)) {
        return `path '${p}' is outside this agent's read roots`;
      }
    }
  }
  return '';
};

/** A block reason for the call, or undefined to let it through. */
export const guardDecision = (
  config: GuardConfig,
  call: { toolName: string; input: unknown },
) => blockReason(config, call) || undefined;
