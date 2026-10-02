import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { ActionDefinition } from '#internal/contracts/action';
import { ActionRegistry, defineAction } from './registry.js';
import { control, decision, execution, result } from './__tests__/fixtures.js';

function parameterRegistry(parameters: z.ZodObject) {
  return new ActionRegistry([
    defineAction({
      id: 'act',
      version: 1,
      description: 'Test parameter normalization',
      tags: [],
      expectedEffects: {},
      parameters,
      check: () => Promise.resolve({ outcome: 'allowed' }),
      execute: () => Promise.resolve(result),
    }),
  ]);
}

function callInput(params: Record<string, unknown>) {
  return {
    actionId: 'act',
    actionVersion: 1,
    params,
    paramSources: Object.fromEntries(
      Object.keys(params).map((key) => [
        key,
        { kind: 'application', reference: `input/${key}` },
      ]),
    ),
  };
}

test('applies defaults once and binds the same frozen values to repeated checks and execution', async () => {
  const defaultCount = vi.fn(() => 2);
  const parameters = z.strictObject({
    target: z.string(),
    count: z.number().int().min(1).max(3).default(defaultCount),
    options: z.object({ limit: z.number().default(10) }),
  });
  const check = vi.fn<ActionDefinition<typeof parameters>['check']>(() =>
    Promise.resolve({ outcome: 'allowed' }),
  );
  const execute = vi.fn<ActionDefinition<typeof parameters>['execute']>(() =>
    Promise.resolve(result),
  );
  const registry = new ActionRegistry([
    defineAction({
      id: 'act',
      version: 1,
      description: 'Collect samples',
      tags: [],
      expectedEffects: {},
      parameters,
      check,
      execute,
    }),
  ]);
  const exportCalls = defaultCount.mock.calls.length;
  const input = callInput({ target: 'north', options: {} });
  const prepared = await registry.prepare(input);
  expect(prepared.call).toEqual({
    actionId: 'act',
    actionVersion: 1,
    params: { target: 'north', count: 2, options: { limit: 10 } },
    paramSources: {
      target: { kind: 'application', reference: 'input/target' },
      options: { kind: 'application', reference: 'input/options' },
      count: { kind: 'default', reference: 'action:act@1#/properties/count' },
    },
    parameterChanges: [
      { kind: 'added', path: '/count' },
      { kind: 'added', path: '/options/limit' },
    ],
  });
  expect(input.params).toEqual({ target: 'north', options: {} });
  expect(defaultCount.mock.calls.length - exportCalls).toBe(1);
  const freshDecision = {
    ...decision,
    observation: { ...decision.observation, revision: 2 },
  };
  await prepared.check(decision, control);
  await prepared.check(freshDecision, control);
  await prepared.execute(execution);
  expect(defaultCount.mock.calls.length - exportCalls).toBe(1);
  expect(check.mock.calls[0]).toEqual([
    decision,
    prepared.call.params,
    control,
  ]);
  expect(check.mock.calls[1]?.[0]).toBe(freshDecision);
  expect(check.mock.calls[1]?.[1]).toBe(prepared.call.params);
  expect(execute.mock.calls[0]?.[0]).toBe(prepared.call.params);
  expect(execute.mock.calls[0]?.[1]).toBe(execution);
  expect(Object.isFrozen(prepared.call.params.options)).toBe(true);
  expect(Object.isFrozen(prepared.call.paramSources.count)).toBe(true);
  expect(Reflect.set(prepared.call.params, 'count', 99)).toBe(false);
  expect(Object.isFrozen(prepared)).toBe(true);
});

test.each<[Record<string, unknown>, string, string]>([
  [{}, '/params/target', 'schema_invalid_type'],
  [{ target: null }, '/params/target', 'schema_invalid_type'],
  [{ target: 'north', mode: 'fly' }, '/params/mode', 'schema_invalid_value'],
  [{ target: 'north', count: 0 }, '/params/count', 'schema_too_small'],
  [{ target: 'north', count: 4 }, '/params/count', 'schema_too_big'],
  [{ target: 'north', extra: true }, '/params', 'schema_unrecognized_keys'],
])('rejects invalid parameter call %j', async (params, path, reason) => {
  const registry = parameterRegistry(
    z.strictObject({
      target: z.string(),
      mode: z.enum(['walk', 'sprint']).default('walk'),
      count: z.number().int().min(1).max(3).default(1),
    }),
  );
  await expect(registry.prepare(callInput(params))).rejects.toMatchObject({
    code: 'INVALID_ACTION_PARAMETERS',
    stage: 'action_parameters',
    path,
    reason,
  });
});

