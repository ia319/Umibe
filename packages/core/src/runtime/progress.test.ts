import { afterEach, expect, test, vi } from 'vitest';
import { createAgent } from './agent.js';
import type { GoalAssessment } from '#internal/contracts/goal';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test('does not clear no-progress or failed recovery counts on an arbitrary success or resume', async () => {
  const h = runnerFixture(0, 100);
  const execute = h.execute.getMockImplementation()!;
  let attempts = 0;
  h.execute.mockImplementation(async (...args) => ({
    ...(await execute(...args)),
    outcome: ++attempts % 2 === 0 ? 'succeeded' : 'failed',
  }));
  const agent = h.create();
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect((await agent.inspect('run'))!.checkpoint.state.progress).toMatchObject(
    [{ noProgress: 3, recoveryAttempts: 2 }],
  );
  await expect((await agent.resume('run')).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(3);
});

test.each(['failed', 'deadlineExceeded', 'paused'] as const)(
  'settles each completed attempt after verification is %s and the run resumes',
  async (interruption) => {
    vi.useFakeTimers();
    const h = runnerFixture(0, 100);
    h.execute.mockImplementation((_params, context) =>
      Promise.resolve({
        executionId: context.executionId,
        outcome: 'failed',
        reasonCode: 'no_effect',
        underlyingSettled: true,
        confirmedEffects: {},
        unresolvedEffects: {},
        progress: {},
        stopCauseEventId: null,
      }),
    );
    const verify = h.verify.getMockImplementation()!;
    let interruptedAttempt = 0;
    h.verify.mockImplementation(async (...args) => {
      const attempts = h.execute.mock.calls.length;
      if (attempts > interruptedAttempt) {
        interruptedAttempt = attempts;
        if (interruption === 'failed') throw new Error('verification failed');
        return new Promise(() => undefined);
      }
      return {
        ...(await verify(...args)),
        progress: 0,
        evidence: {
          source: 'application' as const,
          observationPaths: ['/count'],
          executionIds: [],
          details: {},
        },
      };
    });
    const agent = createAgent({
      ...h.options,
      limits: { verificationTimeoutMs: 10 },
    });
    let run = await agent.start(h.input);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.advanceTimersByTimeAsync(
        interruption === 'deadlineExceeded' ? 10 : 0,
      );
      if (interruption === 'paused')
        await agent.pause('run', 'verification_paused');
      await expect(run.result).resolves.toMatchObject({
        status: 'paused',
        blocker: { reasonCode: `verification_${interruption}` },
      });
      expect(h.execute).toHaveBeenCalledTimes(attempt);
      run = await agent.resume('run');
    }
    await vi.advanceTimersByTimeAsync(10);
    await expect(run.result).resolves.toMatchObject({
      status: 'paused',
      blocker: { reasonCode: 'no_progress' },
    });
    expect(h.execute).toHaveBeenCalledTimes(3);
    expect(
      (await agent.inspect('run'))!.checkpoint.state.progress,
    ).toMatchObject([{ noProgress: 3, recoveryAttempts: 3, highWater: 0 }]);
    const resumed = await agent.resume('run');
    await vi.advanceTimersByTimeAsync(0);
    await expect(resumed.result).resolves.toMatchObject({
      status: 'paused',
      blocker: { reasonCode: 'no_progress' },
    });
    expect(h.execute).toHaveBeenCalledTimes(3);
    expect(
      (await agent.inspect('run'))!.checkpoint.state.progress,
    ).toMatchObject([{ noProgress: 3, recoveryAttempts: 3 }]);
    agent.close();
  },
);

test('retains an executed attempt when its observation refresh fails before verification', async () => {
  const h = runnerFixture(0, 10);
  const observe = h.observe.getMockImplementation()!;
  let interrupted = false;
  h.observe.mockImplementation((...args) => {
    if (!interrupted && h.execute.mock.calls.length > 0) {
      interrupted = true;
      return Promise.reject(new Error('observation failed'));
    }
    return observe(...args);
  });
  const agent = createAgent({ ...h.options, limits: { maxNoProgress: 1 } });
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'observation_failed' },
  });
  await expect((await agent.resume('run')).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(1);
  agent.close();
});

test('does not recount an attempt when pause arrives during its progress commit', async () => {
  const h = runnerFixture(0, 10);
  const agent = createAgent({ ...h.options, limits: { maxNoProgress: 2 } });
  const commit = h.store.commit.bind(h.store);
  let paused: Promise<void> | undefined;
  vi.spyOn(h.store, 'commit').mockImplementation((input) => {
    if (
      paused === undefined &&
      input.records.some(
        (record) =>
          record.kind === 'coreEvent' &&
          record.data.type === 'progress_assessed' &&
          record.data.reasonCode === 'action',
      )
    )
      paused = agent.pause('run', 'pause_after_assessment');
    return commit(input);
  });
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'pause_after_assessment' },
  });
  await paused;
  expect(h.execute).toHaveBeenCalledTimes(1);
  await expect((await agent.resume('run')).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(2);
  agent.close();
});

test('starts a fresh progress scope when resume replaces a root awaiting verification', async () => {
  const h = runnerFixture(0, 10);
  const verify = h.verify.getMockImplementation()!;
  h.verify
    .mockImplementationOnce(verify)
    .mockRejectedValueOnce(new Error('verification failed'));
  const agent = createAgent({ ...h.options, limits: { maxNoProgress: 1 } });
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'verification_failed' },
  });
  const resumed = await agent.resume('run', {
    goal: { ...h.input.goal, version: 2 },
    effectiveConstraints: {},
  });
  await expect(resumed.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(2);
  expect((await agent.inspect('run'))!.checkpoint.state.progress).toMatchObject(
    [{ goalRef: { id: 'root', version: 2 }, noProgress: 1 }],
  );
  agent.close();
});

