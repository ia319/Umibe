import { afterEach, expect, test, vi } from 'vitest';
import { createAgent } from '#internal/index';
import { isJsonObject } from '#internal/validation/json';
import {
  applicationEvent,
  proposalBasis,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test.each(['cancel', 'invalidate'] as const)(
  'blocks dispatch when %s arrives during the intent commit',
  async (mode) => {
    vi.useFakeTimers();
    const h = runnerFixture(0, 1);
    const commit = h.store.commit.bind(h.store);
    let release!: () => void;
    let held = false;
    vi.spyOn(h.store, 'commit').mockImplementation(async (input) => {
      if (
        !held &&
        input.records.some((record) => record.kind === 'actionIntent')
      ) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return commit(input);
    });
    const agent = h.create();
    const run = await agent.start(h.input);
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    if (mode === 'invalidate') {
      const observe = h.observe.getMockImplementation()!;
      h.observe.mockImplementation(async (...args) => {
        const observation = await observe(...args);
        return {
          ...observation,
          data: {
            ...observation.data,
            route: { status: 'known', value: 'reopened' },
          },
        };
      });
    }
    const controlled =
      mode === 'cancel'
        ? agent.cancel('run', 'cancel_before_dispatch')
        : agent.emit(applicationEvent({ impact: 'plan' }));
    release();
    await controlled;
    await vi.advanceTimersByTimeAsync(0);
    await expect(run.result).resolves.toMatchObject({
      status: mode === 'cancel' ? 'cancelled' : 'succeeded',
    });
    expect(h.execute).toHaveBeenCalledTimes(mode === 'cancel' ? 0 : 1);
    expect((await agent.inspect('run'))!.checkpoint.state.actionAttempts).toBe(
      mode === 'cancel' ? 0 : 1,
    );
    const records = (await agent.records('run', null, 1000)).records;
    const firstIntent = records.find(
      (record) => record.kind === 'actionIntent',
    );
    const firstResult = records.find(
      (record) => record.kind === 'actionResult',
    );
    expect(firstResult?.data).toMatchObject({
      executionId:
        firstIntent?.kind === 'actionIntent'
          ? firstIntent.data.executionId
          : '',
      outcome: 'cancelled',
      underlyingSettled: true,
      confirmedEffects: {},
    });
  },
);

test('exposes complete request and timing records when the result settles', async () => {
  const h = runnerFixture(0, 1);
  const agent = createAgent({
    ...h.options,
    modelStages: ['planning', 'selection'],
  });
  const handle = await agent.start(h.input);
  await handle.result;
  const records = (await agent.records('run', null, 1000)).records;
  const started = records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'callback_started',
  );
  const finished = records.filter(
    (record) =>
      record.kind === 'coreEvent' && record.data.type === 'callback_finished',
  );
  expect(finished).toHaveLength(started.length);
  for (const record of finished) {
    if (record.kind !== 'coreEvent') throw new Error('fixture');
    expect(record.data.details.durationMs).toBeGreaterThanOrEqual(0);
    const delay = record.data.details.eventLoopDelay;
    if (!isJsonObject(delay)) throw new Error('Missing event loop timing');
    expect(delay.samples).toBeTypeOf('number');
    if (delay.samples === 0)
      expect([delay.meanMs, delay.maxMs]).toEqual([null, null]);
  }
  const planned = started.find(
    (record) =>
      record.kind === 'coreEvent' && record.data.reasonCode === 'planning',
  );
  expect(
    planned?.kind === 'coreEvent' && planned.data.details.input,
  ).toMatchObject({
    context: {
      graph: { rootGoalRef: { id: 'root', version: 1 } },
      effectiveConstraints: {},
    },
    trigger: { kind: 'initial' },
  });
  expect(
    records.some(
      (record) =>
        record.kind === 'coreEvent' &&
        record.data.type === 'observation_accepted' &&
        typeof record.data.details.observationLagMs === 'number',
    ),
  ).toBe(true);
  for (const record of records)
    if (record.kind === 'coreEvent' && record.data.type === 'model_finished') {
      expect(record.data.details.usage).toBeNull();
      expect(record.data.details.durationMs).toBeTypeOf('number');
    }
  await agent.close();
});

test('finishes callback diagnostics before exposing a budget pause result', async () => {
  const h = runnerFixture();
  const agent = createAgent({
    ...h.options,
    modelStages: ['planning'],
    limits: { maxModelAttempts: 0 },
  });
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'model_budget_exhausted' },
  });
  const records = (await agent.records('run', null, 1000)).records;
  expect(
    records.some(
      (record) =>
        record.kind === 'coreEvent' &&
        record.data.type === 'callback_finished' &&
        record.data.reasonCode === 'planning' &&
        record.data.details.currentAtReceipt === false,
    ),
  ).toBe(true);
  await agent.close();
});

test('freezes nested runtime policy and pending goal data exposed to planners', async () => {
  const h = runnerFixture(0, 1);
  const plan = h.plan.getMockImplementation()!;
  h.plan.mockImplementation((request, control) => {
    expect(
      Reflect.set(
        request.context.runtime!.progress[0]!.goalRef,
        'id',
        'tampered',
      ),
    ).toBe(false);
    expect(Object.isFrozen(request.pendingGoals)).toBe(true);
    return plan(request, control);
  });
  await expect((await h.create().start(h.input)).result).resolves.toMatchObject(
    { status: 'succeeded', rootGoalRef: { id: 'root' } },
  );
});

test('returns the same rejected control receipt for duplicate events after completion', async () => {
  const h = runnerFixture(2);
  const agent = h.create();
  await (
    await agent.start(h.input)
  ).result;
  const event = applicationEvent({ control: 'pauseRun' });
  const rejected: unknown = await agent
    .emit(event)
    .catch((error: unknown) => error);
  expect(rejected).toMatchObject({ code: 'INVALID_RUN_CONTROL' });
  await expect(agent.emit(event)).rejects.toBe(rejected);
  expect(
    (await agent.records('run', null, 1000)).records.filter(
      (record) => record.kind === 'applicationEvent',
    ),
  ).toHaveLength(1);
  await agent.close();
});

test('closes root and child scopes when cancellation commits', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      nextTempId: 'child',
      guidance: 'Collect',
      goals: [
        {
          tempId: 'child',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.rootGoalRef,
          },
          description: 'Child',
          criteria: { count: 1 },
        },
      ],
    }),
  );
  h.select.mockImplementation(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  await agent.cancel('run', 'cancel_branch');
  await expect(run.result).resolves.toMatchObject({ status: 'cancelled' });
  expect((await agent.inspect('run'))?.checkpoint.state).toMatchObject({
    progress: [],
    goals: { order: [] },
    decision: {
      context: {
        graph: {
          goals: [{ lifecycle: 'cancelled' }, { lifecycle: 'cancelled' }],
        },
      },
    },
  });
  expect(h.execute).not.toHaveBeenCalled();
  await agent.close();
});