test('distinguishes nullable values, omitted optionals, and defaulted inputs', async () => {
  const registry = parameterRegistry(
    z.object({
      nullable: z.string().nullable().default('fallback'),
      optional: z.string().optional(),
    }),
  );
  const explicitNull = await registry.prepare(callInput({ nullable: null }));
  expect(explicitNull.call.params).toEqual({ nullable: null });
  expect(explicitNull.call.paramSources.nullable?.kind).toBe('application');
  const omitted = await registry.prepare(callInput({}));
  expect(omitted.call.params).toEqual({ nullable: 'fallback' });
  expect(omitted.call.paramSources.nullable?.kind).toBe('default');
  expect(Object.hasOwn(omitted.call.params, 'optional')).toBe(false);
});

test('honors declared stripping and records nested normalization without replacing supplied provenance', async () => {
  const registry = parameterRegistry(
    z.object({
      target: z.string().trim(),
      items: z.array(
        z.object({ name: z.string(), amount: z.number().default(1) }),
      ),
    }),
  );
  const prepared = await registry.prepare(
    callInput({
      target: ' north ',
      extra: 9,
      items: [{ name: 'sample', unused: 'drop' }],
    }),
  );
  expect(prepared.call.params).toEqual({
    target: 'north',
    items: [{ name: 'sample', amount: 1 }],
  });
  expect(prepared.call.parameterChanges).toEqual([
    { kind: 'removed', path: '/extra' },
    { kind: 'added', path: '/items/0/amount' },
    { kind: 'removed', path: '/items/0/unused' },
    { kind: 'changed', path: '/target' },
  ]);
  expect(Object.keys(prepared.call.paramSources)).toEqual(['target', 'items']);
  expect(prepared.call.paramSources.items?.kind).toBe('application');
  const loose = await parameterRegistry(z.looseObject({})).prepare(
    callInput({ extra: { value: 2 } }),
  );
  expect(loose.call.params).toEqual({ extra: { value: 2 } });
  expect(loose.call.parameterChanges).toEqual([]);
});

test('reports array changes and escaped paths without depending on input object key order', async () => {
  const registry = parameterRegistry(
    z.object({
      'a/b~c': z.array(z.number()).transform((items) => [...items.slice(1), 7]),
      stripped: z.array(z.string()).transform((items) => items.slice(0, 1)),
    }),
  );
  const prepared = await registry.prepare(
    callInput({ stripped: ['first', 'second'], 'a/b~c': [1, 2] }),
  );
  expect(prepared.call.parameterChanges).toEqual([
    { kind: 'changed', path: '/a~1b~0c/0' },
    { kind: 'changed', path: '/a~1b~0c/1' },
    { kind: 'removed', path: '/stripped/1' },
  ]);
});

test('rejects missing, extra or invalid source entries before invoking the schema', async () => {
  const refinement = vi.fn(() => true);
  const registry = parameterRegistry(
    z.object({ 'a/b~c': z.string().refine(refinement) }),
  );
  for (const [paramSources, path, reason] of [
    [{}, '/paramSources', 'parameter_source_mismatch'],
    [
      {
        'a/b~c': { kind: 'application', reference: 'input' },
        extra: { kind: 'default', reference: 'schema' },
      },
      '/paramSources',
      'parameter_source_mismatch',
    ],
    [
      { 'a/b~c': { kind: 'unknown', reference: 'input' } },
      '/paramSources/a~1b~0c/kind',
      'invalid_parameter_source',
    ],
    [
      { 'a/b~c': { kind: 'application', reference: '' } },
      '/paramSources/a~1b~0c/reference',
      'expected_nonempty_string',
    ],
  ] as const) {
    await expect(
      registry.prepare({ ...callInput({ 'a/b~c': 'value' }), paramSources }),
    ).rejects.toMatchObject({ path, reason });
  }
  expect(refinement).not.toHaveBeenCalled();
});

test('rejects absent actions, mismatched versions and malformed call envelopes', async () => {
  const registry = parameterRegistry(z.object({}));
  for (const [input, path, reason] of [
    [{ ...callInput({}), actionId: 'missing' }, '/actionId', 'unknown_action'],
    [
      { ...callInput({}), actionVersion: 2 },
      '/actionVersion',
      'action_version_mismatch',
    ],
    [{ ...callInput({}), unexpected: 1 }, '/unexpected', 'unknown_field'],
    [{ ...callInput({}), params: [] }, '/params', 'expected_object'],
  ] as const) {
    await expect(registry.prepare(input)).rejects.toMatchObject({
      code: 'INVALID_ACTION_PARAMETERS',
      path,
      reason,
    });
  }
});

