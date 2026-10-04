import { expect, test, vi } from 'vitest';
import type { JsonObject } from '@umibe/core/model';
import { ModelRequestError } from '@umibe/core/model';
import { createOpenAIModel } from './index.js';
import {
  httpFixture,
  responseBody,
  structuredRequest,
  callControl,
} from './__tests__/http.js';

const options = {
  apiKey: 'test-only-key',
  model: 'configured-model',
  maxOutputTokens: 100,
};

test('sends one stateless SDK request with strict schema and reports actual response metadata', async () => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'req_fixture',
    });
    response.end(JSON.stringify(responseBody({ ok: true })));
  });
  const model = createOpenAIModel({ ...options, baseURL: h.baseURL });
  expect(h.requests).toHaveLength(0);
  const report = vi.fn();
  await expect(
    model.generate(structuredRequest, {
      ...callControl(),
      reportModelResponse: report,
    }),
  ).resolves.toEqual({ ok: true });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({
    method: 'POST',
    url: '/v1/responses',
    headers: {
      authorization: 'Bearer test-only-key',
      'x-stainless-retry-count': '0',
    },
    body: {
      model: 'configured-model',
      instructions: structuredRequest.instructions,
      input: [
        { role: 'user', content: JSON.stringify(structuredRequest.input) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'fixture',
          strict: true,
          schema: structuredRequest.output.schema,
        },
      },
      max_output_tokens: 100,
      stream: false,
      store: false,
    },
  });
  expect(report).toHaveBeenCalledExactlyOnceWith({
    model: 'actual-model',
    requestId: 'req_fixture',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  });
  expect(Object.isFrozen(model)).toBe(true);
  expect(JSON.stringify(model)).not.toContain('test-only-key');
});

test.each([
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [400, 'invalid_request'],
  [404, 'invalid_request'],
  [422, 'invalid_request'],
  [429, 'rate_limited'],
  [408, 'deadline_exceeded'],
  [500, 'unavailable'],
  [503, 'unavailable'],
  [529, 'unavailable'],
  [409, 'request_failed'],
  [418, 'request_failed'],
] as const)(
  'classifies HTTP %s as %s without SDK retries or raw error details',
  async (status, code) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': 'failed-request',
      });
      response.end(
        JSON.stringify({
          error: { message: 'private-provider-error', code: 'test_error' },
        }),
      );
    });
    const report = vi.fn();
    const model = createOpenAIModel({ ...options, baseURL: h.baseURL });
    await expect(
      model.generate(structuredRequest, {
        ...callControl(),
        reportModelResponse: report,
      }),
    ).rejects.toMatchObject({ name: 'ModelRequestError', code, message: code });
    expect(h.requests).toHaveLength(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      model: null,
      requestId: 'failed-request',
      usage: null,
    });
  },
);

test.each([
  [{ 'retry-after': '1.25' }, 1250],
  [{ 'retry-after-ms': '500.5' }, 501],
  [{ 'retry-after': '2', 'retry-after-ms': '100' }, 2000],
  [{ 'retry-after': '-1', 'retry-after-ms': 'Infinity' }, 0],
  [{ 'retry-after': '9007199254740992' }, 0],
  [{ 'retry-after': '1invalid' }, 0],
] as const)('normalizes delay headers %j', async (headers, delay) => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json', ...headers });
    response.end('{}');
  });
  await expect(
    createOpenAIModel({ ...options, baseURL: h.baseURL }).generate(
      structuredRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: delay });
  expect(h.requests).toHaveLength(1);
});

test('parses an HTTP-date delay and a documented input limit', async () => {
  const retryAt = Date.now() + 10_000;
  const headerDate = new Date(retryAt).toUTCString();
  const h = await httpFixture((_request, response) => {
    response.writeHead(429, {
      'content-type': 'application/json',
      'retry-after': headerDate,
    });
    response.end('{}');
  });
  const before = Date.now();
  const error: unknown = await createOpenAIModel({
    ...options,
    baseURL: h.baseURL,
  })
    .generate(structuredRequest, callControl())
    .catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'rate_limited' });
  if (!(error instanceof ModelRequestError))
    throw new Error('Expected a classified model failure');
  expect(error.retryAfterMs).toBeGreaterThanOrEqual(
    Date.parse(headerDate) - Date.now(),
  );
  expect(error.retryAfterMs).toBeLessThanOrEqual(
    Date.parse(headerDate) - before,
  );
  const limit = await httpFixture((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { code: 'context_length_exceeded' } }),
    );
  });
  await expect(
    createOpenAIModel({ ...options, baseURL: limit.baseURL }).generate(
      structuredRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'input_limit' });
});

test.each([
  [
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    },
    'output_truncated',
  ],
  [
    { status: 'incomplete', incomplete_details: { reason: 'content_filter' } },
    'refused',
  ],
  [
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'declined' }],
        },
      ],
    },
    'refused',
  ],
  [
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{broken' }],
        },
      ],
    },
    'invalid_response',
  ],
  [{ output: [] }, 'invalid_response'],
  [
    { output: [{ type: 'function_call', name: 'unexpected' }] },
    'invalid_response',
  ],
  [{ status: 'in_progress' }, 'invalid_response'],
  [
    { usage: { input_tokens: -1, output_tokens: 3, total_tokens: 2 } },
    'invalid_response',
  ],
] satisfies readonly (readonly [JsonObject, string])[])(
  'retains metadata for an unsuccessful response %j',
  async (overrides, code) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseBody({ ok: true }, overrides)));
    });
    const report = vi.fn();
    await expect(
      createOpenAIModel({ ...options, baseURL: h.baseURL }).generate(
        structuredRequest,
        { ...callControl(), reportModelResponse: report },
      ),
    ).rejects.toMatchObject({ code });
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toMatchObject({ model: 'actual-model' });
    if (!Object.hasOwn(overrides, 'usage'))
      expect(report.mock.calls[0]?.[0]).toMatchObject({
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      });
    expect(h.requests).toHaveLength(1);
  },
);

