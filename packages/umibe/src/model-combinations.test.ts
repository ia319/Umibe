import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { expect, test, vi } from 'vitest';
import { createAgent, parseJsonValue } from '@umibe/core';
import type { AgentOptions } from '@umibe/core';
import { isJsonArray, isJsonObject } from '@umibe/core/model';
import { SqliteRunStore } from '@umibe/storage-sqlite';
import { createPlanner, createSelector } from './index.js';
import { createOpenAIModel } from '../../providers/openai/src/index.js';
import { createCloudflareModel } from '../../providers/cloudflare/src/index.js';
import {
  httpFixture,
  responseBody as openaiResponse,
} from '../../providers/openai/src/__tests__/http.js';
import type { HttpRequest } from '../../providers/openai/src/__tests__/http.js';
import { responseBody as choiceResponse } from '../../providers/cloudflare/src/__tests__/http.js';
import {
  applicationEvent,
  runnerFixture,
} from '../../core/src/runtime/__tests__/runner-fixtures.js';
import { generationInput } from '../../core/src/candidate/__tests__/fixtures.js';
import { RunSession } from '../../core/src/runtime/session.js';

type SelectionProvider = 'openai' | 'cloudflare';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function selectionResponse(provider: SelectionProvider, request: HttpRequest) {
  const body = parseJsonValue(request.body, 'http_fixture');
  if (!isJsonObject(body)) throw new Error('Expected model request');
  if (provider === 'cloudflare') {
    if (
      !isJsonObject(body.questions) ||
      !isJsonObject(body.questions.selection) ||
      !isJsonObject(body.questions.selection.criteria)
    )
      throw new Error('Expected choice criteria');
    return choiceResponse(Object.keys(body.questions.selection.criteria));
  }
  if (
    !isJsonArray(body.input) ||
    !isJsonObject(body.input[0]) ||
    typeof body.input[0].content !== 'string'
  )
    throw new Error('Expected SDK input');
  const input = parseJsonValue(
    JSON.parse(body.input[0].content),
    'selection_input',
  );
  if (
    !isJsonObject(input) ||
    !isJsonObject(input.request) ||
    !isJsonObject(input.request.candidates) ||
    !isJsonArray(input.request.candidates.candidates) ||
    !isJsonObject(input.request.candidates.candidates[0])
  )
    throw new Error('Expected fixed candidates');
  return openaiResponse({
    outcome: 'selected',
    candidateId: input.request.candidates.candidates[0].id!,
    reason: null,
  });
}

async function networkRoles(
  provider: SelectionProvider,
  handle?: (
    request: HttpRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
) {
  const planningHttp = await httpFixture((_request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'planner-response',
    });
    response.end(
      JSON.stringify(
        openaiResponse({
          proposal: {
            outcome: 'continue',
            nextGoalRef: { id: 'root', version: 1 },
            guidance: 'Collect one synthetic sample',
            goalOrder: null,
          },
        }),
      ),
    );
  });
  const selectionHttp = await httpFixture(
    handle ??
      ((request, response) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'selector-response',
          'cf-ai-req-id': 'selector-response',
        });
        response.end(JSON.stringify(selectionResponse(provider, request)));
      }),
  );
  const planner = createPlanner({
    model: createOpenAIModel({
      apiKey: 'planning-test-key',
      model: 'planning-model',
      maxOutputTokens: 500,
      baseURL: planningHttp.baseURL,
    }),
    criteriaDescription: 'Check the observed sample count independently.',
  });
  const selectionModel =
    provider === 'cloudflare'
      ? createCloudflareModel({
          accountId: 'fixture-account',
          apiToken: 'selection-test-token',
          model: '@cf/cloudflare/clef',
          baseURL: selectionHttp.baseURL,
        })
      : createOpenAIModel({
          apiKey: 'selection-test-key',
          model: 'selection-model',
          maxOutputTokens: 100,
          baseURL: selectionHttp.baseURL,
        });
  return {
    planningHttp,
    selectionHttp,
    planner,
    selector: createSelector({ model: selectionModel }),
  };
}

