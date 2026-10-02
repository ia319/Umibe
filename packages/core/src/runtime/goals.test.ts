import { afterEach, expect, test, vi } from 'vitest';
import type { PlannerRequest } from '#internal/contracts/adapters';
import type { PlanProposal } from '#internal/contracts/planning';
import { createAgent } from './agent.js';
import {
  applicationEvent,
  proposalBasis,
  runnerFixture,
} from './__tests__/runner-fixtures.js';

afterEach(() => vi.useRealTimers());

function branchPlan(request: PlannerRequest, parentCount = 2): PlanProposal {
  return {
    ...proposalBasis(request),
    outcome: 'decompose',
    guidance: 'Complete branch A, then B',
    nextTempId: 'a1',
    goalOrder: ['a1', 'a2', 'b'],
    goals: [
      {
        tempId: 'a',
        parent: {
          kind: 'accepted',
          goalRef: request.context.graph.rootGoalRef,
        },
        description: 'Branch A',
        criteria: { count: parentCount },
      },
      {
        tempId: 'a1',
        parent: { kind: 'proposed', tempId: 'a' },
        description: 'First sample',
        criteria: { count: 1 },
      },
      {
        tempId: 'a2',
        parent: { kind: 'proposed', tempId: 'a' },
        description: 'Second sample',
        criteria: { count: 2 },
      },
      {
        tempId: 'b',
        parent: {
          kind: 'accepted',
          goalRef: request.context.graph.rootGoalRef,
        },
        description: 'Branch B',
        criteria: { count: 3 },
      },
    ],
  };
}

test('advances nested siblings in accepted order and independently verifies each ancestor', async () => {
  const h = runnerFixture(0, 3);
  h.plan.mockImplementation((request) => Promise.resolve(branchPlan(request)));
  const agent = h.create();
  const run = await agent.start(h.input);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.plan).toHaveBeenCalledTimes(1);
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect(
    h.select.mock.calls.map(
      ([request]) =>
        request.context.graph.goals.find(
          (goal) => goal.id === request.context.graph.currentGoalRef.id,
        )?.description,
    ),
  ).toEqual(['First sample', 'Second sample', 'Branch B']);
  expect(
    h.verify.mock.calls.filter(([request]) => request.goal.kind === 'root'),
  ).toHaveLength(7);
  const record = await agent.inspect('run');
  expect(record?.checkpoint.state.goals).toMatchObject({
    created: 4,
    order: [],
    pending: [],
  });
});

test('closes unfinished descendants when their parent passes before them', async () => {
  const h = runnerFixture(0, 3);
  h.plan.mockImplementation((request) =>
    Promise.resolve(branchPlan(request, 1)),
  );
  const agent = h.create();
  await (
    await agent.start(h.input)
  ).result;
  expect(
    h.select.mock.calls.map(
      ([request]) =>
        request.context.graph.goals.find(
          (goal) => goal.id === request.context.graph.currentGoalRef.id,
        )?.description,
    ),
  ).toEqual(['First sample', 'Branch B', 'Branch B']);
  const last = h.verify.mock.calls.at(-1)![0];
  expect(
    last.context.graph.goals.find(
      (goal) => goal.description === 'Second sample',
    )?.lifecycle,
  ).toBe('cancelled');
});

test('rejects the whole proposed graph when one child has unsupported criteria', async () => {
  const h = runnerFixture(0, 3);
  h.plan.mockImplementation((request) => {
    const proposal = branchPlan(request);
    if (proposal.outcome !== 'decompose') throw new Error('fixture');
    return Promise.resolve({
      ...proposal,
      goals: proposal.goals.map((goal) =>
        goal.tempId === 'a2'
          ? { ...goal, criteria: { unsupported: true } }
          : goal,
      ),
    });
  });
  const agent = h.create();
  const run = await agent.start(h.input);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'unsupported_criteria' },
  });
  expect((await agent.inspect('run'))?.checkpoint.state.goals).toMatchObject({
    created: 0,
  });
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});

test.each([
  { depth: 2, status: 'succeeded' },
  { depth: 1, status: 'paused' },
])(
  'uses root depth zero with maximum depth $depth',
  async ({ depth, status }) => {
    const h = runnerFixture(0, 3);
    h.plan.mockImplementation((request) =>
      Promise.resolve(branchPlan(request)),
    );
    const agent = createAgent({
      ...h.options,
      limits: { maxGoalDepth: depth },
    });
    await expect((await agent.start(h.input)).result).resolves.toMatchObject({
      status,
    });
    if (status === 'paused') expect(h.execute).not.toHaveBeenCalled();
  },
);

