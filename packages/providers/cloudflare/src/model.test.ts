import { expect, test, vi } from 'vitest';
import { isJsonObject, ModelRequestError } from '@umibe/core/model';
import type { ChoiceRequest, JsonObject } from '@umibe/core/model';
import { createCloudflareModel } from './index.js';
import {
  callControl,
  choiceRequest,
  httpFixture,
  options,
  responseBody,
} from './__tests__/http.js';

test('sends a single native request with exact fields and independent confidence and usage', async () => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cf-ai-req-id': 'request-one',
    });
    response.end(JSON.stringify(responseBody()));
  });
  const model = createCloudflareModel({ ...options, baseURL: h.baseURL });
  expect(h.requests).toHaveLength(0);
  const report = vi.fn();
  await expect(
    model.choose(choiceRequest, {
      ...callControl(),
      reportModelResponse: report,
    }),
  ).resolves.toEqual({
    optionId: 'a',
    probabilities: { a: 1, none: 0 },
    confidence: 0.04,
  });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({
    method: 'POST',
    url: '/client/v4/accounts/test-account/ai/run/@cf/cloudflare/clef',
    headers: {
      authorization: 'Bearer test-only-token',
      'content-type': 'application/json',
    },
    body: {
      model: 'clef',
      state: JSON.stringify(choiceRequest.input),
      questions: {
        selection: {
          type: 'choice',
          instructions: choiceRequest.instructions,
          criteria: { a: { action: 'safe_a' }, none: 'Abstain' },
        },
      },
    },
  });
  expect(report).toHaveBeenCalledExactlyOnceWith({
    model: 'actual-clef',
    requestId: 'request-one',
    usage: { inputTokens: 17, outputTokens: 0, totalTokens: 17 },
  });
  expect(model.maxOptions).toBe(255);
  expect(Object.isFrozen(model)).toBe(true);
  expect(JSON.stringify(model)).not.toContain('test-only-token');
});

test.each([
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [400, 'invalid_request'],
  [404, 'invalid_request'],
  [405, 'invalid_request'],
  [422, 'invalid_request'],
  [413, 'input_limit'],
  [429, 'rate_limited'],
  [408, 'deadline_exceeded'],
  [500, 'unavailable'],
  [503, 'unavailable'],
  [529, 'unavailable'],
  [409, 'request_failed'],
  [418, 'request_failed'],
] as const)(
  'classifies HTTP %s as %s with no hidden retry',
  async (status, code) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cf-ai-req-id': 'failure',
      });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 99999, message: 'must-not-persist' }],
        }),
      );
    });
    const report = vi.fn();
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        { ...callControl(), reportModelResponse: report },
      ),
    ).rejects.toMatchObject({ name: 'ModelRequestError', code, message: code });
    expect(h.requests).toHaveLength(1);
    expect(report).toHaveBeenCalledExactlyOnceWith({
      model: null,
      requestId: 'failure',
      usage: null,
    });
  },
);

test.each([
  [5018, 'unauthorized'],
  [3006, 'input_limit'],
  [5007, 'invalid_request'],
  [3007, 'deadline_exceeded'],
  [3040, 'rate_limited'],
  [99999, 'request_failed'],
] as const)(
  'classifies documented envelope code %s as %s',
  async (internal, code) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: internal, message: 'private-error' }],
          result: null,
        }),
      );
    });
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        callControl(),
      ),
    ).rejects.toMatchObject({ code, message: code });
    expect(h.requests).toHaveLength(1);
  },
);

test.each([
  ['1.25', 1250],
  ['-1', 0],
  ['Infinity', 0],
  ['9007199254740992', 0],
  ['1invalid', 0],
] as const)('validates Retry-After %s', async (value, delay) => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(429, { 'retry-after': value });
    response.end('');
  });
  await expect(
    createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
      choiceRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: delay });
  expect(h.requests).toHaveLength(1);
});

test('reads a Retry-After HTTP date without shortening it', async () => {
  const retryAt = new Date(Date.now() + 10000).toUTCString();
  const h = await httpFixture((_request, response) => {
    response.writeHead(429, { 'retry-after': retryAt });
    response.end();
  });
  const before = Date.now();
  const error: unknown = await createCloudflareModel({
    ...options,
    baseURL: h.baseURL,
  })
    .choose(choiceRequest, callControl())
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ModelRequestError);
  if (!(error instanceof ModelRequestError))
    throw new Error('Expected model error');
  expect(error.retryAfterMs).toBeGreaterThanOrEqual(
    Date.parse(retryAt) - Date.now(),
  );
  expect(error.retryAfterMs).toBeLessThanOrEqual(Date.parse(retryAt) - before);
});

