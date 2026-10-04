import { afterEach, expect, test, vi } from 'vitest';
import type { CallControl } from '#internal/contracts/control';
import type { ModelResponseMetadata } from '#internal/model/metadata';
import {
  callControl,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import { captureControl, invokeControlled } from '#internal/candidate/control';
import { MemoryRunStore } from '#internal/storage/memory';
import { RunSession } from './session.js';
import { invokeModel, ModelRequestError } from './model.js';

const basis = {
  requestId: 'model',
  decisionEpoch: 3,
  purpose: 'planning',
  model: { provider: 'fixture', model: 'configured' },
} as const;
const metadata = {
  model: 'actual',
  requestId: 'response',
  usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
};
afterEach(() => vi.useRealTimers());

async function closeSession(session: RunSession): Promise<void> {
  await session.transition({
    kind: 'cancel',
    cause: { eventId: 'cleanup', reasonCode: 'test_finished' },
  });
  await session.transition({ kind: 'stopSettled', blocker: null });
  await session.close();
}

test.each([
  'returned',
  'refused',
  'output_truncated',
  'invalid_response',
] as const)(
  'retains a copied response and usage when role processing ends with %s',
  async (outcome) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn(), {
      modelRetries: 0,
    });
    await session.transition({ kind: 'start' });
    const report = { ...metadata, usage: { ...metadata.usage } };
    let late!: NonNullable<CallControl['reportModelResponse']>;
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      async (control) => {
        const nested = await invokeControlled(
          captureControl(control),
          (nestedControl) => {
            late = nestedControl.reportModelResponse!;
            late(report);
            report.model = 'mutated';
            report.usage.inputTokens = 999;
            late({ model: 'duplicate', requestId: null, usage: null });
            if (outcome !== 'returned') throw new ModelRequestError(outcome);
            return Promise.resolve({ value: 'decoded', usage: null });
          },
        );
        if (nested.outcome === 'failed') throw nested.error;
        if (nested.outcome !== 'returned')
          throw new Error('unexpected interruption');
        return nested.value;
      },
    );
    expect(result).toMatchObject(
      outcome === 'returned'
        ? { outcome, value: 'decoded', usage: metadata.usage }
        : { outcome: 'failed', reasonCode: outcome },
    );
    const before = (await store.readRecords('run', null, 100)).records;
    expect(before.at(-1)).toMatchObject({
      data: {
        type: 'model_finished',
        reasonCode: outcome,
        details: {
          model: basis.model,
          response: metadata,
          usage: metadata.usage,
        },
      },
    });
    late({ model: 'late', requestId: null, usage: null });
    expect((await store.readRecords('run', null, 100)).records).toEqual(before);
    await closeSession(session);
  },
);

test('gives every retry a separate channel and leaves an unreported response unknown', async () => {
  vi.useFakeTimers();
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  let first!: NonNullable<CallControl['reportModelResponse']>;
  const pending = invokeModel(
    session,
    basis,
    callControl(),
    (control, attempt) => {
      if (attempt === 1) {
        first = control.reportModelResponse!;
        first(metadata);
        return Promise.reject(new ModelRequestError('unavailable'));
      }
      first({
        model: 'old-retry',
        requestId: null,
        usage: { inputTokens: 99, outputTokens: 0, totalTokens: 99 },
      });
      return Promise.resolve({ value: 'ok', usage: null });
    },
  );
  await vi.advanceTimersByTimeAsync(250);
  await expect(pending).resolves.toEqual({
    outcome: 'returned',
    value: 'ok',
    usage: null,
  });
  const finished = (await store.readRecords('run', null, 100)).records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'model_finished',
  );
  expect(finished).toMatchObject([
    {
      data: {
        details: { attempt: 1, response: metadata, usage: metadata.usage },
      },
    },
    { data: { details: { attempt: 2, response: null, usage: null } } },
  ]);
  await closeSession(session);
});

