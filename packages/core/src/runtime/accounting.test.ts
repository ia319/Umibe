import { afterEach, expect, test, vi } from 'vitest';
import { generationInput } from '#internal/candidate/__tests__/fixtures';
import { MemoryRunStore } from '#internal/storage/memory';
import type { RunCommit } from '#internal/storage/contracts';
import { RunSession } from './session.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';
import { invokeModel } from './model.js';
import { createAgent } from './agent.js';
import {
  applicationEvent,
  runnerFixture,
  proposalBasis,
} from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test('records interrupted model attempts once without refunding unknown dispatches', async () => {
  const store = new MemoryRunStore();
  const identity = {
    applicationId: null,
    actionVersions: [],
    modelStages: ['planning'] as const,
  };
  let session = await RunSession.create(
    store,
    generationInput(),
    vi.fn(),
    { maxModelAttempts: 2 },
    identity,
  );
  await session.commit(
    {
      ...session.state,
      modelAttempts: 2,
      pendingModels: [
        {
          requestId: 'reserved',
          decisionEpoch: 3,
          purpose: 'planning',
          attempt: 1,
          phase: 'reserved',
        },
        {
          requestId: 'sent',
          decisionEpoch: 3,
          purpose: 'planning',
          attempt: 1,
          phase: 'dispatched',
        },
      ],
    },
    [],
  );
  await session.close();
  for (let restart = 0; restart < 3; restart++) {
    session = await RunSession.restore(store, 'run', vi.fn(), identity);
    expect(session.state.modelAttempts).toBe(2);
    expect(session.state.pendingModels).toEqual([]);
    await session.transition({ kind: 'resume' });
    const invoke = vi.fn();
    await expect(
      invokeModel(
        session,
        { requestId: `new-${restart}`, decisionEpoch: 3, purpose: 'planning' },
        {
          signal: session.signal,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        },
        invoke,
      ),
    ).resolves.toEqual({ outcome: 'budgetExceeded' });
    expect(invoke).not.toHaveBeenCalled();
    await session.close();
  }
  const records = (await store.readRecords('run', null, 1000)).records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'model_interrupted',
  );
  expect(records).toHaveLength(2);
  expect(records).toMatchObject([
    {
      data: {
        details: { requestId: 'reserved', phase: 'reserved', usage: null },
      },
    },
    {
      data: {
        details: { requestId: 'sent', phase: 'dispatched', usage: null },
      },
    },
  ]);
});

test('deduplicates an old pause across instances after it leaves recent event context', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementation(() => new Promise(() => undefined));
  const first = h.create();
  const run = await first.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const event = applicationEvent({ eventId: 'old-pause', control: 'pauseRun' });
  await first.emit(event);
  await run.result;
  for (let i = 0; i < 55; i++)
    await first.emit(
      applicationEvent({ eventId: `observation-${i}`, impact: 'observation' }),
    );
  await first.close();
  const second = h.create();
  const resumed = await second.resume('run');
  await vi.advanceTimersByTimeAsync(0);
  const before = await second.inspect('run');
  expect(before?.summary.status).toBe('running');
  await expect(
    second.emit({ ...event, control: 'cancelRun' }),
  ).rejects.toMatchObject({ reason: 'event_conflict' });
  await Promise.all([second.emit(event), second.emit(event)]);
  expect(await second.inspect('run')).toEqual(before);
  const all = (await second.records('run', null, 1000)).records;
  expect(all.filter((record) => record.eventId === event.eventId)).toHaveLength(
    1,
  );
  await second.cancel('run', 'test_finished');
  await resumed.result;
  await second.close();
});

test.each(['pauseRun', 'cancelRun'] as const)(
  'commits %s together with its application event and invalidation',
  async (control) => {
    vi.useFakeTimers();
    const h = runnerFixture();
    h.plan.mockImplementation(() => new Promise(() => undefined));
    const agent = h.create();
    const run = await agent.start(h.input);
    await vi.advanceTimersByTimeAsync(0);
    const commit = h.store.commit.bind(h.store);
    let admitted: RunCommit | undefined;
    vi.spyOn(h.store, 'commit').mockImplementation((input) => {
      if (input.records.some((record) => record.kind === 'applicationEvent'))
        admitted = input;
      return commit(input);
    });
    const event = applicationEvent({ control, impact: 'plan' });
    await agent.emit(event);
    await run.result;
    expect(admitted).toMatchObject({
      status: control === 'pauseRun' ? 'pausing' : 'cancelling',
      state: {
        control: { stopCause: { eventId: event.eventId } },
        scheduling: {
          planning: { kind: 'planInvalidated', eventId: event.eventId },
        },
      },
    });
    expect(
      admitted?.records.find((record) => record.kind === 'applicationEvent'),
    ).toMatchObject({ eventId: event.eventId });
    expect(
      admitted?.records.find(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'run_transition',
      ),
    ).toBeDefined();
    await agent.close();
  },
);

