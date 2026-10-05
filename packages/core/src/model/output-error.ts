import { ModelRequestError } from '#internal/runtime/model';
import type { ModelResponseIssue } from './metadata.js';
import { captureModelIssue } from './validation.js';

/** Convert decoding errors without retaining response values or arbitrary exception text. */
export function modelOutputError(
  phase: ModelResponseIssue['phase'],
  error: unknown,
): ModelRequestError {
  return new ModelRequestError(
    'invalid_response',
    0,
    captureModelIssue(phase, error),
  );
}
