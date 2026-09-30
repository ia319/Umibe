import { expect, test } from 'vitest';
import { parseObservation } from './observation.js';

function input() {
  return {
    runId: 'run-1',
    id: 'observation-1',
    revision: 3,
    observedAt: '2026-09-28T12:00:00.000Z',
    source: 'application',
    coverage: {
      scope: 'nearby entities',
      completeness: 'complete',
      uncheckedScopes: [] as string[],
    },
    data: {
      count: { status: 'known', value: 2 },
      villager: { status: 'absent' },
    },
  };
}

test('keeps observed, absent and missing facts distinct in a detached snapshot', () => {
  const value = input();
  const observation = parseObservation(value);
  value.data.count.value = 7;

  expect(observation.data.count).toEqual({ status: 'known', value: 2 });
  expect(observation.data.villager).toEqual({ status: 'absent' });
  expect(observation.data.other).toBeUndefined();
  expect(Object.isFrozen(observation.data)).toBe(true);
});

test('distinguishes missing facts from explicit facts named like prototype properties', () => {
  const keys = ['__proto__', 'constructor', 'toString', 'valueOf'];
  const data = Object.fromEntries(
    keys.map((key) => [key, { status: 'known', value: 2 }]),
  );
  const missing = parseObservation({ ...input(), data: {} }).data;
  const present = parseObservation({ ...input(), data }).data;

  for (const key of keys) {
    expect(Object.hasOwn(missing, key)).toBe(false);
    expect(missing[key]).toBeUndefined();
    expect(Object.hasOwn(present, key)).toBe(true);
    expect(present[key]).toEqual({ status: 'known', value: 2 });
  }
  expect(Object.getPrototypeOf(missing)).toBeNull();
  expect(Object.getPrototypeOf(present)).toBeNull();
  expect(Object.isFrozen(present)).toBe(true);
  expect(Object.entries(present)).toEqual(Object.entries(data));
  expect(JSON.stringify(present)).toBe(JSON.stringify(data));
});

test('accepts explicit partial coverage and rejects false completeness', () => {
  const value = input();
  const partial = {
    ...value,
    coverage: {
      ...value.coverage,
      completeness: 'partial',
      uncheckedScopes: ['west'],
    },
    data: {
      ...value.data,
      west: { status: 'unobserved' },
      east: { status: 'unknown', reason: 'blocked' },
      tree: {
        status: 'stale',
        lastKnown: { count: 1 },
        lastObservedAt: '2026-09-28T11:59:00.000Z',
      },
    },
  };
  expect(parseObservation(partial).data.tree).toEqual(partial.data.tree);
  partial.coverage.completeness = 'complete';
  expect(() => parseObservation(partial)).toThrowError(
    expect.objectContaining({
      code: 'INVALID_OBSERVATION',
      path: '/coverage',
      reason: 'incomplete_coverage',
    }),
  );
});

test('rejects malformed fact values and timestamps at their source path', () => {
  const missingValue = input();
  const invalid = {
    ...missingValue,
    data: { count: { status: 'known' } },
  };
  expect(() => parseObservation(invalid)).toThrowError(
    expect.objectContaining({
      path: '/data/count/value',
      reason: 'missing_field',
    }),
  );

  const future = {
    ...missingValue,
    data: {
      tree: {
        status: 'stale',
        lastKnown: 1,
        lastObservedAt: '2026-09-29T00:00:00.000Z',
      },
    },
    coverage: { scope: 'trees', completeness: 'partial', uncheckedScopes: [] },
  };
  expect(() => parseObservation(future)).toThrowError(
    expect.objectContaining({
      path: '/data/tree/lastObservedAt',
      reason: 'future_last_observation',
    }),
  );
});
