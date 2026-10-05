import { ModelRequestError, parseJsonValue } from '@umibe/core/model';
import type { ChoiceModel, JsonValue } from '@umibe/core/model';
import { encodeRequest } from './request.js';
import { decodeResponse } from './response.js';
import { cloudflareFailure, protocolFailure } from './errors.js';

export interface CloudflareModelOptions {
  /** Account path segment; letters, digits, underscores and hyphens only. */
  readonly accountId: string;
  readonly apiToken: string;
  readonly model: '@cf/cloudflare/clef';
  /**
   * Defaults to the official REST root. Require HTTPS except for HTTP protocol
   * tests at localhost, 127.0.0.1 or [::1]. Credentials, query and fragment are rejected.
   */
  readonly baseURL?: string;
  /** UTF-8 HTTP body limit, default 1 MiB; independent of the fixed 2048-byte state guard. */
  readonly maxRequestBytes?: number;
  /** Decoded HTTP body limit, default 8 MiB, also enforced on errors. */
  readonly maxResponseBytes?: number;
}

/**
 * Create a stateless hosted Clef adapter without sending a request or reading env.
 * Invalid configuration throws TypeError or RangeError. Each choose call sends
 * at most one POST, without retries, redirects or fallback. Its deadline includes
 * response body reading. State above 2048 UTF-8 bytes or a saturated 65536-token
 * response rejects with input_limit; input is never locally shortened.
 */
export function createCloudflareModel(
  options: CloudflareModelOptions,
): ChoiceModel {
  if (
    typeof options.accountId !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(options.accountId)
  )
    throw new TypeError('accountId must be a nonempty account path segment');
  if (
    typeof options.apiToken !== 'string' ||
    options.apiToken.trim() === '' ||
    /[\r\n]/.test(options.apiToken)
  )
    throw new TypeError('apiToken is required');
  if (options.model !== '@cf/cloudflare/clef')
    throw new TypeError('model must be @cf/cloudflare/clef');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 8_388_608;
  for (const [name, value] of Object.entries({
    maxRequestBytes,
    maxResponseBytes,
  }))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive safe integer`);
  const baseURL = new URL(
    options.baseURL ?? 'https://api.cloudflare.com/client/v4',
  );
  if (
    (baseURL.protocol !== 'https:' &&
      (baseURL.protocol !== 'http:' ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(baseURL.hostname))) ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw new TypeError(
      'baseURL requires HTTPS or loopback HTTP, without credentials, query or fragment',
    );
  const endpoint = `${baseURL.href.replace(/\/$/, '')}/accounts/${options.accountId}/ai/run/@cf/cloudflare/clef`;
  const apiToken = options.apiToken;
  const identity = Object.freeze({
    provider: 'cloudflare',
    model: options.model,
  });
  return Object.freeze<ChoiceModel>({
    kind: 'choice',
    identity,
    maxOptions: 255,
    async choose(request, control) {
      const deadline = Date.parse(control.deadlineAt);
      if (
        !(control.signal instanceof AbortSignal) ||
        !Number.isFinite(deadline) ||
        new Date(deadline).toISOString() !== control.deadlineAt
      )
        throw new ModelRequestError('invalid_request');
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= deadline)
        throw new ModelRequestError('deadline_exceeded');
      const { body, ids } = encodeRequest(request, maxRequestBytes);
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      if (Date.now() >= deadline)
        throw new ModelRequestError('deadline_exceeded');
      const timeout = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const armDeadline = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) timeout.abort();
        else
          timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
      };
      armDeadline();
      const signal = AbortSignal.any([control.signal, timeout.signal]);
      let requestId: string | null = null;
      let reported = false;
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiToken}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal,
          redirect: 'manual',
        });
        requestId = response.headers.get('cf-ai-req-id')?.trim() || null;
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = response.body?.getReader();
        if (reader !== undefined) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              if (length > maxResponseBytes) {
                await reader.cancel();
                throw protocolFailure('', 'response_too_large');
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= deadline)
          throw new ModelRequestError('deadline_exceeded');
        if (!response.ok)
          throw cloudflareFailure(response.status, response.headers);
        if (
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'application/json'
        )
          throw protocolFailure('', 'invalid_content_type');
        let data: JsonValue;
        try {
          data = parseJsonValue(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks, length),
              ),
            ),
            'clef_response',
          );
        } catch {
          throw protocolFailure('', 'invalid_json');
        }
        const decoded = decodeResponse(data, ids, requestId, response.headers, {
          ...control,
          reportModelResponse(metadata) {
            reported = true;
            control.reportModelResponse?.(metadata);
          },
        });
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= deadline)
          throw new ModelRequestError('deadline_exceeded');
        return decoded;
      } catch (error) {
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (!reported && requestId !== null)
          control.reportModelResponse?.({
            model: null,
            requestId,
            usage: null,
          });
        if (timeout.signal.aborted || Date.now() >= deadline)
          throw new ModelRequestError('deadline_exceeded');
        if (error instanceof ModelRequestError) throw error;
        throw new ModelRequestError(
          error instanceof TypeError ? 'unavailable' : 'request_failed',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