test.each([undefined, Infinity, 1n])(
  'rejects non-JSON input %s before schema transformations',
  async (value) => {
    const transform = vi.fn(() => 'sanitized');
    const registry = parameterRegistry(
      z.object({ value: z.unknown().transform(transform) }),
    );
    await expect(registry.prepare(callInput({ value }))).rejects.toMatchObject({
      code: 'INVALID_JSON',
      stage: 'action_parameters',
      path: '/params/value',
    });
    expect(transform).not.toHaveBeenCalled();
  },
);

test.each([new Date('2026-10-01T00:00:00.000Z'), undefined, NaN, 1n])(
  'rejects non-JSON schema output %s',
  async (value) => {
    const registry = parameterRegistry(
      z.object({ value: z.string().transform(() => value) }),
    );
    await expect(
      registry.prepare(callInput({ value: 'input' })),
    ).rejects.toMatchObject({
      code: 'INVALID_JSON',
      stage: 'action_parameters_output',
      path: '/params/value',
    });
  },
);

test('does not invent a default source for an omitted value generated by a transform', async () => {
  const registry = parameterRegistry(
    z.object({
      value: z
        .string()
        .optional()
        .transform((value) => value ?? 'generated'),
    }),
  );
  await expect(registry.prepare(callInput({}))).rejects.toMatchObject({
    code: 'INVALID_ACTION_PARAMETERS',
    path: '/paramSources/value',
    reason: 'added_parameter_without_default',
  });
});

test('preserves supported prototype-like keys and rejects keys Zod silently discards', async () => {
  const keys = ['constructor', 'toString', 'valueOf', 'a/b~c'];
  const registry = parameterRegistry(
    z.strictObject(Object.fromEntries(keys.map((key) => [key, z.string()]))),
  );
  const prepared = await registry.prepare(
    callInput(Object.fromEntries(keys.map((key) => [key, 'value']))),
  );
  expect(Object.keys(prepared.call.params)).toEqual(keys);
  expect(Object.keys(prepared.call.paramSources)).toEqual(keys);
  expect(Object.getPrototypeOf(prepared.call.params)).toBeNull();
  expect(Object.getPrototypeOf(prepared.call.paramSources)).toBeNull();
  const loose = parameterRegistry(z.looseObject({}));
  await expect(
    loose.prepare(callInput({ nested: { ['__proto__']: 'discarded' } })),
  ).rejects.toMatchObject({
    path: '/params/nested/__proto__',
    reason: 'unpreserved_parameter_key',
  });
});

test('captures caller inputs before asynchronous validation and isolates concurrent preparations', async () => {
  let release: () => void = () => {
    throw new Error('Uninitialized gate');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = parameterRegistry(
    z.object({
      value: z.string().refine(async () => {
        await gate;
        return true;
      }),
    }),
  );
  const firstInput = callInput({ value: 'first' });
  const first = registry.prepare(firstInput);
  firstInput.params.value = 'mutated';
  firstInput.paramSources.value!.reference = 'mutated';
  const second = registry.prepare(callInput({ value: 'second' }));
  release();
  const [firstPrepared, secondPrepared] = await Promise.all([first, second]);
  expect(firstPrepared.call.params.value).toBe('first');
  expect(firstPrepared.call.paramSources.value?.reference).toBe('input/value');
  expect(secondPrepared.call.params.value).toBe('second');
  expect(firstPrepared.call.params).not.toBe(secondPrepared.call.params);
});

test('copies default objects and reports schema callback failures without retaining input values', async () => {
  const defaultObject = { value: 1 };
  const registry = parameterRegistry(
    z.object({
      options: z.object({ value: z.number() }).default(defaultObject),
    }),
  );
  const prepared = await registry.prepare(callInput({}));
  defaultObject.value = 9;
  expect(prepared.call.params.options).toEqual({ value: 1 });
  const broken = parameterRegistry(
    z.object({
      value: z
        .string()
        .transform(() => Promise.reject(new Error('secret-input'))),
    }),
  );
  await expect(
    broken.prepare(callInput({ value: 'secret-input' })),
  ).rejects.toMatchObject({
    code: 'INVALID_ACTION_PARAMETERS',
    path: '/params',
    reason: 'parameter_schema_failed',
    message:
      'INVALID_ACTION_PARAMETERS at action_parameters/params: parameter_schema_failed',
  });
});