test('keeps the progress high-water mark when actions undo and repeat their effects', async () => {
  const h = runnerFixture(0, 10);
  let count = 0;
  const observe = h.observe.getMockImplementation()!;
  h.observe.mockImplementation(async (...args) => ({
    ...(await observe(...args)),
    data: { count: { status: 'known', value: count } },
  }));
  const execute = h.execute.getMockImplementation()!;
  h.execute.mockImplementation(async (...args) => {
    count = count === 0 ? 1 : 0;
    return execute(...args);
  });
  const verify = h.verify.getMockImplementation()!;
  h.verify.mockImplementation(async (...args): Promise<GoalAssessment> => ({
    ...(await verify(...args)),
    progress: count,
    evidence: {
      source: 'application',
      observationPaths: ['/count'],
      executionIds: [],
      details: {},
    },
  }));
  const agent = h.create();
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(4);
  expect((await agent.inspect('run'))!.checkpoint.state.progress).toMatchObject(
    [{ noProgress: 3, highWater: 1 }],
  );
});

test('counts repeated decomposition without new evidence as no progress', async () => {
  const h = runnerFixture(0, 2);
  h.plan.mockImplementation((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      nextTempId: 'already_done',
      guidance: 'One more refinement',
      goals: [
        {
          tempId: 'already_done',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.rootGoalRef,
          },
          description: 'Already satisfied',
          criteria: { count: 0 },
        },
      ],
    }),
  );
  const agent = h.create();
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.plan).toHaveBeenCalledTimes(3);
  expect(h.execute).not.toHaveBeenCalled();
  expect((await agent.inspect('run'))!.checkpoint.state.goals).toMatchObject({
    created: 3,
  });
});

test('replans bounded recovery without clearing failures after an unrelated success', async () => {
  const h = runnerFixture(0, 10);
  const execute = h.execute.getMockImplementation()!;
  let attempts = 0;
  h.execute.mockImplementation(async (...args) => ({
    ...(await execute(...args)),
    outcome: ++attempts <= 2 ? 'failed' : 'succeeded',
  }));
  const verify = h.verify.getMockImplementation()!;
  h.verify.mockImplementation(async (...args) => ({
    ...(await verify(...args)),
    progress: attempts,
    evidence: {
      source: 'application' as const,
      observationPaths: ['/count'],
      executionIds: [],
      details: {},
    },
  }));
  const agent = createAgent({
    ...h.options,
    limits: { maxRecoveryAttempts: 2, maxActionAttempts: 3 },
  });
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'action_budget_exhausted' },
  });
  expect(h.plan).toHaveBeenCalledTimes(2);
  expect(h.plan.mock.calls[1]![0].trigger).toMatchObject({
    kind: 'recoveryExhausted',
    failures: 2,
  });
  expect((await agent.inspect('run'))!.checkpoint.state.progress).toMatchObject(
    [{ noProgress: 0, recoveryAttempts: 2, recoveryPlanned: true }],
  );
});

test('bounds result context while retaining complete queryable action history', async () => {
  const h = runnerFixture(0, 51);
  const verify = h.verify.getMockImplementation()!;
  h.verify.mockImplementation(async (...args) => {
    const result = await verify(...args);
    const fact = args[0].context.observation.data.count;
    return {
      ...result,
      progress:
        fact?.status === 'known' && typeof fact.value === 'number'
          ? fact.value
          : 0,
      evidence: {
        source: 'application' as const,
        observationPaths: ['/count'],
        executionIds: [],
        details: {},
      },
    };
  });
  const agent = h.create();
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'succeeded',
  });
  expect(h.verify.mock.calls.at(-1)![0].actionResults).toHaveLength(50);
  expect(
    h.verify.mock.calls.at(-1)![0].context.runtime?.recentResults,
  ).toHaveLength(50);
  expect(
    (await agent.inspect('run'))!.checkpoint.state.recentResults,
  ).toHaveLength(50);
  const first = (await agent.records('run', null, 1000)).records.find(
    (record) => record.kind === 'actionResult',
  );
  expect(first).toBeDefined();
  expect(
    h.verify.mock.calls
      .at(-1)![0]
      .actionResults.some(
        (result) =>
          first?.kind === 'actionResult' &&
          result.executionId === first.data.executionId,
      ),
  ).toBe(false);
});

test('does not replace a temporarily missing progress measure with sibling completions', async () => {
  const h = runnerFixture(0, 10);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      nextTempId: 'step-1',
      guidance: 'Complete three stages',
      goals: [1, 2, 3].map((count) => ({
        tempId: `step-${count}`,
        parent: {
          kind: 'accepted',
          goalRef: request.context.graph.rootGoalRef,
        },
        description: `Stage ${count}`,
        criteria: { count },
      })),
    }),
  );
  const verify = h.verify.getMockImplementation()!;
  h.verify.mockImplementation(async (...args) => {
    const result = await verify(...args);
    const fact = args[0].context.observation.data.count;
    if (
      args[0].goal.kind !== 'root' ||
      fact?.status !== 'known' ||
      typeof fact.value !== 'number' ||
      fact.value > 1
    )
      return result;
    return {
      ...result,
      progress: fact.value,
      evidence: {
        source: 'application' as const,
        observationPaths: ['/count'],
        executionIds: [],
        details: {},
      },
    };
  });
  const agent = h.create();
  await expect((await agent.start(h.input)).result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'no_progress' },
  });
  expect(h.execute).toHaveBeenCalledTimes(4);
});
