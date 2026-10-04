import { ModelRequestError } from '@umibe/core/model';
import type { JsonValue, ModelFailureCode } from '@umibe/core/model';
import { isJsonArray, isJsonObject } from '@umibe/core/model';

/** Only documented HTTP statuses and Workers AI codes authorize retries. */
export function cloudflareFailure(
  status: number,
  headers: Headers,
  errors?: JsonValue,
): ModelRequestError {
  let code: ModelFailureCode = 'request_failed';
  if (status === 401 || status === 403) code = 'unauthorized';
  else if ([400, 404, 405, 422].includes(status)) code = 'invalid_request';
  else if (status === 413) code = 'input_limit';
  else if (status === 429) code = 'rate_limited';
  else if (status === 408) code = 'deadline_exceeded';
  else if (status >= 500 && status <= 599) code = 'unavailable';
  else if (status >= 200 && status < 300 && isJsonArray(errors)) {
    // https://developers.cloudflare.com/workers-ai/platform/errors/
    const codes = errors.map((error) =>
      isJsonObject(error) ? error.code : null,
    );
    if (
      codes.some(
        (value) =>
          typeof value === 'number' &&
          [5018, 5016, 3023, 3041, 5035].includes(value),
      )
    )
      code = 'unauthorized';
    else if (codes.includes(3006)) code = 'input_limit';
    else if (
      codes.some(
        (value) =>
          typeof value === 'number' &&
          [5007, 5004, 3039, 3003, 5019, 5005, 3042].includes(value),
      )
    )
      code = 'invalid_request';
    else if (codes.some((value) => value === 3007 || value === 3008))
      code = 'deadline_exceeded';
    else if (codes.some((value) => value === 3036 || value === 3040))
      code = 'rate_limited';
  }
  let delay = 0;
  const value = headers.get('retry-after')?.trim();
  if (value) {
    const milliseconds = /^\d+(?:\.\d+)?$/.test(value)
      ? Math.ceil(Number(value) * 1000)
      : /^[A-Za-z]{3}, .* GMT$/.test(value)
        ? Math.max(0, Date.parse(value) - Date.now())
        : NaN;
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0)
      delay = milliseconds;
  }
  return new ModelRequestError(code, delay);
}

export function protocolFailure(
  path: string,
  reason: string,
): ModelRequestError {
  return new ModelRequestError('invalid_response', 0, {
    phase: 'protocol',
    path,
    reason,
  });
}
