import type { ActionCheck } from '#internal/contracts/action';
import { ContractError } from '#internal/errors';
import { requireKeys, requireObject, requireString } from './fields.js';
import { parseJsonValue } from './json.js';

/** Share the same business-result boundary for initial checks and later rechecks. */
export function parseActionCheck(input: unknown): ActionCheck {
  const context = {
    code: 'INVALID_ACTION_CHECK',
    stage: 'action_check',
  } as const;
  const object = requireObject(
    parseJsonValue(input, context.stage),
    context,
    '',
  );
  if (object.outcome === 'allowed') {
    requireKeys(object, ['outcome'], context, '');
    return Object.freeze({ outcome: 'allowed' });
  }
  if (object.outcome === 'denied' || object.outcome === 'unknown') {
    requireKeys(object, ['outcome', 'reason'], context, '');
    return Object.freeze({
      outcome: object.outcome,
      reason: requireString(object.reason, context, '/reason'),
    });
  }
  throw new ContractError(
    context.code,
    context.stage,
    '/outcome',
    'invalid_check_outcome',
  );
}
