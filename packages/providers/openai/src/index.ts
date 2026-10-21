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
  /**
   * Native Responses body fields, copied at construction and passed to the API.
   * model and max_output_tokens use the explicit options above. Input, instructions,
   * history, tools, truncation and execution mode are adapter-owned; conflicts throw
   * TypeError. text must be an object and may include fields such as verbosity,
   * but text.format is reserved for the runner's schema.
   */
  readonly parameters?: JsonObject;
  /**
   * Defaults to the official API. Require HTTPS except for HTTP protocol tests
   * at localhost, 127.0.0.1 or [::1]. Credentials, query and fragment are rejected.
   */
  readonly baseURL?: string;
  /** UTF-8 request body limit, default 1 MiB. This does not estimate token usage. */
  readonly maxRequestBytes?: number;
  /** Decoded response body limit, default 8 MiB, including HTTP error bodies. */
  readonly maxResponseBytes?: number;
}

/**
 * Create a stateless Responses API adapter without making a request.
 * Missing credentials or invalid options throw.
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
  const parameters = parseJsonValue(
    options.parameters === undefined ? {} : options.parameters,
    'openai_parameters',
  );
  if (!isJsonObject(parameters))
    throw new TypeError('parameters must be a JSON object');
  // These fields can replace role content, invoke tools or outlive a bounded call.
  for (const key of [
    'model',
    'max_output_tokens',
    'instructions',
    'input',
    'stream',
    'stream_options',
    'store',
    'background',
    'conversation',
    'previous_response_id',
    'prompt',
    'context_management',
    'truncation',
    'tools',
    'tool_choice',
  ])
    if (Object.hasOwn(parameters, key))
      throw new TypeError(`parameters.${key} is controlled by the adapter`);
  const textParameters = parameters.text;
  if (textParameters !== undefined) {
    if (!isJsonObject(textParameters))
      throw new TypeError('parameters.text must be a JSON object');
    if (Object.hasOwn(textParameters, 'format'))
      throw new TypeError(
        'parameters.text.format is controlled by the adapter',
      );
  }
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
        ...parameters,
        model: identity.model,
        instructions: request.instructions,
        input: [{ role: 'user' as const, content: input }],
        text: {
          ...textParameters,
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
          if (typeof init?.body !== 'string')
            throw new ModelRequestError('invalid_request');
          await control.recordModelRequest?.({
            protocol: 'http',
            method: init.method ?? 'GET',
            body: init.body,
          });
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
          let complete = false;
          let responseBody: Buffer<ArrayBuffer>;
          try {
            if (reader !== undefined) {
              // Read inside SDK fetch so its timeout also bounds error bodies.
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                chunks.push(chunk.value);
                if (length > maxResponseBytes) {
                  await reader.cancel();
                  throw new ModelRequestError('invalid_response');
                }
              }
            }
            complete = true;
          } finally {
            reader?.releaseLock();
            responseBody = Buffer.concat(chunks, length);
            await control.recordModelResult?.({
              protocol: 'http',
              method: init.method ?? 'GET',
              body: responseBody.toString('base64'),
              encoding: 'base64',
              complete,
              status: response.status,
            });
          }
          return new Response(length === 0 ? null : responseBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
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