test.each([
  ['missing-success', { errors: [], result: {} }],
  ['false-empty-errors', { success: false, errors: [], result: {} }],
  [
    'success-with-errors',
    { success: true, errors: [{ code: 3007 }], result: {} },
  ],
  ['missing-result', { success: true, errors: [] }],
  [
    'invalid-errors',
    { success: false, errors: [{ code: '3007' }], result: {} },
  ],
] satisfies readonly (readonly [string, JsonObject])[])(
  'rejects %s before trusting nested metadata',
  async (_name, body) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    const report = vi.fn();
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        { ...callControl(), reportModelResponse: report },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      issue: { phase: 'protocol' },
    });
    expect(report).not.toHaveBeenCalled();
  },
);

test.each([
  { choice: 'foreign' },
  { type: 'noul' },
  { probabilities: { a: 1 } },
  { probabilities: { a: 1, none: 0, foreign: 0 } },
  { probabilities: { a: null, none: 1 } },
  { probabilities: { a: '1', none: 0 } },
  { probabilities: { a: -0.1, none: 1.1 } },
  { probabilities: { a: 0.4, none: 0.4 } },
  { probabilities: { a: 0.1, none: 0.9 } },
  { confidence: null },
  { confidence: 1.1 },
  { confidence: '0.8' },
  { extra: 'must-not-persist' },
] satisfies readonly JsonObject[])(
  'rejects invalid choice answer %# while retaining response usage',
  async (overrides) => {
    const body = responseBody();
    if (
      !isJsonObject(body.result) ||
      !isJsonObject(body.result.answers) ||
      !isJsonObject(body.result.answers.selection)
    )
      throw new Error('Expected fixture answer');
    const result = {
      ...body.result,
      answers: {
        selection: { ...body.result.answers.selection, ...overrides },
      },
    };
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...body, result }));
    });
    const report = vi.fn();
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        { ...callControl(), reportModelResponse: report },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      issue: { phase: 'protocol' },
    });
    expect(report).toHaveBeenCalledExactlyOnceWith({
      model: 'actual-clef',
      requestId: null,
      usage: { inputTokens: 17, outputTokens: 0, totalTokens: 17 },
    });
  },
);

test.each([
  { model: '' },
  { usage: { input_tokens: -1, output_tokens: 0 } },
  { usage: { input_tokens: 0.5, output_tokens: 0 } },
  { usage: { input_tokens: 3 } },
  { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } },
  { usage: null },
  { answers: { another: { type: 'choice' } } },
  { answers: { selection: {}, extra: {} } },
] satisfies readonly JsonObject[])(
  'rejects invalid result %# and preserves only valid metadata fields',
  async (overrides) => {
    const body = responseBody();
    if (!isJsonObject(body.result)) throw new Error('Expected fixture result');
    const result = { ...body.result, ...overrides };
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...body, result }));
    });
    const report = vi.fn();
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        { ...callControl(), reportModelResponse: report },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(report).toHaveBeenCalledOnce();
  },
);

test.each([
  { a: 0.5, none: 0.5 },
  { a: 0.5000001, none: 0.5000002 },
])(
  'accepts ties and floating-point tolerance %j without changing the selected ID',
  async (probabilities) => {
    const body = {
      success: true,
      errors: [],
      result: {
        model: 'clef',
        usage: { input_tokens: 3, output_tokens: 0 },
        answers: {
          selection: {
            type: 'choice',
            choice: 'a',
            probabilities,
            confidence: 0.0001,
          },
        },
      },
    };
    const h = await httpFixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        callControl(),
      ),
    ).resolves.toEqual({ optionId: 'a', probabilities, confidence: 0.0001 });
  },
);

test('retains special option IDs and an immutable request snapshot', async () => {
  let started!: () => void;
  let release!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ids = ['__proto__', 'constructor'];
  const h = await httpFixture(async (_request, response) => {
    started();
    await ready;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody(ids)));
  });
  const request = {
    ...choiceRequest,
    options: ids.map((id) => ({ id, description: null })),
  };
  const pending = createCloudflareModel({
    ...options,
    baseURL: h.baseURL,
  }).choose(request, callControl());
  await received;
  request.options[0]!.id = 'mutated';
  release();
  const result = await pending;
  expect(result.optionId).toBe('__proto__');
  expect(Object.keys(result.probabilities!)).toEqual(ids);
  expect(Object.isFrozen(result.probabilities)).toBe(true);
  expect(JSON.stringify(h.requests[0]!.body)).toContain('"__proto__":null');
});

