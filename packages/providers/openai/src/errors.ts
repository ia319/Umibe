import OpenAI from 'openai';
import { ModelRequestError } from '@umibe/core/model';

/** Respect both provider delay headers; invalid or overflowing values grant no delay. */
export function retryAfterMs(headers: Headers | undefined): number {
  let delay = 0;
  for (const [name, multiplier] of [
    ['retry-after-ms', 1],
    ['retry-after', 1000],
  ] as const) {
    const value = headers?.get(name)?.trim();
    if (!value) continue;
    const numeric = /^\d+(?:\.\d+)?$/.test(value);
    const milliseconds = numeric
      ? Math.ceil(Number(value) * multiplier)
      : name === 'retry-after' && /^[A-Za-z]{3}, .* GMT$/.test(value)
        ? Math.max(0, Date.parse(value) - Date.now())
        : NaN;
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0)
      delay = Math.max(delay, milliseconds);
  }
  return delay;
}

/** Discard SDK messages and response bodies; only documented failure classes affect retries. */
export function classifyError(error: unknown): ModelRequestError {
  if (error instanceof ModelRequestError)
    return error.code === 'invalid_response' && error.issue === null
      ? new ModelRequestError(error.code, error.retryAfterMs, {
          phase: 'protocol',
          path: '',
          reason: 'invalid_response',
        })
      : error;
  if (
    error instanceof OpenAI.APIConnectionError &&
    error.cause instanceof ModelRequestError
  )
    return classifyError(error.cause);
  if (error instanceof OpenAI.APIConnectionTimeoutError)
    return new ModelRequestError('deadline_exceeded');
  if (error instanceof OpenAI.APIConnectionError)
    return new ModelRequestError('unavailable');
  if (error instanceof OpenAI.APIError) {
    const status: unknown = error.status;
    const headers: unknown = error.headers;
    const delay = retryAfterMs(
      headers instanceof Headers ? headers : undefined,
    );
    if (status === 401 || status === 403)
      return new ModelRequestError('unauthorized');
    if (status === 429) return new ModelRequestError('rate_limited', delay);
    if (status === 408)
      return new ModelRequestError('deadline_exceeded', delay);
    if (typeof status === 'number' && status >= 500 && status <= 599)
      return new ModelRequestError('unavailable', delay);
    if (status === 400 || status === 404 || status === 422)
      return new ModelRequestError(
        error.code === 'context_length_exceeded'
          ? 'input_limit'
          : 'invalid_request',
      );
  }
  return error instanceof SyntaxError
    ? new ModelRequestError('invalid_response', 0, {
        phase: 'protocol',
        path: '',
        reason: 'invalid_json',
      })
    : new ModelRequestError('request_failed');
}
