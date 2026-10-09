// Structured output: the child ends its run by calling `submit_result`.
// The collector is the single place that decides which submission counts.
import { Compile as compile } from 'typebox/compile';

export const SUBMIT_RESULT_TOOL = 'submit_result';

const MAX_MESSAGE_BYTES = 4096;
const MAX_ERRORS = 10;

const MAP_KEYWORDS = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
];
const SINGLE_KEYWORDS = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'not',
  'propertyNames',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
];
const ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The schema moves under `properties.value`, so its local `#/...` pointers
// must follow it. A subschema with its own `$id` is a separate resource and
// keeps its refs.
const rewriteRefs = (
  schema: unknown,
  prefix: string,
  inherits = true,
): unknown => {
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = { ...schema };
  const shares = inherits && typeof schema.$id !== 'string';
  const next = (nested: unknown) => rewriteRefs(nested, prefix, shares);
  if (shares) {
    for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
      const ref = schema[keyword];
      if (ref === '#') {
        out[keyword] = prefix;
      } else if (typeof ref === 'string' && ref.startsWith('#/')) {
        out[keyword] = `${prefix}${ref.slice(1)}`;
      }
    }
  }
  for (const keyword of MAP_KEYWORDS) {
    const entries = schema[keyword];
    if (!isObject(entries)) continue;
    out[keyword] = Object.fromEntries(
      Object.entries(entries).map(([name, nested]) => [name, next(nested)]),
    );
  }
  const { items } = schema;
  if (Array.isArray(items)) out.items = items.map(next);
  else if (items !== undefined) out.items = next(items);
  for (const keyword of SINGLE_KEYWORDS) {
    if (schema[keyword] !== undefined) out[keyword] = next(schema[keyword]);
  }
  for (const keyword of ARRAY_KEYWORDS) {
    const list = schema[keyword];
    if (Array.isArray(list)) out[keyword] = list.map(next);
  }
  const { dependencies } = schema;
  if (isObject(dependencies)) {
    out.dependencies = Object.fromEntries(
      Object.entries(dependencies).map(([name, nested]) => [
        name,
        Array.isArray(nested) ? nested : next(nested),
      ]),
    );
  }
  return out;
};

/** Tool parameters: the result schema wrapped under a `value` property. */
export const toolParameters = (schema: Record<string, unknown>) => ({
  type: 'object' as const,
  properties: { value: rewriteRefs(schema, '#/properties/value') },
  required: ['value'],
  additionalProperties: false,
});

const capBytes = (text: string) => {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= MAX_MESSAGE_BYTES) return text;
  // toString drops a cut-off trailing multi-byte character.
  return `${buffer.subarray(0, MAX_MESSAGE_BYTES - 3).toString('utf8')}...`;
};

export type Validation = { ok: true } | { ok: false; message: string };

export const validator = (schema: Record<string, unknown>) => {
  let compiled: ReturnType<typeof compile>;
  try {
    compiled = compile(schema);
  } catch (error) {
    const message = `invalid result schema: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      schemaError: message,
      validate: (_value: unknown): Validation => ({ ok: false, message }),
    };
  }
  const validate = (value: unknown): Validation => {
    // typebox's API is capitalized.
    /* eslint-disable new-cap */
    if (compiled.Check(value)) return { ok: true };
    const errors = [...compiled.Errors(value)];
    /* eslint-enable new-cap */
    const lines = errors
      .slice(0, MAX_ERRORS)
      .map((e) => `${e.instancePath || '/'}: ${e.message}`);
    return {
      ok: false,
      message: capBytes(lines.join('; ') || 'value does not match the schema'),
    };
  };
  return { schemaError: undefined, validate };
};

export type Submission =
  { accepted: true } | { accepted: false; error: string };

export const createResultCollector = (
  schema: Record<string, unknown>,
  validate: (value: unknown) => Validation = validator(schema).validate,
) => {
  const state = {
    value: undefined as unknown,
    hasValue: false,
    invalidCount: 0,
    lastError: undefined as string | undefined,
    submit(value: unknown): Submission {
      if (state.hasValue) {
        return {
          accepted: false,
          error: 'result already submitted; the first one is final',
        };
      }
      const checked = validate(value);
      if (!checked.ok) {
        state.invalidCount++;
        state.lastError = checked.message;
        return { accepted: false, error: checked.message };
      }
      state.value = value;
      state.hasValue = true;
      return { accepted: true };
    },
  };
  return state;
};

// Appended to the task (user message), never to the system prompt: Spiral
// needs the role prompt verbatim, and the frozen prompt must stay what
// claude-bridge captured.
export const taskWithInstructions = (task: string) =>
  `${task}\n\nWhen you are done, call the \`${SUBMIT_RESULT_TOOL}\` ` +
  'tool exactly once with your final answer as `value`, matching the ' +
  'required schema. Do not answer in prose instead.';

export const correctionPrompt = (lastError?: string) =>
  `You have not submitted a valid result. ` +
  `Call \`${SUBMIT_RESULT_TOOL}\` now with \`value\` matching the schema.${
    lastError ? `\nLast error: ${lastError}` : ''
  }`;