test.each([
  'invalid-json',
  'empty',
  'content-type',
  'oversized',
  'invalid-utf8',
] as const)('rejects %s bodies and keeps the request ID', async (failure) => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, {
      'content-type':
        failure === 'content-type' ? 'text/plain' : 'application/json',
      'cf-ai-req-id': 'malformed',
    });
    response.end(
      failure === 'invalid-json'
        ? '{'
        : failure === 'empty'
          ? ''
          : failure === 'oversized'
            ? 'x'.repeat(1000)
            : failure === 'invalid-utf8'
              ? Buffer.from([0xff])
              : JSON.stringify(responseBody()),
    );
  });
  const report = vi.fn();
  await expect(
    createCloudflareModel({
      ...options,
      baseURL: h.baseURL,
      maxResponseBytes: 900,
    }).choose(choiceRequest, { ...callControl(), reportModelResponse: report }),
  ).rejects.toMatchObject({ code: 'invalid_response' });
  expect(report).toHaveBeenCalledExactlyOnceWith({
    model: null,
    requestId: 'malformed',
    usage: null,
  });
});

test.each([200, 503])(
  'bounds stalled HTTP %s response reading',
  async (status) => {
    const h = await httpFixture((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.write('{');
    });
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        callControl(100),
      ),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(h.requests).toHaveLength(1);
  },
);

test.each(['sending', 'reading'] as const)(
  'cancels during %s and sends nothing after cancellation or expiry',
  async (stage) => {
    let started!: () => void;
    const received = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = await httpFixture((_request, response) => {
      if (stage === 'reading') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
      started();
    });
    const model = createCloudflareModel({ ...options, baseURL: h.baseURL });
    const controller = new AbortController();
    const pending = model.choose(choiceRequest, {
      ...callControl(),
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    await received;
    controller.abort();
    await rejection;
    await expect(
      model.choose(choiceRequest, {
        ...callControl(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      model.choose(choiceRequest, callControl(-1)),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(h.requests).toHaveLength(1);
  },
);

test('rejects redirects and disconnected bodies without a second request', async () => {
  const redirected = await httpFixture((_request, response) => {
    response.writeHead(307, { location: '/other' });
    response.end();
  });
  await expect(
    createCloudflareModel({ ...options, baseURL: redirected.baseURL }).choose(
      choiceRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'request_failed' });
  expect(redirected.requests).toHaveLength(1);
  const broken = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    setImmediate(() => response.destroy());
  });
  await expect(
    createCloudflareModel({ ...options, baseURL: broken.baseURL }).choose(
      choiceRequest,
      callControl(),
    ),
  ).rejects.toMatchObject({ code: 'unavailable' });
  expect(broken.requests).toHaveLength(1);
});

test('separates conservative state bytes, HTTP bytes and the model token window', async () => {
  const h = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody()));
  });
  const model = createCloudflareModel({ ...options, baseURL: h.baseURL });
  await expect(
    model.choose({ ...choiceRequest, input: 'x'.repeat(2048) }, callControl()),
  ).resolves.toMatchObject({ optionId: 'a' });
  await expect(
    model.choose({ ...choiceRequest, input: 'x'.repeat(2049) }, callControl()),
  ).rejects.toMatchObject({ code: 'input_limit' });
  await expect(
    model.choose({ ...choiceRequest, input: '中'.repeat(683) }, callControl()),
  ).rejects.toMatchObject({ code: 'input_limit' });
  await expect(
    model.choose(
      {
        ...choiceRequest,
        input: 'small',
        instructions: { question: 'Choose', references: 'x'.repeat(9000) },
      },
      callControl(),
    ),
  ).resolves.toMatchObject({ optionId: 'a' });
  await expect(
    createCloudflareModel({
      ...options,
      baseURL: h.baseURL,
      maxRequestBytes: 100,
    }).choose(choiceRequest, callControl()),
  ).rejects.toMatchObject({ code: 'input_limit' });
  expect(h.requests).toHaveLength(2);
  const body = responseBody();
  if (!isJsonObject(body.result)) throw new Error('Expected fixture result');
  const saturated = {
    ...body,
    result: {
      ...body.result,
      usage: { input_tokens: 65536, output_tokens: 0 },
    },
  };
  const saturatedHttp = await httpFixture((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(saturated));
  });
  const report = vi.fn();
  await expect(
    createCloudflareModel({
      ...options,
      baseURL: saturatedHttp.baseURL,
    }).choose(choiceRequest, { ...callControl(), reportModelResponse: report }),
  ).rejects.toMatchObject({ code: 'input_limit' });
  expect(report.mock.calls[0]![0]).toMatchObject({
    usage: { inputTokens: 65536 },
  });
});