test.each(['openai', 'cloudflare'] as const)(
  'runs OpenAI planning and %s selection through separate counted HTTP requests',
  async (provider) => {
    const h = runnerFixture(0, 1);
    const roles = await networkRoles(provider);
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
      modelStages: [],
      limits: { maxModelAttempts: 2 },
    });
    try {
      await expect((await agent.start(h.input)).result).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(roles.planningHttp.requests).toHaveLength(1);
      expect(roles.selectionHttp.requests).toHaveLength(1);
      expect(roles.planningHttp.requests[0]!.headers.authorization).toBe(
        'Bearer planning-test-key',
      );
      expect(roles.selectionHttp.requests[0]!.headers.authorization).toBe(
        provider === 'openai'
          ? 'Bearer selection-test-key'
          : 'Bearer selection-test-token',
      );
      expect((await agent.inspect('run'))!.checkpoint.state).toMatchObject({
        modelAttempts: 2,
        identity: { modelStages: ['planning', 'selection'] },
      });
      expect(h.execute).toHaveBeenCalledExactlyOnceWith(
        { target: 'north', count: 1 },
        expect.anything(),
      );
      const records = (await agent.records('run', null, 1000)).records;
      const finished = records.filter(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'model_finished',
      );
      expect(finished).toMatchObject([
        {
          data: {
            details: {
              purpose: 'planning',
              model: { provider: 'openai', model: 'planning-model' },
              response: { requestId: 'planner-response' },
              usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
            },
          },
        },
        {
          data: {
            details: {
              purpose: 'selection',
              model: {
                provider,
                model:
                  provider === 'openai'
                    ? 'selection-model'
                    : '@cf/cloudflare/clef',
              },
              response: { requestId: 'selector-response' },
              usage: {
                inputTokens: provider === 'openai' ? 7 : 17,
                outputTokens: provider === 'openai' ? 3 : 0,
              },
            },
          },
        },
      ]);
      if (provider === 'cloudflare')
        expect(finished[1]).toMatchObject({
          data: { details: { choice: { confidence: 0.04 } } },
        });
      expect(JSON.stringify(records)).not.toMatch(
        /planning-test-key|selection-test-(key|token)|Bearer|fixture-account/,
      );
    } finally {
      await agent.close();
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'caps %s HTTP retries at both retry count and cumulative budget',
  async (provider) => {
    for (const budget of [3, 4]) {
      const h = runnerFixture();
      const roles = await networkRoles(provider, (_request, response) => {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end('{}');
      });
      const agent = createAgent({
        ...h.options,
        planner: roles.planner,
        selector: roles.selector,
        limits: { maxModelAttempts: budget, modelRetries: 2 },
      });
      try {
        await expect(
          (await agent.start(h.input)).result,
        ).resolves.toMatchObject({
          status: 'paused',
          blocker: {
            reasonCode:
              budget === 3 ? 'model_budget_exhausted' : 'rate_limited',
          },
        });
        expect(roles.planningHttp.requests).toHaveLength(1);
        expect(roles.selectionHttp.requests).toHaveLength(budget - 1);
        expect(
          (await agent.inspect('run'))!.checkpoint.state.modelAttempts,
        ).toBe(budget);
        expect(h.execute).not.toHaveBeenCalled();
        if (provider === 'openai')
          for (const request of roles.selectionHttp.requests)
            expect(request.headers['x-stainless-retry-count']).toBe('0');
      } finally {
        await agent.close();
      }
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'does not fallback or retry after a permanent %s failure',
  async (provider) => {
    const h = runnerFixture();
    const roles = await networkRoles(provider, (_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
    });
    try {
      await expect((await agent.start(h.input)).result).resolves.toMatchObject({
        status: 'paused',
        blocker: { reasonCode: 'unauthorized' },
      });
      expect(roles.planningHttp.requests).toHaveLength(1);
      expect(roles.selectionHttp.requests).toHaveLength(1);
      expect(h.select).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      await agent.close();
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'cancels %s during core backoff without dispatching a retry',
  async (provider) => {
    const h = runnerFixture();
    const roles = await networkRoles(provider, (_request, response) => {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '30',
      });
      response.end('{}');
    });
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
    });
    const run = await agent.start(h.input);
    const retry = deferred();
    const unsubscribe = agent.subscribe('run', (record) => {
      if (
        record.kind === 'coreEvent' &&
        record.data.type === 'model_retry_scheduled'
      )
        retry.resolve();
    });
    try {
      await retry.promise;
      await agent.cancel('run', 'stop_backoff');
      await expect(run.result).resolves.toMatchObject({
        status: 'cancelled',
        stopCause: { reasonCode: 'stop_backoff' },
      });
      expect(roles.selectionHttp.requests).toHaveLength(1);
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await agent.close();
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'honors %s Retry-After beyond the logical deadline',
  async (provider) => {
    const h = runnerFixture();
    const roles = await networkRoles(provider, (_request, response) => {
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '30',
      });
      response.end('{}');
    });
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
      limits: { modelTimeoutMs: 150 },
    });
    try {
      await expect((await agent.start(h.input)).result).resolves.toMatchObject({
        status: 'paused',
        blocker: { reasonCode: 'deadline_exceeded' },
      });
      expect(roles.selectionHttp.requests).toHaveLength(1);
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      await agent.close();
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'discards a late %s choice after decision invalidation',
  async (provider) => {
    const h = runnerFixture(0, 1);
    const first = deferred();
    const release = deferred();
    const lateFinished = deferred();
    let calls = 0;
    const roles = await networkRoles(provider, async (request, response) => {
      const current = ++calls;
      if (current === 1) {
        first.resolve();
        await release.promise;
      }
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': `response-${current}`,
        'cf-ai-req-id': `response-${current}`,
      });
      response.end(JSON.stringify(selectionResponse(provider, request)));
      if (current === 1) lateFinished.resolve();
    });
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
    });
    const run = await agent.start(h.input);
    try {
      await first.promise;
      await agent.emit(applicationEvent({ eventId: 'new-candidate-basis' }));
      await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
      expect(roles.planningHttp.requests).toHaveLength(1);
      expect(roles.selectionHttp.requests).toHaveLength(2);
      expect(h.execute).toHaveBeenCalledTimes(1);
      const before = (await agent.records('run', null, 1000)).records;
      release.resolve();
      await lateFinished.promise;
      expect((await agent.records('run', null, 1000)).records).toEqual(before);
      expect(JSON.stringify(before)).not.toContain('response-1');
      expect((await agent.inspect('run'))!.checkpoint.state.modelAttempts).toBe(
        3,
      );
    } finally {
      release.resolve();
      await agent.close();
    }
  },
);