test.each(['cancelled', 'invalidated', 'deadlineExceeded'] as const)(
  'ignores reports after an attempt becomes %s',
  async (outcome) => {
    vi.useFakeTimers();
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn(), {
      modelTimeoutMs: 10,
      modelRetries: 0,
    });
    await session.transition({ kind: 'start' });
    let report!: NonNullable<CallControl['reportModelResponse']>;
    const pending = invokeModel(session, basis, callControl(), (control) => {
      report = control.reportModelResponse!;
      return new Promise<never>(() => {});
    });
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === 'cancelled')
      await session.transition({
        kind: 'cancel',
        cause: { eventId: 'stop', reasonCode: 'user_stop' },
      });
    if (outcome === 'invalidated')
      await session.replaceDecision({ ...generationInput(), decisionEpoch: 4 });
    report(metadata);
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    // A report before the timeout is valid; cancellation and epoch change close it immediately.
    const expected = outcome === 'deadlineExceeded' ? metadata : null;
    const before = (await store.readRecords('run', null, 100)).records;
    expect(before.at(-1)).toMatchObject({
      data: { details: { response: expected } },
    });
    report({ model: 'late', requestId: null, usage: null });
    expect((await store.readRecords('run', null, 100)).records).toEqual(before);
    await closeSession(session);
  },
);

test('isolates metadata from concurrent runs using the same model identity', async () => {
  const stores = [new MemoryRunStore(), new MemoryRunStore()];
  const sessions = await Promise.all(
    stores.map((store) => RunSession.create(store, generationInput(), vi.fn())),
  );
  await Promise.all(
    sessions.map((session) => session.transition({ kind: 'start' })),
  );
  const results = await Promise.all(
    sessions.map((session, index) =>
      invokeModel(session, basis, callControl(), (control) => {
        control.reportModelResponse!({
          ...metadata,
          requestId: `response-${index}`,
        });
        return Promise.resolve({ value: index, usage: null });
      }),
    ),
  );
  expect(results.map((result) => result.outcome)).toEqual([
    'returned',
    'returned',
  ]);
  for (const [index, store] of stores.entries()) {
    expect(
      (await store.readRecords('run', null, 100)).records.at(-1),
    ).toMatchObject({
      data: { details: { response: { requestId: `response-${index}` } } },
    });
  }
  await Promise.all(sessions.map(closeSession));
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid token count %s without persisting raw metadata',
  async (tokens) => {
    const store = new MemoryRunStore();
    const session = await RunSession.create(store, generationInput(), vi.fn());
    await session.transition({ kind: 'start' });
    const result = await invokeModel(
      session,
      basis,
      callControl(),
      (control) => {
        control.reportModelResponse!({
          ...metadata,
          usage: { ...metadata.usage, inputTokens: tokens },
        });
        return Promise.resolve({ value: 'unreachable', usage: null });
      },
    );
    expect(result).toEqual({
      outcome: 'failed',
      reasonCode: 'invalid_response',
    });
    expect(
      (await store.readRecords('run', null, 100)).records.at(-1),
    ).toMatchObject({ data: { details: { response: null, usage: null } } });
    await closeSession(session);
  },
);

test('rejects unapproved response fields and preserves explicitly unknown token counts', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  const report = {
    ...metadata,
    headers: { authorization: 'must-not-persist' },
  };
  await expect(
    invokeModel(session, basis, callControl(), (control) => {
      control.reportModelResponse!(report);
      return Promise.resolve({ value: 1, usage: null });
    }),
  ).resolves.toEqual({ outcome: 'failed', reasonCode: 'invalid_response' });
  const unknown: ModelResponseMetadata = {
    model: null,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  };
  await invokeModel(
    session,
    { ...basis, requestId: 'unknown' },
    callControl(),
    (control) => {
      control.reportModelResponse!(unknown);
      return Promise.resolve({ value: 1, usage: null });
    },
  );
  const records = (await store.readRecords('run', null, 100)).records;
  expect(records.at(-1)).toMatchObject({
    data: { details: { response: unknown, usage: unknown.usage } },
  });
  expect(JSON.stringify(records)).not.toContain('must-not-persist');
  await closeSession(session);
});
