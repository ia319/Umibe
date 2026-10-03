import { afterEach, expect, test, vi } from 'vitest';
import type { Environment } from '#internal/contracts/adapters';
import type { PlanProposal } from '#internal/contracts/planning';
import { candidateSet } from '#internal/candidate/__tests__/fixtures';
import { createAgent } from './agent.js';
import {
  applicationEvent,
  proposalBasis,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test('deduplicates event IDs and rejects conflicting content without another control', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementation(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const event = applicationEvent({ impact: 'observation' });
  await Promise.all([agent.emit(event), agent.emit(event)]);
  await expect(
    agent.emit({ ...event, control: 'cancelRun' }),
  ).rejects.toMatchObject({ reason: 'event_conflict' });
  expect((await agent.inspect('run'))?.summary.status).toBe('running');
  expect(
    (await agent.records('run', null, 1000)).records.filter(
      (record) => record.kind === 'applicationEvent',
    ),
  ).toHaveLength(1);
  expect(h.plan).toHaveBeenCalledTimes(1);
  await agent.cancel('run', 'test_done');
  await run.result;
});

test('coalesces candidate bursts and discards the old in-flight selection', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 1);
  h.select.mockImplementationOnce(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const oldSignal = h.select.mock.calls[0]![1].signal;
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      agent.emit(applicationEvent({ eventId: `event-${index}` })),
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(oldSignal.aborted).toBe(true);
  expect(h.select).toHaveBeenCalledTimes(2);
  expect(h.plan).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

test('ignores stale execution controls and replans only after an active action settles', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 2);
  const execute = h.execute.getMockImplementation()!;
  let release!: () => void;
  h.execute.mockImplementationOnce(async (params, context) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return execute(params, context);
  });
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const signal = h.execute.mock.calls[0]![1].signal;
  await agent.emit(
    applicationEvent({
      eventId: 'stale',
      executionId: 'old-execution',
      control: 'cancelRun',
    }),
  );
  await agent.emit(
    applicationEvent({ impact: 'plan', timing: 'actionBoundary' }),
  );
  expect(signal.aborted).toBe(false);
  expect(h.plan).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.plan).toHaveBeenCalledTimes(2);
});

test.each(['pausing', 'paused'] as const)(
  'replans before dispatch after a plan invalidation arrives while %s',
  async (status) => {
    vi.useFakeTimers();
    const h = runnerFixture(0, 1);
    h.select.mockImplementationOnce(() => new Promise(() => undefined));
    const agent = h.create();
    const first = await agent.start(h.input);
    await vi.advanceTimersByTimeAsync(0);
    const previousPlan = h.select.mock.calls[0]![0].context.planRef!;
    const event = applicationEvent({ impact: 'plan' });
    const paused = agent.pause('run', 'operator_pause');
    const emitted = status === 'pausing' ? agent.emit(event) : null;
    await paused;
    await first.result;
    if (emitted === null) await agent.emit(event);
    else await emitted;
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
    h.plan.mockImplementation((request) =>
      Promise.resolve({
        ...proposalBasis(request),
        outcome: 'continue',
        nextGoalRef: request.context.graph.currentGoalRef,
        guidance: 'Use the updated route',
      }),
    );

    const resumed = await agent.resume('run');
    await vi.advanceTimersByTimeAsync(0);
    await expect(resumed.result).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(h.plan).toHaveBeenCalledTimes(2);
    expect(h.plan.mock.calls[1]![0].trigger).toEqual({
      kind: 'planInvalidated',
      eventId: event.eventId,
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![1].decision).toMatchObject({
      planRef: { id: previousPlan.id, version: previousPlan.version + 1 },
      planGuidance: 'Use the updated route',
    });
    await agent.close();
  },
);

test('bounds abstention recovery when refreshed candidate IDs and observation revisions change', async () => {
  const h = runnerFixture();
  h.select.mockImplementation((request) =>
    Promise.resolve({
      outcome: 'abstain',
      decisionId: request.requestId,
      candidateSetId: request.candidates.id,
      reason: 'no_preference',
    }),
  );
  const run = await h.create().start(h.input);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'decision_basis_unchanged' },
  });
  expect(h.select).toHaveBeenCalledTimes(1);
  expect(h.generate).toHaveBeenCalledTimes(2);
  expect(h.plan).toHaveBeenCalledTimes(2);
  expect(h.execute).not.toHaveBeenCalled();
});

test('bounds an empty candidate source without invoking the selector', async () => {
  const h = runnerFixture();
  h.generate.mockImplementation((request) =>
    Promise.resolve(candidateSet(request, [])),
  );
  const run = await h.create().start(h.input);
  await expect(run.result).resolves.toMatchObject({ status: 'paused' });
  expect(h.generate).toHaveBeenCalledTimes(2);
  expect(h.select).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
});

test('discards a late blocked proposal after a plan invalidation event', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 1);
  let respond!: (proposal: PlanProposal) => void;
  h.plan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const old = h.plan.mock.calls[0]![0];
  await agent.emit(applicationEvent({ impact: 'plan' }));
  respond({
    requestId: old.requestId,
    decisionEpoch: old.decisionEpoch,
    rootGoalRef: old.context.graph.rootGoalRef,
    currentGoalRef: old.context.graph.currentGoalRef,
    planRef: old.context.planRef,
    observationRef: {
      id: old.context.observation.id,
      revision: old.context.observation.revision,
    },
    outcome: 'blocked',
    reason: 'old_failure',
  });
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.plan).toHaveBeenCalledTimes(2);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

test('automatically receives environment events and releases the subscription on close', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  let emit!: Parameters<NonNullable<Environment['subscribe']>>[0];
  const dispose = vi.fn();
  const diagnostics = vi.fn();
  h.plan.mockImplementation(() => new Promise(() => undefined));
  const agent = createAgent({
    ...h.options,
    onDiagnostic: diagnostics,
    environment: {
      observe: h.observe,
      subscribe(callback) {
        emit = callback;
        return dispose;
      },
    },
  });
  const run = await agent.start(h.input);
  emit(applicationEvent({ control: 'cancelRun' }));
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({ status: 'cancelled' });
  emit(applicationEvent({ control: 'pauseRun' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({ code: 'environment_event_failed' }),
  );
  await agent.close();
  expect(dispose).toHaveBeenCalledTimes(1);
});
