import { expect, test } from 'vitest';
import { ContractError } from '../errors.js';
import { isJsonObject, parseJsonValue } from './json.js';

test('copies and freezes nested data before returning it', () => {
  const input = { position: [1, { x: 2 }] };
  const snapshot = parseJsonValue(input, 'observation');
  input.position[0] = 9;

  expect(snapshot).toEqual({ position: [1, { x: 2 }] });
  if (!isJsonObject(snapshot) || !Array.isArray(snapshot.position)) {
    throw new Error('Expected a nested JSON object.');
  }
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.position)).toBe(true);
  expect(Object.isFrozen(snapshot.position[1])).toBe(true);
});

test('rejects invalid JSON data with stage, path and stable code', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const cases: readonly (readonly [unknown, string, string])[] = [
    [
      { details: { missing: undefined } },
      '/details/missing',
      'unsupported_type',
    ],
    [{ count: Number.NaN }, '/count', 'number_not_finite'],
    [1n, '', 'unsupported_type'],
    [new Date(), '', 'non_plain_object'],
    [circular, '/self', 'circular_reference'],
    [new Array(1), '', 'sparse_or_extended_array'],
  ];

  for (const [input, path, reason] of cases) {
    expect(() => parseJsonValue(input, 'planner')).toThrowError(
      expect.objectContaining<Partial<ContractError>>({
        code: 'INVALID_JSON',
        stage: 'planner',
        path,
        reason,
      }),
    );
  }
});

test('does not run property accessors while validating input', () => {
  const input = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get: () => {
      throw new Error('accessed');
    },
  });

  expect(() => parseJsonValue(input, 'observation')).toThrowError(
    expect.objectContaining({ reason: 'hidden_or_accessor_property' }),
  );
});