test.each(['openai', 'cloudflare'] as const)(
  'lets stop win when a %s response becomes ready',
  async (provider) => {
    const h = runnerFixture(0, 1);
    const reached = deferred();
    const release = deferred();
    const roles = await networkRoles(provider, async (request, response) => {
      reached.resolve();
      await release.promise;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(selectionResponse(provider, request)));
    });
    const agent = createAgent({
      ...h.options,
      planner: roles.planner,
      selector: roles.selector,
    });
    const run = await agent.start(h.input);
    try {
      await reached.promise;
      const stopping = agent.cancel('run', 'user_stop');
      release.resolve();
      await stopping;
      await expect(run.result).resolves.toMatchObject({
        status: 'cancelled',
        stopCause: { reasonCode: 'user_stop' },
      });
      expect(h.execute).not.toHaveBeenCalled();
      expect(roles.selectionHttp.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await agent.close();
    }
  },
);

test('restores SQLite role budgets and isolates an old in-flight native response', async () => {
  const h = runnerFixture(0, 1);
  const directory = mkdtempSync(join(tmpdir(), 'umibe-model-restore-'));
  const database = join(directory, 'runs.sqlite');
  const reached = deferred();
  const release = deferred();
  const oldFinished = deferred();
  let calls = 0;
  const roles = await networkRoles('cloudflare', async (request, response) => {
    const current = ++calls;
    if (current === 1) {
      reached.resolve();
      await release.promise;
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'cf-ai-req-id': `restored-${current}`,
    });
    response.end(JSON.stringify(selectionResponse('cloudflare', request)));
    if (current === 1) oldFinished.resolve();
  });
  const shared = {
    ...h.options,
    applicationId: 'model-restore',
    planner: roles.planner,
    selector: roles.selector,
    limits: { maxModelAttempts: 2 },
  } satisfies AgentOptions<{ count: number }>;
  const firstStore = new SqliteRunStore(database);
  const firstAgent = createAgent({ ...shared, store: firstStore });
  const firstRun = await firstAgent.start(h.input);
  await reached.promise;
  await firstAgent.pause('run', 'restart_test');
  await firstRun.result;
  expect(
    (await firstAgent.inspect('run'))!.checkpoint.state.modelAttempts,
  ).toBe(2);
  await firstAgent.close();
  await firstStore.close();
  const secondStore = new SqliteRunStore(database);
  const secondAgent = createAgent({ ...shared, store: secondStore });
  try {
    await expect(
      (await secondAgent.resume('run')).result,
    ).resolves.toMatchObject({
      status: 'paused',
      blocker: { reasonCode: 'model_budget_exhausted' },
    });
    expect(roles.planningHttp.requests).toHaveLength(1);
    expect(roles.selectionHttp.requests).toHaveLength(1);
    await expect(
      (await secondAgent.resume('run', { limits: { maxModelAttempts: 4 } }))
        .result,
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(
      (await secondAgent.inspect('run'))!.checkpoint.state.modelAttempts,
    ).toBe(3);
    expect(roles.planningHttp.requests).toHaveLength(1);
    expect(roles.selectionHttp.requests).toHaveLength(2);
    const before = (await secondAgent.records('run', null, 1000)).records;
    release.resolve();
    await oldFinished.promise;
    expect((await secondAgent.records('run', null, 1000)).records).toEqual(
      before,
    );
    expect(JSON.stringify(before)).not.toMatch(
      /selection-test-token|restored-1/,
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await secondAgent.close();
    await secondStore.close();
  }
});

test('keeps uncompleted SQLite reservations charged on every recovery', async () => {
  const database = join(
    mkdtempSync(join(tmpdir(), 'umibe-model-reservations-')),
    'runs.sqlite',
  );
  const identity = {
    applicationId: 'model-reservations',
    actionVersions: [],
    modelStages: ['selection'] as const,
  };
  const initialStore = new SqliteRunStore(database);
  const initialSession = await RunSession.create(
    initialStore,
    generationInput(),
    vi.fn(),
    { maxModelAttempts: 2 },
    identity,
  );
  await initialSession.commit(
    {
      ...initialSession.state,
      modelAttempts: 2,
      pendingModels: [
        {
          requestId: 'reserved',
          decisionEpoch: 3,
          purpose: 'selection',
          attempt: 1,
          phase: 'reserved',
        },
        {
          requestId: 'dispatched',
          decisionEpoch: 3,
          purpose: 'selection',
          attempt: 1,
          phase: 'dispatched',
        },
      ],
    },
    [],
  );
  await initialSession.close();
  await initialStore.close();
  for (let recovery = 0; recovery < 2; recovery++) {
    const store = new SqliteRunStore(database);
    const session = await RunSession.restore(store, 'run', vi.fn(), identity);
    expect(session.state.modelAttempts).toBe(2);
    expect(session.state.pendingModels).toEqual([]);
    const records = (await store.readRecords('run', null, 1000)).records;
    expect(
      records.filter(
        (record) =>
          record.kind === 'coreEvent' &&
          record.data.type === 'model_interrupted',
      ),
    ).toHaveLength(2);
    await session.close();
    await store.close();
  }
});

test('retains application-owned planner and selector objects without model accounting', async () => {
  const h = runnerFixture(0, 1);
  const agent = h.create();
  try {
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect((await agent.inspect('run'))!.checkpoint.state.modelAttempts).toBe(
      0,
    );
    expect(h.plan).toHaveBeenCalledOnce();
    expect(h.select).toHaveBeenCalledOnce();
  } finally {
    await agent.close();
  }
});
