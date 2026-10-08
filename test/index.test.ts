import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUN_STATUSES } from '../src/index.ts';

test('exports every run status from the plan', () => {
  assert.deepEqual(RUN_STATUSES, [
    'completed',
    'failed',
    'timed_out',
    'cancelled',
    'structured_output_failed',
  ]);
});