test('revises an ancestor atomically, removes stale descendants, and reconfirms with fresh versions', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 3);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve(branchPlan(request)),
  );
  h.select.mockImplementationOnce(() => new Promise(() => undefined));
  const agent = h.create();
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const first = h.select.mock.calls[0]![0];
  const ancestor = first.context.graph.goals.find(
    (goal) => goal.description === 'Branch A',
  )!;
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'revise',
      revisions: [
        {
          goalRef: { id: ancestor.id, version: 1 },
          parentGoalRef: request.context.graph.rootGoalRef,
          description: 'Revised A',
          criteria: { count: 2 },
        },
      ],
      nextGoalRef: { id: ancestor.id, version: 1 },
      guidance: 'Reconfirm the children',
    }),
  );
  h.select.mockImplementationOnce(() => new Promise(() => undefined));
  await agent.emit(applicationEvent({ impact: 'plan' }));
  await vi.advanceTimersByTimeAsync(0);
  const second = h.select.mock.calls[1]![0];
  expect(second.context.graph.goalPath).toHaveLength(2);
  expect(second.context.graph.currentGoalRef).toEqual({
    id: ancestor.id,
    version: 2,
  });
  expect(
    second.context.graph.goals.some(
      (goal) => goal.description === 'First sample',
    ),
  ).toBe(false);
  h.plan.mockImplementationOnce((request) => {
    const children = request.pendingGoals!;
    expect(children).toHaveLength(2);
    return Promise.resolve({
      ...proposalBasis(request),
      outcome: 'reconfirm',
      revisions: children.map((goal) => ({
        goalRef: { id: goal.id, version: goal.version },
        parentGoalRef: { id: ancestor.id, version: 2 },
        description: goal.description,
        criteria: goal.criteria,
      })),
      nextGoalRef: { id: children[0]!.id, version: children[0]!.version },
      guidance: 'Continue branch A',
    });
  });
  await agent.emit(applicationEvent({ eventId: 'reconfirm', impact: 'plan' }));
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({ status: 'succeeded' });
  expect(h.execute).toHaveBeenCalledTimes(3);
  expect(
    h.select.mock.calls[2]![0].context.graph.goalPath.map((ref) => ref.version),
  ).toEqual([1, 2, 2]);
  expect((await agent.inspect('run'))?.checkpoint.state.goals).toMatchObject({
    created: 4,
    pending: [],
  });
});

test('never treats all child successes as root completion', async () => {
  const h = runnerFixture(0, 4);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve(branchPlan(request)),
  );
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'blocked',
      reason: 'root_still_incomplete',
    }),
  );
  const run = await h.create().start(h.input);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'root_still_incomplete' },
  });
  expect(h.execute).toHaveBeenCalledTimes(3);
});

test('counts newly created IDs even after ancestor revisions remove their descendants', async () => {
  vi.useFakeTimers();
  const h = runnerFixture(0, 3);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve(branchPlan(request)),
  );
  h.select.mockImplementation(() => new Promise(() => undefined));
  const agent = createAgent({ ...h.options, limits: { maxSubgoals: 4 } });
  const run = await agent.start(h.input);
  await vi.advanceTimersByTimeAsync(0);
  const ancestor = h.select.mock.calls[0]![0].context.graph.goals.find(
    (goal) => goal.description === 'Branch A',
  )!;
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'revise',
      revisions: [
        {
          goalRef: { id: ancestor.id, version: 1 },
          parentGoalRef: request.context.graph.rootGoalRef,
          description: 'Revised A',
          criteria: { count: 2 },
        },
      ],
      nextGoalRef: { id: ancestor.id, version: 1 },
      guidance: 'Fresh approach',
    }),
  );
  await agent.emit(applicationEvent({ impact: 'plan' }));
  await vi.advanceTimersByTimeAsync(0);
  h.plan.mockImplementationOnce((request) =>
    Promise.resolve({
      ...proposalBasis(request),
      outcome: 'decompose',
      goals: [
        {
          tempId: 'replacement',
          parent: {
            kind: 'accepted',
            goalRef: request.context.graph.currentGoalRef,
          },
          description: 'Replacement child',
          criteria: { count: 1 },
        },
      ],
      nextTempId: 'replacement',
      guidance: 'Try again',
    }),
  );
  await agent.emit(applicationEvent({ eventId: 'more', impact: 'plan' }));
  await vi.advanceTimersByTimeAsync(0);
  await expect(run.result).resolves.toMatchObject({
    status: 'paused',
    blocker: { reasonCode: 'cumulative_goal_limit' },
  });
  expect(h.execute).not.toHaveBeenCalled();
});

test('rejects passed assessments that cite missing facts', async () => {
  const h = runnerFixture(2);
  const verify = h.verify.getMockImplementation()!;
  h.verify.mockImplementation(async (...args) => ({
    ...(await verify(...args)),
    outcome: 'passed',
    reason: null,
    evidence: {
      source: 'application',
      observationPaths: ['/missing'],
      executionIds: [],
      details: {},
    },
  }));
  await expect((await h.create().start(h.input)).result).resolves.toMatchObject(
    { status: 'paused', blocker: { reasonCode: 'unbound_evidence' } },
  );
  expect(h.execute).not.toHaveBeenCalled();
});
