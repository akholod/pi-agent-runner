import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERMISSION_DECISION_CHANNEL as DECISION,
  PERMISSION_PROMPT_CHANNEL as PROMPT,
  humanWaitTracker,
} from '../src/human-wait.ts';
import { fakeBus, sleep } from './fake.ts';

test('nested prompts: waiting until the last decision', () => {
  const bus = fakeBus();
  const tracker = humanWaitTracker(bus);
  const changes: boolean[] = [];
  tracker.onChange((w) => changes.push(w));
  bus.emit(PROMPT, { requestId: 'r1' });
  bus.emit(PROMPT, { requestId: 'r2' });
  assert.equal(tracker.waiting, true);
  bus.emit(DECISION, { requestId: 'r1' });
  assert.equal(tracker.waiting, true);
  bus.emit(DECISION, { requestId: 'r2' });
  assert.equal(tracker.waiting, false);
  assert.deepEqual(changes, [true, false]);
});

test('one tracker per bus', () => {
  const bus = fakeBus();
  assert.equal(humanWaitTracker(bus), humanWaitTracker(bus));
  assert.notEqual(humanWaitTracker(bus), humanWaitTracker(fakeBus()));
});

test('payloads without a string requestId are ignored', () => {
  const bus = fakeBus();
  const tracker = humanWaitTracker(bus);
  bus.emit(PROMPT, {});
  bus.emit(PROMPT, { requestId: 5 });
  bus.emit(PROMPT, null);
  bus.emit(PROMPT, 'x');
  assert.equal(tracker.waiting, false);
  bus.emit(DECISION, { requestId: 'unknown' });
  assert.equal(tracker.waiting, false);
});

test('a throwing listener does not break others; unsubscribe works', () => {
  const bus = fakeBus();
  const tracker = humanWaitTracker(bus);
  const seen: boolean[] = [];
  tracker.onChange(() => {
    throw new Error('bug');
  });
  const off = tracker.onChange((w) => seen.push(w));
  bus.emit(PROMPT, { requestId: 'r1' });
  off();
  bus.emit(DECISION, { requestId: 'r1' });
  assert.deepEqual(seen, [true]);
});

test('a request open past the cap is dropped', async () => {
  const bus = fakeBus();
  const tracker = humanWaitTracker(bus, 30);
  const changes: boolean[] = [];
  tracker.onChange((w) => changes.push(w));
  bus.emit(PROMPT, { requestId: 'lost' });
  assert.equal(tracker.waiting, true);
  await sleep(100);
  assert.equal(tracker.waiting, false);
  assert.deepEqual(changes, [true, false]);
  bus.emit(DECISION, { requestId: 'lost' });
  assert.deepEqual(changes, [true, false]);
});
