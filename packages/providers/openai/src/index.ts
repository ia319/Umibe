import OpenAI from 'openai';
import {
  isJsonObject,
  parseJsonValue,
  ModelRequestError,
} from '@umibe/core/model';
import type { JsonObject, StructuredOutputModel } from '@umibe/core/model';
import { classifyError } from './errors.js';
import { decodeResponse } from './response.js';

export interface OpenAIModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Positive safe integer; the adapter never increases this limit after truncation. */
  readonly maxOutputTokens: number;
  /** Defaults to the official API. Explicit HTTP URLs support local protocol testing. */
  readonly baseURL?: string;
  /** UTF-8 request body limit, default 1 MiB. This does not estimate token usage. */
  readonly maxRequestBytes?: number;
  /** Decoded response body limit, default 8 MiB, including HTTP error bodies. */
  readonly maxResponseBytes?: number;
}

/**
 * Create a stateless Responses API adapter without making a request.
 * Missing credentials or invalid options throw TypeError or RangeError.
 * Each generate call sends at most one SDK request and stores no remote history.
 * Credentials remain in the client closure and never enter model metadata.
 */
export function createOpenAIModel(
  options: OpenAIModelOptions,
): StructuredOutputModel {
  if (typeof options.apiKey !== 'string' || options.apiKey.trim() === '')
    throw new TypeError('apiKey is required');
  if (typeof options.model !== 'string' || options.model.trim() === '')
    throw new TypeError('model is required');
  const maxRequestBytes = options.maxRequestBytes ?? 1_048_576;
  const maxResponseBytes = options.maxResponseBytes ?? 8_388_608;
  const maxOutputTokens = options.maxOutputTokens;
  for (const [name, value] of Object.entries({
    maxRequestBytes,
    maxResponseBytes,
    maxOutputTokens,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive safe integer`);
  }
  const baseURL = new URL(options.baseURL ?? 'https://api.openai.com/v1');
  if (
    !['https:', 'http:'].includes(baseURL.protocol) ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  )
    throw new TypeError(
      'baseURL must be an HTTP endpoint without credentials, query or fragment',
    );
  const identity = Object.freeze({ provider: 'openai', model: options.model });
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: baseURL.href,
    maxRetries: 0,
    logLevel: 'off',
  });
  return Object.freeze<StructuredOutputModel>({
    kind: 'structuredOutput',
    identity,
    async generate(request, control) {
      const deadline = Date.parse(control.deadlineAt);
      if (
        !(control.signal instanceof AbortSignal) ||
        !Number.isFinite(deadline) ||
        new Date(deadline).toISOString() !== control.deadlineAt
      )
        throw new ModelRequestError('invalid_request');
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ModelRequestError('deadline_exceeded');
      let schema: JsonObject;
      let input: string;
      try {
        const parsed = parseJsonValue(request.output.schema, 'model_schema');
        if (!isJsonObject(parsed) || parsed.type !== 'object')
          throw new ModelRequestError('invalid_request');
        schema = parsed;
        input = JSON.stringify(parseJsonValue(request.input, 'model_input'));
        if (
          typeof request.instructions !== 'string' ||
          request.instructions.trim() === '' ||
          typeof request.output.name !== 'string' ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(request.output.name)
        )
          throw new ModelRequestError('invalid_request');
      } catch {
        throw new ModelRequestError('invalid_request');
      }
      const body = {
        model: identity.model,
        instructions: request.instructions,
        input: [{ role: 'user' as const, content: input }],
        text: {
          format: {
            type: 'json_schema' as const,
            name: request.output.name,
            schema,
            strict: true,
          },
        },
        max_output_tokens: maxOutputTokens,
        stream: false as const,
        store: false,
      };
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxRequestBytes)
        throw new ModelRequestError('input_limit');
      if (control.signal.aborted)
        throw new DOMException('Model request cancelled', 'AbortError');
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new ModelRequestError('deadline_exceeded');
      let receivedRequestId: string | null = null;
      let reported = false;
      // Response identity belongs to this invocation. Keep it even if bounded
      // body reading fails; shared model instances may serve concurrent roles.
      const requestClient = client.withOptions({
        fetch: async (input, init) => {
          // SDK request preparation can consume the remaining caller deadline.
          if (control.signal.aborted)
            throw new DOMException('Model request cancelled', 'AbortError');
          if (Date.now() >= deadline)
            throw new ModelRequestError('deadline_exceeded');
          const response = await fetch(input, init);
          receivedRequestId =
            response.headers.get('x-request-id')?.trim() || null;
          const chunks: Uint8Array[] = [];
          let length = 0;
          const reader = response.body?.getReader();
          if (reader !== undefined) {
            try {
              // Read inside SDK fetch so its timeout also bounds error bodies.
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > maxResponseBytes) {
                  await reader.cancel();
                  throw new ModelRequestError('invalid_response');
                }
                chunks.push(chunk.value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          return new Response(
            length === 0 ? null : Buffer.concat(chunks, length),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          );
        },
      });
      try {
        const response = await requestClient.responses
          .create(body, {
            maxRetries: 0,
            timeout,
            signal: control.signal,
          })
          .asResponse();
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (Date.now() >= deadline)
          throw new ModelRequestError('deadline_exceeded');
        if (
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'application/json'
        )
          throw new ModelRequestError('invalid_response');
        const data: unknown = await response.json();
        return decodeResponse(data, receivedRequestId, {
          ...control,
          reportModelResponse(metadata) {
            reported = true;
            control.reportModelResponse?.(metadata);
          },
        });
      } catch (error) {
        if (control.signal.aborted)
          throw new DOMException('Model request cancelled', 'AbortError');
        if (!reported && receivedRequestId !== null)
          control.reportModelResponse?.({
            model: null,
            requestId: receivedRequestId,
            usage: null,
          });
        throw classifyError(error);
      }
    },
  });
}
