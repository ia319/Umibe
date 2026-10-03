import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { defineAction } from '#internal/action/registry';
import type { Reconciliation } from '#internal/contracts/action';
import { createAgent } from './agent.js';
import { proposalBasis, runnerFixture } from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

test('preserves a deep goal path and cumulative usage while increasing the action budget', async () => {
  const h = runnerFixture(0, 3);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      guidance: 'Work in the inner branch',
      nextTempId: 'leaf',
      goals: [
        {
          tempId: 'area',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.rootGoalRef,
          },
          description: 'Area',
          criteria: { count: 3 },
        },
        {
          tempId: 'leaf',
          parent: { kind: 'proposed', tempId: 'area' },
          description: 'Leaf',
          criteria: { count: 2 },
        },
      ],
    }),
  );
  const agent = createAgent({
    ...h.options,
    limits: { maxActionAttempts: 1 },
    modelStages: ['planning', 'selection'],
  });
  const first = await agent.start(h.input);
  await expect(first.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'action_budget_exhausted' },
  });
  const previous = (await agent.inspect('run'))!.checkpoint.state;
  const path = h.select.mock.calls.at(-1)![0].context.graph.goalPath;
  expect(path).toHaveLength(3);
  await expect(
    agent.resume('run', { limits: { maxActionAttempts: 0 } }),
  ).rejects.toMatchObject({ reason: 'decreased_limit' });
  const second = await agent.resume('run', {
    limits: { maxActionAttempts: 3 },
    context: { operator: 'fixture' },
  });
  expect(second.result).not.toBe(first.result);
  await expect(second.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.select.mock.calls[2]![0].context.graph.goalPath).toEqual(path);
  expect(h.select.mock.calls[2]![0].context.applicationContext).toEqual({
    source: 'integration_fixture',
    operator: 'fixture',
  });
  const current = (await agent.inspect('run'))!.checkpoint.state;
  expect(current.actionAttempts).toBe(3);
  expect(current.modelAttempts).toBeGreaterThan(
    previous.modelAttempts as number,
  );
  expect(current.goals).toMatchObject({ created: 2 });
});

test('validates root changes before accepting them and invalidates old descendants', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 2);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      guidance: 'Collect',
      nextTempId: 'leaf',
      goals: [
        {
          tempId: 'leaf',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.rootGoalRef,
          },
          description: 'Leaf',
          criteria: { count: 1 },
        },
      ],
    }),
  );
  h.select.mockImplementationOnce(() => new Promise(() => undefined));
  const agent = h.create();
  const first = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  await agent.pause('run', 'edit_goal');
  await first.result;
  await expect(
    agent.resume('run', {
      goal: { ...h.input.goal, version: 2, criteria: { unsupported: true } },
      effectiveConstraints: {},
    }),
  ).rejects.toMatchObject({ reason: 'unsupported_criteria' });
  expect((await agent.inspect('run'))?.summary.rootGoalRef.version).toBe(1);
  const next = await agent.resume('run', {
    goal: { ...h.input.goal, version: 2, criteria: { count: 1 } },
    effectiveConstraints: { approved: true },
  });
  await vi.advanceTimersByTimeAsync(0);
  await expect(next.result).resolves.toMatchObject({
    status: 'succeeded',
    rootGoalRef: { id: 'root', version: 2 },
  });
  const request = h.select.mock.calls[1]![0];
  expect(request.context.graph.goalPath).toEqual([{ id: 'root', version: 2 }]);
  expect(request.context.effectiveConstraints).toEqual({ approved: true });
  expect(h.plan.mock.calls[1]![0].pendingGoals).toHaveLength(1);
  expect(h.execute).toHaveBeenCalledTimes(1);
});

test('requires confirmed reconciliation before resume and preserves spent attempts', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 1);
  h.execute.mockImplementationOnce(() => new Promise(() => undefined));
  const reconcile = vi
    .fn<() => Promise<Reconciliation>>()
    .mockResolvedValueOnce({ outcome: 'unknown', reason: 'still_running' })
    .mockResolvedValue({
      outcome: 'notPerformed',
      underlyingSettled: true,
      reason: 'stopped_and_not_performed',
    });
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect',
    tags: [],
    expectedEffects: {},
    parameters: z.strictObject({
      target: z.string(),
      count: z.number().default(1),
    }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: h.execute,
    reconcile,
  });
  const agent = createAgent({
    ...h.options,
    actions: [action],
    limits: { actionTimeoutMs: 10, stopGraceMs: 5 },
  });
  const first = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(15);
  await expect(first.result).resolves.toMatchObject({
    status: 'paused',
    execution: { phase: 'unknown' },
  });
  await expect(agent.resume('run')).rejects.toMatchObject({
    reason: 'execution_unsettled',
  });
  expect(h.execute).toHaveBeenCalledTimes(1);
  const next = await agent.resume('run');
  await vi.advanceTimersByTimeAsync(0);
  await expect(next.result).resolves.toMatchObject({ status: 'succeeded' });
  expect((await agent.inspect('run'))!.checkpoint.state.actionAttempts).toBe(2);
  expect((await first.result).execution?.phase).toBe('unknown');
});

test('cancels pending resume validation without applying the new root', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'blocked',
      reason: 'needs_operator',
    }),
  );
  const agent = h.create();
  await (
    await agent.start(h.input)
  ).result;
  h.support.mockImplementationOnce(() => new Promise(() => undefined));
  const restoring = agent.resume('run', {
    goal: { ...h.input.goal, version: 2 },
    effectiveConstraints: {},
  });
  const rejected = expect(restoring).rejects.toMatchObject({
    reason: 'support_cancelled',
  });
  await vi.advanceTimersByTimeAsync(0);
  await expect(agent.close()).rejects.toThrow();
  await expect(agent.resume('run')).rejects.toMatchObject({
    reason: 'resume_unavailable',
  });
  await agent.cancel('run', 'cancel_resume');
  await rejected;
  expect((await agent.inspect('run'))?.summary).toMatchObject({
    status: 'cancelled',
    rootGoalRef: { version: 1 },
  });
  expect(h.execute).not.toHaveBeenCalled();
});

test('finishes cancellation with unknown effects and allows explicit cleanup without resume', async () => {
  vi.useFakeTimers();
  const h = runnerFixture();
  h.execute.mockImplementation(() => new Promise(() => undefined));
  const action = defineAction({
    id: 'collect',
    version: 1,
    description: 'Collect',
    tags: [],
    expectedEffects: {},
    parameters: z.strictObject({
      target: z.string(),
      count: z.number().default(1),
    }),
    check: () => Promise.resolve({ outcome: 'allowed' }),
    execute: h.execute,
    reconcile: () =>
      Promise.resolve({
        outcome: 'notPerformed',
        underlyingSettled: true,
        reason: 'confirmed_stopped',
      }),
  });
  const agent = createAgent({
    ...h.options,
    actions: [action],
    limits: { actionTimeoutMs: 10, stopGraceMs: 5 },
  });
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(15);
  await run.result;
  await agent.cancel('run', 'cancel_unknown');
  expect((await agent.inspect('run'))?.summary.status).toBe('cancelled');
  await expect(agent.close()).rejects.toThrow();
  await expect(agent.reconcile('run')).resolves.toMatchObject({
    outcome: 'notPerformed',
  });
  await expect(agent.resume('run')).rejects.toMatchObject({
    reason: 'resume_unavailable',
  });
  await agent.close();
  expect(h.execute).toHaveBeenCalledTimes(1);
});
