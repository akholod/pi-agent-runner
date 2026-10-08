import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPausableTimer } from '../src/timer.ts';
import { sleep } from './fake.ts';

test('fires after the delay', async () => {
  let fired = 0;
  createPausableTimer(20, () => fired++);
  await sleep(80);
  assert.equal(fired, 1);
});

test('pause holds the timer and keeps the remaining time', async () => {
  let fired = 0;
  const timer = createPausableTimer(100, () => fired++);
  await sleep(40);
  timer.pause();
  assert.equal(timer.paused, true);
  const left = timer.remainingMs;
  assert.ok(left > 0 && left < 100);
  await sleep(150);
  assert.equal(fired, 0);
  assert.equal(timer.remainingMs, left);
  timer.resume();
  assert.equal(timer.paused, false);
  await sleep(left + 80);
  assert.equal(fired, 1);
});

test('pauses nest by count', async () => {
  let fired = 0;
  const timer = createPausableTimer(30, () => fired++);
  timer.pause();
  timer.pause();
  timer.resume();
  await sleep(100);
  assert.equal(fired, 0);
  assert.equal(timer.paused, true);
  timer.resume();
  await sleep(100);
  assert.equal(fired, 1);
});

test('clear is idempotent and stops the timer', async () => {
  let fired = 0;
  const timer = createPausableTimer(20, () => fired++);
  timer.clear();
  timer.clear();
  timer.pause();
  timer.resume();
  await sleep(80);
  assert.equal(fired, 0);
});

test('pause and resume are no-ops after expiry', async () => {
  let fired = 0;
  const timer = createPausableTimer(10, () => fired++);
  await sleep(60);
  timer.pause();
  timer.resume();
  assert.equal(timer.paused, false);
  assert.equal(timer.remainingMs, 0);
  await sleep(40);
  assert.equal(fired, 1);
});

test('injected clock drives remainingMs', () => {
  let t = 1000;
  const timer = createPausableTimer(
    500,
    () => {},
    () => t,
  );
  t += 200;
  assert.equal(timer.remainingMs, 300);
  timer.pause();
  t += 1000;
  assert.equal(timer.remainingMs, 300);
  timer.clear();
});