test.each(['invalid-json', 'empty', 'content-type', 'oversized'] as const)(
  'rejects %s transport bodies',
  async (failure) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, {
        'x-request-id': 'malformed-response',
        'content-type':
          failure === 'content-type' ? 'text/plain' : 'application/json',
      });
      response.end(
        failure === 'invalid-json'
          ? '{'
          : failure === 'empty'
            ? ''
            : failure === 'oversized'
              ? 'x'.repeat(1000)
              : JSON.stringify(responseBody({ ok: true })),
      );
    });
    const model = createOpenAIModel({
      ...options,
      baseURL: h.baseURL,
      maxResponseBytes: 900,
    });
    const report = vi.fn();
    await expect(
      model.generate(structuredRequest, {
        ...callControl(),
        reportModelResponse: report,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(report).toHaveBeenCalledExactlyOnceWith({
      model: null,
      requestId: 'malformed-response',
      usage: null,
    });
    expect(h.requests).toHaveLength(1);
  },
);

test.each([200, 503])(
  'bounds a stalled HTTP %s response body with the SDK timeout',
  async (status) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.write('{');
    });
    await expect(
      createOpenAIModel({ ...options, baseURL: h.baseURL }).generate(
        structuredRequest,
        callControl(100),
      ),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(h.requests).toHaveLength(1);
  },
);

test('cancels during response reading and performs no request when already stopped', async () => {
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    started();
  });
  const model = createOpenAIModel({ ...options, baseURL: h.baseURL });
  const controller = new AbortController();
  const pending = model.generate(structuredRequest, {
    ...callControl(),
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  await received;
  controller.abort();
  await rejected;
  await expect(
    model.generate(structuredRequest, {
      ...callControl(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await expect(
    model.generate(structuredRequest, callControl(-1)),
  ).rejects.toMatchObject({ code: 'deadline_exceeded' });
  expect(h.requests).toHaveLength(1);
});

test('validates construction and input byte limits before any HTTP request', async () => {
  const h = await httpFixture((_request, response) => {
    response.end();
  });
  expect(() => createOpenAIModel({ ...options, apiKey: '' })).toThrow(
    TypeError,
  );
  expect(() => createOpenAIModel({ ...options, maxOutputTokens: 0 })).toThrow(
    RangeError,
  );
  expect(() =>
    createOpenAIModel({ ...options, baseURL: 'http://user:pass@localhost' }),
  ).toThrow(TypeError);
  const model = createOpenAIModel({
    ...options,
    baseURL: h.baseURL,
    maxRequestBytes: 10,
  });
  await expect(
    model.generate(structuredRequest, callControl()),
  ).rejects.toMatchObject({ code: 'input_limit' });
  expect(h.requests).toHaveLength(0);
});

test('classifies a disconnected response as unavailable without another request', async () => {
  const h = await httpFixture((_request, response) => {
    response.destroy();
  });
  await expect(
    createOpenAIModel({ ...options, baseURL: h.baseURL }).generate(
      structuredRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(h.requests).toHaveLength(1);
});

test('records absent usage as unknown while accepting valid structured output', async () => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody({ ok: true }, { usage: null })));
  });
  const report = vi.fn();
  await expect(
    createOpenAIModel({ ...options, baseURL: h.baseURL }).generate(
      structuredRequest,
      { ...callControl(), reportModelResponse: report },
    ),
  ).resolves.toEqual({ ok: true });
  expect(report).toHaveBeenCalledExactlyOnceWith({
    model: 'actual-model',
    requestId: null,
    usage: null,
  });
});

test('checks the deadline again after preparing the request without dispatching', async () => {
  const h = await httpFixture((_request, response) => {
    response.end('{}');
  });
  const model = createOpenAIModel({ ...options, baseURL: h.baseURL });
  const control = callControl(1000);
  const deadline = Date.parse(control.deadlineAt);
  const fetchCall = vi.spyOn(globalThis, 'fetch');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1);
  clock.mockReturnValueOnce(deadline - 1).mockReturnValueOnce(deadline);
  try {
    await expect(
      model.generate(structuredRequest, control),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(h.requests).toHaveLength(0);
    expect(fetchCall).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    fetchCall.mockRestore();
  }
});

test('isolates response identity across concurrent requests on a shared model', async () => {
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const h = await httpFixture(async (_request, response) => {
    const current = ++calls;
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': `request-${current}`,
    });
    response.flushHeaders();
    if (current === 1) {
      started();
      await firstMayFinish;
      response.end('{invalid');
    } else {
      response.end(JSON.stringify(responseBody({ ok: true })));
    }
  });
  const model = createOpenAIModel({ ...options, baseURL: h.baseURL });
  const firstReport = vi.fn();
  const secondReport = vi.fn();
  const first = model.generate(structuredRequest, {
    ...callControl(),
    reportModelResponse: firstReport,
  });
  const rejected = expect(first).rejects.toMatchObject({
    code: 'invalid_response',
  });
  await firstStarted;
  await expect(
    model.generate(structuredRequest, {
      ...callControl(),
      reportModelResponse: secondReport,
    }),
  ).resolves.toEqual({ ok: true });
  releaseFirst();
  await rejected;
  expect(firstReport).toHaveBeenCalledExactlyOnceWith({
    model: null,
    requestId: 'request-1',
    usage: null,
  });
  expect(secondReport).toHaveBeenCalledExactlyOnceWith({
    model: 'actual-model',
    requestId: 'request-2',
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
  });
  expect(h.requests).toHaveLength(2);
});
