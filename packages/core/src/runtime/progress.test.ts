import { expect, test } from 'vitest';
import { createAgent } from './agent.js';
import type { GoalAssessment } from '#internal/contracts/goal';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

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
