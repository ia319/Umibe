import { afterEach, expect, test, vi } from 'vitest';
import {
  callControl,
  generationInput,
} from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import { RunSession } from './session.js';
import { invokeModel, ModelRequestError } from './model.js';

const basis = {
  requestId: 'model',
  decisionEpoch: 3,
  purpose: 'planning',
} as const;
afterEach(() => {
  vi.useRealTimers();
});

test('reserves before dispatch and keeps one logical ID across charged transport retries', async () => {
  vi.useFakeTimers();
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  const invoke = vi.fn((_control, attempt: number) => {
    expect(session.checkpoint?.state.modelAttempts).toBe(attempt);
    if (attempt < 3)
      return Promise.reject(new ModelRequestError('unavailable'));
    return Promise.resolve({ value: 'plan', usage: { tokens: 12 } });
  });
  const pending = invokeModel(session, basis, callControl(), invoke);
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(invoke).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500);
  await expect(pending).resolves.toEqual({
    outcome: 'returned',
    value: 'plan',
    usage: { tokens: 12 },
  });
  expect(session.state.modelAttempts).toBe(3);
  const records = (await store.readRecords('run', null, 100)).records;
  const dispatched = records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'model_dispatched',
  );
  expect(
    dispatched.map(
      (record) =>
        record.kind === 'coreEvent' && [
          record.data.requestId,
          record.data.details.attempt,
        ],
    ),
  ).toEqual([
    ['model', 1],
    ['model', 2],
    ['model', 3],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  new ModelRequestError('unauthorized'),
  new ModelRequestError('invalid_response'),
  new Error('retry please'),
])('does not retry non-transient or unclassified errors: %s', async (error) => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  await session.transition({ kind: 'start' });
  const invoke = vi.fn(() => Promise.reject(error));
  await expect(
    invokeModel(session, basis, callControl(), invoke),
  ).resolves.toMatchObject({ outcome: 'failed' });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(session.state.modelAttempts).toBe(1);
});

test('cancellation during reservation prevents sending and refunds only the unsent attempt', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = store.commit.bind(store);
  vi.spyOn(store, 'commit').mockImplementation(async (input) => {
    if (
      input.records.some(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'model_reserved',
      )
    )
      await gate;
    return original(input);
  });
  const invoke = vi.fn(() => Promise.resolve({ value: 1, usage: null }));
  const pending = invokeModel(session, basis, callControl(), invoke);
  const cancel = session.transition({
    kind: 'cancel',
    cause: { eventId: 'cancel', reasonCode: 'user_cancelled' },
  });
  release();
  await cancel;
  await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
  expect(invoke).not.toHaveBeenCalled();
  expect(session.state.modelAttempts).toBe(0);
  expect(session.checkpoint?.state.modelAttempts).toBe(0);
});

test('concurrent reservations cannot exceed the budget and exhaustion pauses the run', async () => {
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
    { maxModelAttempts: 1 },
  );
  await session.transition({ kind: 'start' });
  const invoke = vi.fn(() => Promise.resolve({ value: 1, usage: null }));
  const first = invokeModel(session, basis, callControl(), invoke);
  const second = invokeModel(
    session,
    { ...basis, requestId: 'second' },
    callControl(),
    invoke,
  );
  await expect(second).resolves.toEqual({ outcome: 'budgetExceeded' });
  await first;
  expect(invoke.mock.calls.length).toBeLessThanOrEqual(1);
  expect(session.state.modelAttempts).toBeLessThanOrEqual(1);
  await expect(session.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'model_budget_exhausted' },
  });
});

test('timeouts retain unknown usage and a late answer cannot become the accepted result', async () => {
  vi.useFakeTimers();
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn(), {
    modelTimeoutMs: 10,
    modelRetries: 0,
  });
  await session.transition({ kind: 'start' });
  let resolve!: (value: { value: string; usage: null }) => void;
  const pending = invokeModel<string>(
    session,
    basis,
    callControl(),
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(10);
  await expect(pending).resolves.toEqual({
    outcome: 'failed',
    reasonCode: 'deadline_exceeded',
  });
  resolve({ value: 'late plan', usage: null });
  await Promise.resolve();
  expect(session.state.modelAttempts).toBe(1);
  const records = (await store.readRecords('run', null, 100)).records;
  expect(records.at(-1)).toMatchObject({
    data: { type: 'model_finished', details: { usage: null } },
  });
  expect(vi.getTimerCount()).toBe(0);
});

test('invalidates a returned answer against the live epoch and preserves known usage', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  const pending = invokeModel(session, basis, callControl(), async () => {
    await session.replaceDecision({ ...generationInput(), decisionEpoch: 4 });
    return { value: 'stale plan', usage: { tokens: 3 } };
  });
  await expect(pending).resolves.toEqual({ outcome: 'invalidated' });
  expect(
    (await store.readRecords('run', null, 100)).records.at(-1),
  ).toMatchObject({
    data: { reasonCode: 'invalidated', details: { usage: { tokens: 3 } } },
  });
});

test('cancels during Retry-After without charging another attempt', async () => {
  vi.useFakeTimers();
  const session = await RunSession.create(
    new MemoryRunStore(),
    generationInput(),
    vi.fn(),
  );
  await session.transition({ kind: 'start' });
  const invoke = vi.fn(() =>
    Promise.reject(new ModelRequestError('rate_limited', 10_000)),
  );
  const pending = invokeModel(session, basis, callControl(), invoke);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(invoke).toHaveBeenCalledTimes(1);
  await session.transition({
    kind: 'cancel',
    cause: { eventId: 'cancel', reasonCode: 'user_cancelled' },
  });
  await expect(pending).resolves.toEqual({ outcome: 'cancelled' });
  expect(session.state.modelAttempts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('does not send or retry when reservation cannot be committed', async () => {
  const store = new MemoryRunStore();
  const session = await RunSession.create(store, generationInput(), vi.fn());
  await session.transition({ kind: 'start' });
  vi.spyOn(store, 'commit').mockRejectedValue(new Error('store failed'));
  const invoke = vi.fn(() => Promise.resolve({ value: 'unused', usage: null }));
  await expect(
    invokeModel(session, basis, callControl(), invoke),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  expect(session.canDispatch(3)).toBe(false);
});
