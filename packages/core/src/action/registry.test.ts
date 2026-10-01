import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { ActionDefinition } from '#internal/contracts/action';
import type { ActionIntent } from '#internal/contracts/record';
import { parseJsonValue } from '#internal/validation/json';
import { ActionRegistry, defineAction } from './registry.js';
import { control, decision, execution, result } from './__tests__/fixtures.js';

function moveDefinition() {
  return {
    id: 'move',
    version: 2,
    description: 'Move to a named target',
    tags: ['movement'],
    expectedEffects: { location: { mayChange: true } },
    parameters: z.strictObject({ target: z.string().min(1) }),
    check: vi.fn<ActionDefinition<z.ZodObject>['check']>(() =>
      Promise.resolve({ outcome: 'allowed' }),
    ),
    execute: vi.fn<ActionDefinition<z.ZodObject>['execute']>(() =>
      Promise.resolve(result),
    ),
  };
}

test('exports a stable JSON capability catalog for heterogeneous actions', () => {
  const move = defineAction(moveDefinition());
  const collect = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect a bounded number of samples',
    tags: ['samples'],
    expectedEffects: { samplesMayIncrease: true },
    parameters: z.strictObject({
      count: z.number().int().min(1).max(3).default(1),
    }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: () => Promise.resolve(result),
  });
  const registry = new ActionRegistry([move, collect]);
  expect(registry.capabilities.map(({ id }) => id)).toEqual([
    'collect',
    'move',
  ]);
  expect(registry.capabilities).toEqual(
    new ActionRegistry([collect, move]).capabilities,
  );
  expect(registry.capabilities[0]).toMatchObject({
    id: 'collect',
    version: 1,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
      },
    },
  });
  expect(parseJsonValue(registry.capabilities, 'test')).toEqual(
    registry.capabilities,
  );
  expect(Object.isFrozen(registry.capabilities)).toBe(true);
  expect(move.retryMode).toBe('never');
});

test('rejects duplicate IDs without replacing the existing implementation', async () => {
  const definition = moveDefinition();
  const move = defineAction(definition);
  const registry = new ActionRegistry([move]);
  const catalog = registry.capabilities;
  for (const duplicate of [
    move,
    defineAction({ ...moveDefinition(), version: 3 }),
  ]) {
    expect(() => registry.register(duplicate)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ACTION_DEFINITION',
        reason: 'duplicate_action_id',
        path: '/actions/move',
      }),
    );
    expect(registry.capabilities).toEqual(catalog);
  }
  expect(() => new ActionRegistry([move, move])).toThrowError(
    expect.objectContaining({ reason: 'duplicate_action_id' }),
  );
  const call = await registry.prepare({
    actionId: 'move',
    actionVersion: 2,
    params: { target: 'north' },
    paramSources: { target: { kind: 'application', reference: 'route' } },
  });
  await call.execute(execution);
  expect(definition.execute).toHaveBeenCalledOnce();
});

test('accepts only factory-created registrations and preserves prior catalog snapshots', () => {
  const move = defineAction(moveDefinition());
  const registry = new ActionRegistry([]);
  const empty = registry.capabilities;
  expect(() => registry.register({ ...move })).toThrowError(
    expect.objectContaining({ reason: 'unregistered_definition' }),
  );
  expect(registry.capabilities).toEqual([]);
  registry.register(move);
  expect(empty).toEqual([]);
  expect(registry.capabilities).toEqual([move.capability]);
});

test.each<[string, unknown, string]>([
  ['id', ' ', '/id'],
  ['version', 0, '/version'],
  ['version', 1.5, '/version'],
  ['description', '', '/description'],
  ['tags', 'movement', '/tags'],
  ['tags', [''], '/tags/0'],
  ['expectedEffects', [], '/expectedEffects'],
  ['check', undefined, '/check'],
  ['execute', null, '/execute'],
  ['retryMode', 'always', '/retryMode'],
  ['retryMode', null, '/retryMode'],
  ['retryMode', 'reconcile', '/reconcile'],
  ['verifyResult', true, '/verifyResult'],
  ['reconcile', null, '/reconcile'],
  ['parameters', z.string(), '/parameters'],
])('rejects invalid action field %s with value %j', (key, value, path) => {
  const definition = moveDefinition();
  Reflect.set(definition, key, value);
  expect(() => defineAction(definition)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_ACTION_DEFINITION',
      stage: 'action_definition',
      path,
    }),
  );
});

