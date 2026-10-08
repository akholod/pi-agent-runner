import type { ParentContext } from './types.ts';

export const PERMISSION_PROMPT_CHANNEL = 'permissions:ui_prompt';
export const PERMISSION_DECISION_CHANNEL = 'permissions:decision';

/** A request still open after this long is dropped (lost decision event). */
const OPEN_REQUEST_CAP_MS = 30 * 60_000;

export interface HumanWaitTracker {
  readonly waiting: boolean;
  /** Called only on false to true and true to false transitions. */
  onChange(listener: (waiting: boolean) => void): () => void;
}

const requestIdOf = (data: unknown) => {
  const id = (data as { requestId?: unknown } | null)?.requestId;
  return typeof id === 'string' ? id : undefined;
};

const createTracker = (
  events: ParentContext['events'],
  capMs: number,
): HumanWaitTracker => {
  const open = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(waiting: boolean) => void>();

  const emit = (waiting: boolean) => {
    for (const listener of [...listeners]) {
      try {
        listener(waiting);
      } catch {
        // One broken listener must not starve the others.
      }
    }
  };
  const close = (id: string) => {
    const handle = open.get(id);
    if (!handle) return;
    clearTimeout(handle);
    open.delete(id);
    if (open.size === 0) emit(false);
  };

  // Any open permission prompt in the parent pauses timers, not only this
  // child's: a forwarded ask queued behind another child's dialog waits for
  // the same human (incident run 1fa6c4a3).
  events.on(PERMISSION_PROMPT_CHANNEL, (data) => {
    const id = requestIdOf(data);
    if (id === undefined || open.has(id)) return;
    const handle = setTimeout(() => close(id), capMs);
    handle.unref();
    open.set(id, handle);
    if (open.size === 1) emit(true);
  });
  events.on(PERMISSION_DECISION_CHANNEL, (data) => {
    const id = requestIdOf(data);
    if (id !== undefined) close(id);
  });

  return {
    get waiting() {
      return open.size > 0;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const trackers = new WeakMap<object, HumanWaitTracker>();

// Subscribed once per bus and never unsubscribed: one listener per parent
// bus for the process lifetime, so a run that starts while a dialog is
// already open still sees it. `capMs` is for tests.
export const humanWaitTracker = (
  events: ParentContext['events'],
  capMs = OPEN_REQUEST_CAP_MS,
): HumanWaitTracker => {
  let tracker = trackers.get(events);
  if (!tracker) {
    tracker = createTracker(events, capMs);
    trackers.set(events, tracker);
  }
  return tracker;
};
