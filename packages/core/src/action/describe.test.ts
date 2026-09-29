import { expect, test } from 'vitest';
import { z } from 'zod';
import { describeActionParameters } from './describe.js';

test('describes candidate input before applying action defaults', () => {
  const parameters = z.strictObject({
    target: z.string(),
    mode: z.enum(['walk', 'sprint']).default('sprint'),
  });

  expect(describeActionParameters(parameters)).toMatchObject({
    type: 'object',
    required: ['target'],
    properties: {
      mode: { enum: ['walk', 'sprint'], default: 'sprint' },
    },
  });
  expect(parameters.parse({ target: 'north' })).toEqual({
    target: 'north',
    mode: 'sprint',
  });
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
