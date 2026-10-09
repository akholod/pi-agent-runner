import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  correctionPrompt,
  createResultCollector,
  taskWithInstructions,
  toolParameters,
  validator,
} from '../src/structured.ts';

const CORRECTION =
  'You have not submitted a valid result. Call `submit_result` now with ' +
  '`value` matching the schema.';

const schema = {
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'number' } },
};

test('toolParameters wraps the schema under value', () => {
  assert.deepEqual(toolParameters({ type: 'string' }), {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  });
});

test('toolParameters rewrites local refs, keeps separate resources', () => {
  const { value } = toolParameters({
    $defs: { x: { type: 'string' } },
    type: 'object',
    properties: {
      a: { $ref: '#/$defs/x' },
      b: { type: 'array', items: { $ref: '#' } },
      c: { $id: 'urn:other', $ref: '#/$defs/y' },
      d: { anyOf: [{ $ref: '#/$defs/x' }] },
    },
  }).properties;
  assert.deepEqual(value, {
    $defs: { x: { type: 'string' } },
    type: 'object',
    properties: {
      a: { $ref: '#/properties/value/$defs/x' },
      b: { type: 'array', items: { $ref: '#/properties/value' } },
      c: { $id: 'urn:other', $ref: '#/$defs/y' },
      d: { anyOf: [{ $ref: '#/properties/value/$defs/x' }] },
    },
  });
});

test('validator: ok and error format', () => {
  const { validate } = validator(schema);
  assert.deepEqual(validate({ n: 1 }), { ok: true });
  const bad = validate({ n: 'x' });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : '', /^\/n: /);
  const root = validate({});
  assert.match(!root.ok ? root.message : '', /^\/: /);
});

test('validator: non-object schema', () => {
  const { validate } = validator({ type: 'string' });
  assert.deepEqual(validate('hi'), { ok: true });
  assert.equal(validate(1).ok, false);
});

test('validator: lists at most 10 errors and caps at 4096 bytes', () => {
  const many = validator({
    type: 'array',
    items: { type: 'string', maxLength: 1 },
  }).validate(Array.from({ length: 30 }, () => 5));
  assert.equal(many.ok, false);
  const count = !many.ok ? many.message.split('; ').length : 0;
  assert.ok(count > 1 && count <= 10);

  const long = validator({
    type: 'object',
    required: [`${'k'.repeat(5000)}`],
  }).validate({});
  assert.equal(long.ok, false);
  assert.ok(!long.ok && Buffer.byteLength(long.message) <= 4096);
});

test('validator: invalid schema reports instead of throwing', () => {
  const checker = validator({ type: 'string', pattern: '(' });
  assert.match(checker.schemaError ?? '', /^invalid result schema: /);
  assert.equal(checker.validate(1).ok, false);
});

test('collector: first valid value is final', () => {
  const c = createResultCollector(schema);
  assert.equal(c.submit({ n: 'x' }).accepted, false);
  assert.equal(c.invalidCount, 1);
  assert.match(c.lastError ?? '', /\/n/);
  assert.deepEqual(c.submit({ n: 1 }), { accepted: true });
  assert.deepEqual(c.submit({ n: 2 }), {
    accepted: false,
    error: 'result already submitted; the first one is final',
  });
  assert.deepEqual(c.value, { n: 1 });
  assert.equal(c.hasValue, true);
  assert.equal(c.invalidCount, 1);
});

test('prompt helpers', () => {
  assert.equal(
    taskWithInstructions('t'),
    't\n\nWhen you are done, call the `submit_result` tool exactly once ' +
      'with your final answer as `value`, matching the required schema. ' +
      'Do not answer in prose instead.',
  );
  assert.equal(correctionPrompt(), CORRECTION);
  assert.equal(correctionPrompt('boom'), `${CORRECTION}\nLast error: boom`);
});
