import {
  isJsonObject,
  ModelRequestError,
  parseJsonValue,
} from '@umibe/core/model';
import type { ChoiceModel, JsonObject, JsonValue } from '@umibe/core/model';
import { encodeRequest } from './request.js';
import { decodeResponse } from './response.js';
import { cloudflareFailure, protocolFailure } from './errors.js';

export interface CloudflareModelOptions {
  /** Account path segment; letters, digits, underscores and hyphens only. */
  readonly accountId: string;
  readonly apiToken: string;
  /** Workers AI model path; the model must implement the Clef choice protocol. */
  readonly model: string;
  /**
   * Native JSON body fields, copied at construction and passed to Cloudflare.
   * The body model defaults to the last path segment and may be set here.
   * state, questions and stream are adapter-owned; supplying them throws TypeError.
   */
  readonly parameters?: JsonObject;
  /**
   * Reject reported input usage at or above this token count as input_limit.
   * Set it to the chosen model's context window to detect possible truncation.
   * No window is inferred; without it, provider-side truncation is undetectable.
   */
  readonly contextWindowTokens?: number;
  /**
   * Defaults to the official REST root. Require HTTPS except for HTTP protocol
   * tests at localhost, 127.0.0.1 or [::1]. Credentials, query and fragment are rejected.
   */
  readonly baseURL?: string;
  /** UTF-8 HTTP body limit, default 1 MiB; independent of model token limits. */
  readonly maxRequestBytes?: number;
  /** Decoded HTTP body limit, default 8 MiB, also enforced on errors. */
  readonly maxResponseBytes?: number;
}

/**
 * Create a stateless hosted Clef adapter without sending a request or reading env.
 * Invalid configuration throws. Each choose call sends at most one POST,
 * without retries, redirects or fallback. Its deadline includes
 * response body reading. Input is sent in full; Cloudflare may truncate state
 * that exceeds the model's context window.
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
  if (typeof options.model !== 'string' || options.model.trim() === '')
    throw new TypeError('model is required');
  const modelParts = options.model.split('/');
  if (modelParts.some((part) => part === '' || part === '.' || part === '..'))
    throw new TypeError('model must contain nonempty model path segments');
  const parameters = parseJsonValue(
    options.parameters === undefined ? {} : options.parameters,
    'cloudflare_parameters',
  );
  if (!isJsonObject(parameters))
    throw new TypeError('parameters must be a JSON object');
  for (const key of ['state', 'questions', 'stream'])
    if (Object.hasOwn(parameters, key))
      throw new TypeError(`parameters.${key} is controlled by the adapter`);
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 8_388_608;
  const contextWindowTokens = options.contextWindowTokens;
  for (const [name, value] of Object.entries({
    maxRequestBytes,
    maxResponseBytes,
    contextWindowTokens,
  }))
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
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
  const modelPath = modelParts
    .map(encodeURIComponent)
    .join('/')
    .replaceAll('%40', '@');
  const endpoint = `${baseURL.href.replace(/\/$/, '')}/accounts/${options.accountId}/ai/run/${modelPath}`;
  const bodyModel = modelParts.at(-1)!;
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
      const { body, ids } = encodeRequest(
        request,
        bodyModel,
        parameters,
        maxRequestBytes,
      );
      await control.recordModelRequest?.({
        protocol: 'http',
        method: 'POST',
        body,
      });
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
        let complete = false;
        let responseBody: Buffer<ArrayBuffer>;
        try {
          if (reader !== undefined) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              length += chunk.value.byteLength;
              chunks.push(chunk.value);
              if (length > maxResponseBytes) {
                await reader.cancel();
                throw protocolFailure('', 'response_too_large');
              }
            }
          }
          complete = true;
        } finally {
          reader?.releaseLock();
          responseBody = Buffer.concat(chunks, length);
          await control.recordModelResult?.({
            protocol: 'http',
            method: 'POST',
            body: responseBody.toString('base64'),
            encoding: 'base64',
            complete,
            status: response.status,
          });
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
              new TextDecoder('utf-8', { fatal: true }).decode(responseBody),
            ),
            'clef_response',
          );
        } catch {
          throw protocolFailure('', 'invalid_json');
        }
        const decoded = decodeResponse(
          data,
          ids,
          requestId,
          response.headers,
          {
            ...control,
            reportModelResponse(metadata) {
              reported = true;
              control.reportModelResponse?.(metadata);
            },
          },
          contextWindowTokens,
        );
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
