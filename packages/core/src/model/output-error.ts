import { ContractError } from '#internal/errors';
import { ModelRequestError } from '#internal/runtime/model';
import type { ModelResponseIssue } from './metadata.js';

/** Convert decoding errors without retaining response values or arbitrary exception text. */
export function modelOutputError(
  phase: ModelResponseIssue['phase'],
  error: unknown,
): ModelRequestError {
  return new ModelRequestError('invalid_response', 0, {
    phase,
    path:
      error instanceof ContractError &&
      error.path.length <= 256 &&
      /^(?:\/[A-Za-z0-9_-]+)*$/.test(error.path)
        ? error.path
        : '',
    reason:
      error instanceof ContractError &&
      /^[a-z][a-z0-9_]{0,63}$/.test(error.reason)
        ? error.reason
        : 'invalid_output',
  });
}
