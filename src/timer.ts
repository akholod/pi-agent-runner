export interface PausableTimer {
  /** Nests: two pauses need two resumes. */
  pause(): void;
  resume(): void;
  /** Idempotent; pause and resume are no-ops afterwards. */
  clear(): void;
  readonly paused: boolean;
  readonly remainingMs: number;
}

export const createPausableTimer = (
  ms: number,
  onExpire: () => void,
  now = Date.now,
): PausableTimer => {
  let remaining = ms;
  let startedAt = now();
  let pauses = 0;
  let finished = false;
  let handle: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    startedAt = now();
    handle = setTimeout(() => {
      handle = undefined;
      finished = true;
      remaining = 0;
      onExpire();
    }, remaining);
  };
  arm();

  return {
    pause() {
      if (finished) return;
      pauses++;
      if (pauses > 1) return;
      clearTimeout(handle);
      handle = undefined;
      remaining = Math.max(0, remaining - (now() - startedAt));
    },
    resume() {
      if (finished || pauses === 0) return;
      pauses--;
      if (pauses === 0) arm();
    },
    clear() {
      finished = true;
      clearTimeout(handle);
      handle = undefined;
    },
    get paused() {
      return pauses > 0;
    },
    get remainingMs() {
      if (finished) return remaining;
      return pauses > 0
        ? remaining
        : Math.max(0, remaining - (now() - startedAt));
    },
  };
};