test('rejects non-JSON descriptions and parameter schemas that cannot preserve calls', () => {
  const definition = moveDefinition();
  Reflect.set(definition.expectedEffects, 'count', Infinity);
  expect(() => defineAction(definition)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_JSON',
      path: '/expectedEffects/count',
    }),
  );
  expect(() =>
    defineAction({
      ...moveDefinition(),
      parameters: z.object({ count: z.bigint() }),
    }),
  ).toThrowError(
    expect.objectContaining({ reason: 'unrepresentable_parameters' }),
  );
  expect(() =>
    defineAction({
      ...moveDefinition(),
      parameters: z.object({ nested: z.object({ ['__proto__']: z.string() }) }),
    }),
  ).toThrowError(
    expect.objectContaining({
      reason: 'unpreserved_parameter_key',
      path: '/parameters/properties/nested/properties/__proto__',
    }),
  );
});

test('captures metadata and callback references without mutating the supplied definition', async () => {
  const definition = moveDefinition();
  const originalCheck = definition.check;
  const originalExecute = definition.execute;
  const action = defineAction(definition);
  Reflect.set(definition, 'id', 'changed');
  definition.tags.push('changed');
  definition.expectedEffects.location.mayChange = false;
  definition.parameters = z.strictObject({ target: z.string().min(20) });
  definition.check = vi.fn(() =>
    Promise.resolve({ outcome: 'denied', reason: 'replacement' }),
  );
  definition.execute = vi.fn(() => Promise.reject(new Error('replacement')));
  const registry = new ActionRegistry([action]);
  const prepared = await registry.prepare({
    actionId: 'move',
    actionVersion: 2,
    params: { target: 'north' },
    paramSources: { target: { kind: 'model', reference: 'request-1' } },
  });
  await expect(prepared.check(decision, control)).resolves.toEqual({
    outcome: 'allowed',
  });
  await expect(prepared.execute(execution)).resolves.toEqual(result);
  expect(originalCheck).toHaveBeenCalledOnce();
  expect(originalExecute).toHaveBeenCalledOnce();
  expect(definition.check).not.toHaveBeenCalled();
  expect(action.capability).toMatchObject({
    id: 'move',
    tags: ['movement'],
    expectedEffects: { location: { mayChange: true } },
  });
  expect(Object.isFrozen(action.capability.expectedEffects.location)).toBe(
    true,
  );
  expect(Object.isFrozen(definition.tags)).toBe(false);
});

test('binds optional result callbacks and turns synchronous callback throws into rejections', async () => {
  const parameters = z.object({ target: z.string() });
  const definition: ActionDefinition<typeof parameters> = {
    ...moveDefinition(),
    parameters,
    retryMode: 'reconcile',
    check() {
      throw new Error(this.id);
    },
    verifyResult() {
      throw new Error(this.id);
    },
    reconcile() {
      return Promise.resolve({
        outcome: 'notPerformed',
        underlyingSettled: true,
        reason: this.id,
      });
    },
  };
  const registry = new ActionRegistry([defineAction(definition)]);
  Reflect.set(definition, 'id', 'changed');
  const prepared = await registry.prepare({
    actionId: 'move',
    actionVersion: 2,
    params: { target: 'north' },
    paramSources: { target: { kind: 'application', reference: 'route' } },
  });
  const intent: ActionIntent = {
    executionId: execution.executionId,
    decisionId: 'decision-1',
    candidateId: 'candidate-1',
    candidateSetId: 'set-1',
    actionId: 'move',
    actionVersion: 2,
    params: prepared.call.params,
    rootGoalRef: decision.graph.rootGoalRef,
    currentGoalRef: decision.graph.currentGoalRef,
    goalPathRef: 'path-1',
    planRef: { id: 'plan-1', version: 1, rootGoalVersion: 1 },
    observationRef: { id: 'obs-1', revision: 1 },
    constraintsVersion: 1,
  };
  await expect(prepared.check(decision, control)).rejects.toThrow('move');
  await expect(
    prepared.verifyResult?.(intent, result, control),
  ).rejects.toThrow('move');
  await expect(prepared.reconcile?.(intent, control)).resolves.toEqual({
    outcome: 'notPerformed',
    underlyingSettled: true,
    reason: 'move',
  });
  expect(prepared.retryMode).toBe('reconcile');
});
