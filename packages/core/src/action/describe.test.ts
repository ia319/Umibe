import { expect, test } from 'vitest';
import { z } from 'zod';
import { describeActionParameters } from './describe.js';

test('describes candidate input before applying action defaults', () => {
  const parameters = z.strictObject({
    target: z.string(),
    mode: z.enum(['walk', 'sprint']).default('sprint'),
  });

  // Assert validation rules while allowing export metadata to evolve.
  expect(describeActionParameters(parameters)).toMatchObject({
    type: 'object',
    required: ['target'],
    additionalProperties: false,
    properties: {
      target: { type: 'string' },
      mode: { type: 'string', enum: ['walk', 'sprint'], default: 'sprint' },
    },
  });
  expect(parameters.parse({ target: 'north' })).toEqual({
    target: 'north',
    mode: 'sprint',
  });
  expect(parameters.safeParse({ target: 'north', extra: true }).success).toBe(
    false,
  );
});

test('rejects parameters without a JSON input representation', () => {
  expect(() =>
    describeActionParameters(z.strictObject({ value: z.bigint() })),
  ).toThrowError(
    expect.objectContaining({
      code: 'INVALID_ACTION_DEFINITION',
      reason: 'unrepresentable_parameters',
    }),
  );
});