test('validates configuration and native request limits before network access', async () => {
  const h = await httpFixture((_request, response) => {
    response.end();
  });
  expect(() => createCloudflareModel({ ...options, apiToken: '' })).toThrow(
    TypeError,
  );
  expect(() =>
    createCloudflareModel({ ...options, accountId: '../other' }),
  ).toThrow(TypeError);
  expect(() =>
    createCloudflareModel({ ...options, maxResponseBytes: 0 }),
  ).toThrow(RangeError);
  expect(() =>
    createCloudflareModel({
      ...options,
      baseURL: 'http://user:password@localhost',
    }),
  ).toThrow(TypeError);
  const model = createCloudflareModel({ ...options, baseURL: h.baseURL });
  const invalid: readonly ChoiceRequest[] = [
    { ...choiceRequest, instructions: '' },
    { ...choiceRequest, options: [] },
    { ...choiceRequest, options: [choiceRequest.options[0]!] },
    {
      ...choiceRequest,
      options: [choiceRequest.options[0]!, choiceRequest.options[0]!],
    },
    {
      ...choiceRequest,
      options: Array.from({ length: 256 }, (_, index) => ({
        id: `id-${index}`,
        description: null,
      })),
    },
    {
      ...choiceRequest,
      options: [{ id: '', description: null }, choiceRequest.options[1]!],
    },
  ];
  for (const request of invalid)
    await expect(model.choose(request, callControl())).rejects.toMatchObject({
      code: 'invalid_request',
    });
  expect(h.requests).toHaveLength(0);
});

test('rechecks deadline after request encoding before dispatch', async () => {
  const h = await httpFixture((_request, response) => {
    response.end();
  });
  const control = callControl();
  const deadline = Date.parse(control.deadlineAt);
  const fetchCall = vi.spyOn(globalThis, 'fetch');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
  clock.mockReturnValueOnce(deadline - 1);
  try {
    await expect(
      createCloudflareModel({ ...options, baseURL: h.baseURL }).choose(
        choiceRequest,
        control,
      ),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    expect(fetchCall).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    fetchCall.mockRestore();
  }
});

test('isolates concurrent responses and rejects cancellation during response reporting', async () => {
  let started!: () => void;
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finishFirst = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const h = await httpFixture(async (_request, response) => {
    const current = ++calls;
    response.writeHead(200, {
      'content-type': 'application/json',
      'cf-ai-req-id': `response-${current}`,
    });
    response.flushHeaders();
    if (current === 1) {
      started();
      await finishFirst;
      response.end('{invalid');
    } else response.end(JSON.stringify(responseBody()));
  });
  const model = createCloudflareModel({ ...options, baseURL: h.baseURL });
  const firstReport = vi.fn();
  const secondReport = vi.fn();
  const first = model.choose(choiceRequest, {
    ...callControl(),
    reportModelResponse: firstReport,
  });
  const rejection = expect(first).rejects.toMatchObject({
    code: 'invalid_response',
  });
  await firstStarted;
  await expect(
    model.choose(choiceRequest, {
      ...callControl(),
      reportModelResponse: secondReport,
    }),
  ).resolves.toMatchObject({ optionId: 'a' });
  release();
  await rejection;
  expect(firstReport).toHaveBeenCalledExactlyOnceWith({
    model: null,
    requestId: 'response-1',
    usage: null,
  });
  expect(secondReport).toHaveBeenCalledExactlyOnceWith({
    model: 'actual-clef',
    requestId: 'response-2',
    usage: { inputTokens: 17, outputTokens: 0, totalTokens: 17 },
  });
  const controller = new AbortController();
  await expect(
    model.choose(choiceRequest, {
      ...callControl(),
      signal: controller.signal,
      reportModelResponse() {
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.requests).toHaveLength(3);
});
