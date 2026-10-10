import { expect, test } from 'vitest';
import type { RuntimeLimits } from './limits.js';
import { captureLimits } from './limits.js';
import { createAgent } from './agent.js';
import { parseRuntimeCheckpoint } from './checkpoint.js';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

const uncapped = {
  maxModelAttempts: null,
  maxActionAttempts: null,
  maxGoalDepth: null,
  maxSubgoals: null,
  maxNoProgress: null,
  maxRecoveryAttempts: null,
} satisfies Partial<RuntimeLimits>;

test('accepts null only for count limits and retains finite defaults', () => {
  expect(captureLimits({})).toMatchObject({
    maxActionAttempts: 100,
    maxModelAttempts: 200,
  });
  expect(captureLimits(uncapped)).toMatchObject(uncapped);
  for (const value of [Infinity, NaN, -1, 1.5]) {
    expect(() => captureLimits({ maxActionAttempts: value })).toThrow();
  }
  // @ts-expect-error Null disables a count limit, never an execution timeout.
  expect(() => captureLimits({ actionTimeoutMs: null })).toThrow();
  // @ts-expect-error Retry policy remains a finite integer configuration.
  expect(() => captureLimits({ actionRetries: null })).toThrow();
  expect(() => captureLimits({ maxNoProgress: 0 })).toThrow();
});

test('passes the default action and model ceilings while retaining usage and checkpoints', async () => {
  const h = runnerFixture(0, 101);
  const agent = createAgent({
    ...h.options,
    limits: uncapped,
    modelStages: ['planning', 'selection', 'candidates'],
  });
  try {
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status: 'succeeded',
    });
    const saved = (await agent.inspect('run'))!.checkpoint;
    const checkpoint = parseRuntimeCheckpoint(
      JSON.parse(JSON.stringify(saved)),
    );
    expect(checkpoint.state.limits).toMatchObject(uncapped);
    expect(checkpoint.state.actionAttempts).toBe(101);
    expect(checkpoint.state.modelAttempts).toBeGreaterThan(200);
    expect(h.execute).toHaveBeenCalledTimes(101);
    expect(() =>
      parseRuntimeCheckpoint({
        ...checkpoint,
        state: {
          ...checkpoint.state,
          limits: { ...checkpoint.state.limits, maxActionAttempts: 100 },
        },
      }),
    ).toThrowError(expect.objectContaining({ reason: 'usage_exceeds_limit' }));
  } finally {
    await agent.close();
    await h.store.close();
  }
}, 30_000);

test('admits a goal path beyond the default depth and cumulative child count', async () => {
  const h = runnerFixture(0, 1);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      guidance: 'Reach the verified result',
      nextTempId: 'step-9',
      goals: Array.from({ length: 101 }, (_, index) => ({
        tempId: `step-${index}`,
        parent:
          index === 0 || index >= 10
            ? {
                kind: 'accepted' as const,
                goalRef: request.context.graph.rootGoalRef,
              }
            : { kind: 'proposed' as const, tempId: `step-${index - 1}` },
        description: `Stage ${index}`,
        criteria: { count: 1 },
      })),
    }),
  );
  const agent = createAgent({ ...h.options, limits: uncapped });
  try {
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(h.select.mock.calls[0]![0].context.graph.goalPath).toHaveLength(11);
    const checkpoint = parseRuntimeCheckpoint(
      (await agent.inspect('run'))!.checkpoint,
    );
    expect(checkpoint.state.goals.created).toBe(101);
    expect(() =>
      parseRuntimeCheckpoint({
        ...checkpoint,
        state: {
          ...checkpoint.state,
          limits: { ...checkpoint.state.limits, maxSubgoals: 100 },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ reason: 'invalid_subgoal_count' }),
    );
  } finally {
    await agent.close();
    await h.store.close();
  }
}, 30_000);

test('can disable recovery and no-progress thresholds without clearing their counters', async () => {
  const h = runnerFixture(0, 5);
  const execute = h.execute.getMockImplementation()!;
  let attempts = 0;
  h.execute.mockImplementation(async (...args) => ({
    ...(await execute(...args)),
    outcome: ++attempts < 5 ? 'failed' : 'succeeded',
  }));
  const agent = createAgent({ ...h.options, limits: uncapped });
  try {
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(h.plan).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(5);
  } finally {
    await agent.close();
    await h.store.close();
  }
});

test('restores an uncapped run and rejects tightening it back to finite limits', async () => {
  const h = runnerFixture(0, 4);
  const firstAgent = createAgent({
    ...h.options,
    applicationId: 'uncapped-test',
    limits: { maxActionAttempts: 1 },
  });
  await expect((await firstAgent.start(h.input)).result).resolves.toMatchObject(
    {
      status: 'paused',
      blocker: { reasonCode: 'action_budget_exhausted' },
    },
  );
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'blocked',
      reason: 'operator_review',
    }),
  );
  await expect(
    (
      await firstAgent.resume('run', {
        limits: uncapped,
        context: { review: true },
      })
    ).result,
  ).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'operator_review' },
  });
  await firstAgent.close();
  const restoredAgent = createAgent({
    ...h.options,
    applicationId: 'uncapped-test',
  });
  try {
    for (const key of Object.keys(uncapped)) {
      await expect(
        restoredAgent.resume('run', { limits: { [key]: 1000 } }),
      ).rejects.toMatchObject({ reason: 'decreased_limit' });
    }
    await expect(
      (await restoredAgent.resume('run')).result,
    ).resolves.toMatchObject({ status: 'succeeded' });
    const checkpoint = parseRuntimeCheckpoint(
      (await restoredAgent.inspect('run'))!.checkpoint,
    );
    expect(checkpoint.state.limits).toMatchObject(uncapped);
    expect(checkpoint.state.actionAttempts).toBe(4);
  } finally {
    await restoredAgent.close();
    await h.store.close();
  }
});