test('preserves cancellation after its atomic commit loses the acknowledgement', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementation(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const commit = h.store.commit.bind(h.store);
  const writer = vi
    .spyOn(h.store, 'commit')
    .mockImplementation(async (input) => {
      const committed = await commit(input);
      if (input.records.some((record) => record.kind === 'applicationEvent'))
        throw new Error('acknowledgement lost');
      return committed;
    });
  const failed = expect(run.result).rejects.toMatchObject({
    reason: 'store_failed',
  });
  const event = applicationEvent({ control: 'cancelRun' });
  await expect(agent.emit(event)).rejects.toThrow('acknowledgement lost');
  await failed;
  await vi.advanceTimersByTimeAsync(0);
  await agent.close();
  writer.mockRestore();
  const recovered = h.create();
  await expect(recovered.resume('run')).rejects.toMatchObject({
    reason: 'resume_unavailable',
  });
  const before = await recovered.inspect('run');
  expect(before?.summary.status).toBe('cancelled');
  await recovered.emit(event);
  expect(await recovered.inspect('run')).toEqual(before);
  expect(h.execute).not.toHaveBeenCalled();
  await recovered.close();
});

test('rejects close while an event is waiting for persisted deduplication', async () => {
  const h = runnerFixture();
  h.plan.mockImplementation((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'blocked',
      reason: 'wait',
    }),
  );
  const agent = h.create();
  await (
    await agent.start(h.input)
  ).result;
  const read = h.store.readRecord.bind(h.store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(h.store, 'readRecord').mockImplementation(async (...args) => {
    await gate;
    return read(...args);
  });
  const pending = agent.emit(applicationEvent());
  await expect(agent.close()).rejects.toMatchObject({ reason: 'agent_active' });
  release();
  await pending;
  await agent.close();
});

test('commits a resume update together with the running control state', async () => {
  const h = runnerFixture();
  const agent = createAgent({ ...h.options, limits: { maxActionAttempts: 0 } });
  await (
    await agent.start(h.input)
  ).result;
  const commit = h.store.commit.bind(h.store);
  const resumed: RunCommit[] = [];
  vi.spyOn(h.store, 'commit').mockImplementation((input) => {
    if (
      input.records.some(
        (record) =>
          record.kind === 'coreEvent' && record.data.type === 'resume_updated',
      )
    )
      resumed.push(input);
    return commit(input);
  });
  await (
    await agent.resume('run', {
      limits: { maxActionAttempts: 2 },
      context: { resumed: true },
    })
  ).result;
  expect(resumed).toHaveLength(1);
  expect(resumed[0]).toMatchObject({
    status: 'running',
    state: {
      limits: { maxActionAttempts: 2 },
      decision: { context: { applicationContext: { resumed: true } } },
    },
  });
  expect(
    resumed[0]?.records.some(
      (record) =>
        record.kind === 'coreEvent' &&
        record.data.type === 'run_transition' &&
        record.data.reasonCode === 'resume',
    ),
  ).toBe(true);
  await agent.close();
});

test.each([
  ['beforeCommit', 10],
  ['afterCommit', 10],
  ['afterCommit', 1],
] as const)(
  'settles progress once after %s fails with target %s',
  async (boundary, target) => {
    const h = runnerFixture(0, target);
    const agent = createAgent({ ...h.options, limits: { maxNoProgress: 1 } });
    const commit = h.store.commit.bind(h.store);
    let interrupted = false;
    const writer = vi
      .spyOn(h.store, 'commit')
      .mockImplementation(async (input) => {
        const stop =
          !interrupted &&
          input.records.some(
            (record) =>
              record.kind === 'coreEvent' &&
              record.data.type === 'progress_assessed' &&
              record.data.reasonCode === 'action',
          );
        if (stop) interrupted = true;
        if (stop && boundary === 'beforeCommit') throw new Error('interrupted');
        const result = await commit(input);
        if (stop) throw new Error('interrupted');
        return result;
      });
    await expect((await agent.start(h.input)).result).rejects.toMatchObject({
      reason: 'store_failed',
    });
    await agent.close();
    writer.mockRestore();
    const recovered = h.create();
    const result = await (await recovered.resume('run')).result;
    expect(result.status).toBe(target === 1 ? 'succeeded' : 'paused');
    expect(h.execute).toHaveBeenCalledTimes(1);
    const state = parseRuntimeCheckpoint(
      (await recovered.inspect('run'))!.checkpoint,
    ).state;
    expect(state.progressAttempt).toBeNull();
    expect(state.progress[0]?.noProgress).toBe(target === 1 ? 0 : 1);
    const records = (await recovered.records('run', null, 1000)).records.filter(
      (record) =>
        record.kind === 'coreEvent' &&
        record.data.type === 'progress_assessed' &&
        record.data.reasonCode === 'action',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      data: {
        executionId: state.execution?.intent.executionId,
        details: { executionId: state.execution?.intent.executionId },
      },
    });
    await recovered.close();
  },
);
