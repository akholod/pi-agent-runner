// The feed between the runner and a pane viewer: JSON lines in a file, one
// per run generation. The child lives in the parent Pi process, so a viewer
// in another terminal pane cannot read its memory; the runner appends what
// it records and the viewer tails the file.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActivityEntry, LiveState } from './live.ts';

export type FeedRecord =
  | {
      t: 'start';
      at: number;
      /** The Pi process; the viewer leaves when it is gone. */
      pid: number;
      id: string;
      name: string;
      context?: string;
      model?: string;
      generation: number;
      startedAt: number;
    }
  | { t: 'entry'; at: number; kind: ActivityEntry['kind']; text: string }
  | {
      t: 'state';
      at: number;
      state: LiveState;
      turns: number;
      toolCalls: number;
      tokens: { input: number; output: number };
      cost: number;
      waiting: boolean;
      wrappingUp: boolean;
    }
  | {
      t: 'end';
      at: number;
      status: string;
      error?: string;
      turns: number;
      tokens: { input: number; output: number };
      cost: number;
      startedAt: number;
    };

export const DEFAULT_LINGER_MS = 5000;

const uidOf = (): string => String(process.getuid?.() ?? 'user');

export const defaultFeedDir = (): string =>
  path.join(os.tmpdir(), `pi-agent-runner-${uidOf()}`, 'feeds');

// a tmp dir is shared: refuse one that is a link or someone else's
const ownDir = (dir: string): void => {
  const info = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`unsafe feed directory ${dir}`);
  }
  if ((info.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
};

export const prepareFeedDir = (dir: string): void => {
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  ownDir(parent);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ownDir(dir);
};

const safeName = (id: string): string => id.replace(/[^\w.-]/g, '_');

export interface Feed {
  readonly file: string;
  write(record: FeedRecord): void;
  /** Closes the file and deletes it. */
  remove(): void;
}

/** Creates `<dir>/<id>-g<n>.jsonl`, mode 0600, replacing a stale one. */
export const createFeed = (
  dir: string,
  id: string,
  generation: number,
): Feed => {
  prepareFeedDir(dir);
  const file = path.join(dir, `${safeName(id)}-g${generation}.jsonl`);
  fs.rmSync(file, { force: true });
  let fd: number | undefined = fs.openSync(file, 'wx', 0o600);
  return {
    file,
    write(record) {
      if (fd === undefined) return;
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
      } catch {
        // a full disk must not break the run
      }
    },
    remove() {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // already closed
        }
        fd = undefined;
      }
      fs.rmSync(file, { force: true });
    },
  };
};
