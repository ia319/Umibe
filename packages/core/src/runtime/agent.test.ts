import { afterEach, expect, test, vi } from 'vitest';
import { createAgent } from '#internal/runtime/agent';
import {
  applicationEvent,
  proposalBasis,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test('completes an already satisfied root without planning or executing', async () => {
  const h = runnerFixture(2);
  const agent = h.create();
  const run = await agent.start(h.input);
  await expect(run.result).resolves.toMatchObject({
    runId: 'run',
    status: 'succeeded',
  });
  expect(h.plan).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  expect((await agent.inspect('run'))?.summary.status).toBe('succeeded');
  await agent.close();
  expect(await h.store.readRun('run')).not.toBeNull();
});

test.each(['paused', 'cancelled'] as const)(
  'rejects close without closing any run while a %s run has pending writes',
  async (status) => {
    const h = runnerFixture();
    h.plan.mockImplementation((request) =>
      Promise.resolve({
        ...proposalBasis(request),
        outcome: 'blocked',
        reason: 'needs_input',
      }),
    );
    let initializingRunId = 'run';
    const dispose = vi.fn();
    const agent = createAgent({
      ...h.options,
      environment: {
        async observe(context, control) {
          return {
            ...(await h.observe(context, control)),
            runId: context?.graph.runId ?? initializingRunId,
          };
        },
        subscribe: () => dispose,
      },
    });
    const first = await agent.start(h.input);
    await first.result;
    initializingRunId = 'other';
    const second = await agent.start({ ...h.input, runId: 'other' });
    await second.result;
    if (status === 'cancelled') await agent.cancel('other', 'user_cancelled');
    expect((await agent.inspect('other'))?.summary.status).toBe(status);

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const commit = h.store.commit.bind(h.store);
    vi.spyOn(h.store, 'commit').mockImplementation(async (input) => {
      if (
        input.runId === 'other' &&
        input.records.some((record) => record.kind === 'applicationEvent')
      ) {
        entered();
        await gate;
      }
      return commit(input);
    });
    const pending = agent.emit(
      applicationEvent({ runId: 'other', impact: 'observation' }),
    );
    await started;
    try {
      await expect(agent.close()).rejects.toThrowError(
        expect.objectContaining({ reason: 'agent_active' }),
      );
      expect(dispose).not.toHaveBeenCalled();
      const records = vi.fn();
      agent.subscribe(first.runId, records);
      await agent.emit(applicationEvent({ impact: 'observation' }));
      expect(records).toHaveBeenCalled();
    } finally {
      release();
      await pending;
      await agent.close();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => agent.subscribe(first.runId, vi.fn())).toThrowError(
      expect.objectContaining({ reason: 'agent_closed' }),
    );
  },
);

test('runs multiple fixed calls through the public API while retaining the accepted plan', async () => {
  const h = runnerFixture();
  const agent = h.create();
  const run = await agent.start(h.input);
  const records = vi.fn();
  agent.subscribe(run.runId, records);
  await expect(run.result).resolves.toMatchObject({
    status: 'succeeded',
    execution: { result: { outcome: 'succeeded' } },
  });
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect(h.plan).toHaveBeenCalledTimes(1);
  expect(h.select).toHaveBeenCalledTimes(2);
  expect(h.verify).toHaveBeenCalledTimes(3);
  expect(h.generate.mock.calls[0]![0].context.applicationContext).toEqual({
    source: 'integration_fixture',
  });
  const history = await agent.records('run', null, 1000);
  expect(
    history.records.filter((record) => record.kind === 'actionIntent'),
  ).toHaveLength(2);
  expect(
    history.records.filter((record) => record.kind === 'goalAssessment'),
  ).toHaveLength(3);
  expect(records).toHaveBeenCalled();
  await agent.close();
});

test('rejects a planner completion claim when the verifier still reports notYet', async () => {
  const h = runnerFixture();
  h.plan.mockImplementation((request) =>
    Promise.resolve({
      requestId: request.requestId,
      decisionEpoch: request.decisionEpoch,
      rootGoalRef: request.context.graph.rootGoalRef,
      currentGoalRef: request.context.graph.currentGoalRef,
      planRef: request.context.planRef,
      observationRef: {
        id: request.context.observation.id,
        revision: request.context.observation.revision,
      },
      outcome: 'claimComplete',
      goalRef: request.context.graph.rootGoalRef,
    }),
  );
  const run = await h.create().start(h.input);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'completion_not_verified' },
  });
  expect(h.execute).not.toHaveBeenCalled();
});

test('returns the handle while planning is pending and cancels without awaiting that callback', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementation(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.plan).toHaveBeenCalledTimes(1);
  await expect(agent.close()).rejects.toThrow();
  await agent.cancel(run.runId, 'user_cancelled');
  await expect(run.result).resolves.toMatchObject({
    status: 'cancelled',
    stopCause: { reasonCode: 'user_cancelled' },
  });
  expect(h.execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await agent.close();
});

test('pauses on verification callback failure and resumes with a new result promise', async () => {
  const h = runnerFixture(2);
  h.verify.mockRejectedValueOnce(new Error('service unavailable'));
  const agent = h.create();
  const first = await agent.start(h.input);
  await expect(first.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'verification_failed' },
  });
  const second = await agent.resume(first.runId);
  expect(second.result).not.toBe(first.result);
  await expect(second.result).resolves.toMatchObject({ status: 'succeeded' });
  await agent.close();
});

test('releases the run claim when the initial running checkpoint fails', async () => {
  const h = runnerFixture();
  const commit = h.store.commit.bind(h.store);
  vi.spyOn(h.store, 'commit').mockImplementation((input) =>
    input.status === 'running'
      ? Promise.reject(new Error('start write failed'))
      : commit(input),
  );
  const agent = h.create();
  await expect(agent.start(h.input)).rejects.toThrow('start write failed');
  const lease = await h.store.acquireRun(h.input.runId);
  await lease.release();
  await agent.close();
});

test('charges only explicitly model-backed adapter stages', async () => {
  const h = runnerFixture(0, 1);
  const agent = createAgent({
    ...h.options,
    modelStages: ['planning', 'selection'],
  });
  const run = await agent.start(h.input);
  await run.result;
  const checkpoint = (await agent.inspect(run.runId))!.checkpoint;
  expect(checkpoint.state.modelAttempts).toBe(2);
  expect(checkpoint.state.actionAttempts).toBe(1);
});

test('rejects concurrent initialization for the same run and malformed initial observations', async () => {
  const h = runnerFixture();
  const agent = h.create();
  const first = agent.start(h.input);
  await expect(agent.start(h.input)).rejects.toMatchObject({
    reason: 'run_owned',
  });
  await (
    await first
  ).result;
  const bad = runnerFixture();
  bad.observe.mockResolvedValue({
    ...(await h.observe(null, {
      signal: new AbortController().signal,
      deadlineAt: new Date().toISOString(),
    })),
    runId: 'other',
  });
  await expect(bad.create().start(bad.input)).rejects.toMatchObject({
    reason: 'cross_run_observation',
  });
});
